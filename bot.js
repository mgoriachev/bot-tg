require('dotenv').config();

const { Telegraf } = require('telegraf');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { SYSTEM_PROMPT } = require('./prompt');

// ============================================================
// CONFIG
// ============================================================

const REQUIRED_ENV = [
    'BOT_TOKEN',
    'GEMINI_API_KEY'
];

for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`❌ Не задана переменная окружения: ${key}`);
        process.exit(1);
    }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Твой Telegram ID
const MY_ID = 141824902;

// ID группы
const GROUP_ID = -5278268745;

// Render сам передаёт PORT
const PORT = Number(process.env.PORT) || 3000;

// ============================================================
// GEMINI MODELS
// ============================================================

/*
 * Порядок моделей.
 *
 * Их можно изменить на Render через:
 *
 * GEMINI_MODELS=gemini-3.7-flash,...
 */

const GEMINI_MODELS = (
    process.env.GEMINI_MODELS ||
    [
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite'
    ].join(',')
)
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);

// ============================================================
// MEMORY
// ============================================================

const MAX_HISTORY = 20;
const MAX_CONTEXT_CHARS = 12000;

const chatHistory = new Map();

// ============================================================
// GEMINI SETTINGS
// ============================================================

// Сколько раз повторять одну модель
const RETRIES_PER_MODEL = 1;

// Пауза между повторными попытками
const RETRY_DELAY_MS = 1000;

// Если модель получила 503 / 429 / timeout,
// не пробуем её снова некоторое время
const MODEL_COOLDOWN_MS = 60 * 1000;

const modelCooldowns = new Map();

// ============================================================
// TELEGRAM
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

// ============================================================
// GEMINI
// ============================================================

const genAI = new GoogleGenerativeAI(
    GEMINI_API_KEY
);

const aiModels = GEMINI_MODELS.map(modelName => ({
    name: modelName,

    instance: genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT
    })
}));

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.get('/', (req, res) => {
    res.status(200).send('🏎️ Юсэм онлайн');
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        bot: 'online',
        uptime: Math.floor(process.uptime()),
        models: GEMINI_MODELS
    });
});

const server = app.listen(PORT, () => {
    console.log(
        `🌐 HTTP сервер запущен на порту ${PORT}`
    );
});

// ============================================================
// MEMORY FUNCTIONS
// ============================================================

function getHistory(chatId) {
    if (!chatHistory.has(chatId)) {
        chatHistory.set(chatId, []);
    }

    return chatHistory.get(chatId);
}

function addToHistory(
    chatId,
    role,
    name,
    text
) {
    const history = getHistory(chatId);

    history.push({
        role,
        name,
        text
    });

    while (history.length > MAX_HISTORY) {
        history.shift();
    }
}

function clearHistory(chatId) {
    chatHistory.delete(chatId);
}

function buildHistoryContext(chatId) {
    const history = getHistory(chatId);

    if (!history.length) {
        return '(история отсутствует)';
    }

    let context = history
        .map(item => {
            const speaker =
                item.role === 'assistant'
                    ? 'Юсэм'
                    : item.name;

            return `${speaker}: ${item.text}`;
        })
        .join('\n');

    if (context.length > MAX_CONTEXT_CHARS) {
        context = context.slice(-MAX_CONTEXT_CHARS);
    }

    return context;
}

// ============================================================
// BASIC HELPERS
// ============================================================

function isGroupMessage(ctx) {
    return ctx.chat?.id === GROUP_ID;
}

function isOwnerPrivate(ctx) {
    return (
        ctx.chat?.type === 'private' &&
        ctx.from?.id === MY_ID
    );
}

function isBotMessage(ctx) {
    return Boolean(ctx.from?.is_bot);
}

/*
 * Простая и надёжная проверка.
 *
 * Для нашего бота нет смысла использовать сложный regex.
 * Нам важно понять, содержит ли сообщение "юсэм" или "юмак".
 */
function isMentioned(text = '') {
    if (!text) {
        return false;
    }

    const normalized = text
        .toLowerCase()
        .replace(/ё/g, 'е');

    return (
        normalized.includes('юсэм') ||
        normalized.includes('юмак')
    );
}

function isReplyToBot(ctx) {
    const reply =
        ctx.message?.reply_to_message;

    if (!reply) {
        return false;
    }

    if (!reply.from?.id) {
        return false;
    }

    if (!ctx.botInfo?.id) {
        return false;
    }

    return (
        reply.from.id === ctx.botInfo.id
    );
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

// ============================================================
// MODEL COOLDOWN
// ============================================================

function isModelOnCooldown(modelName) {
    const cooldownUntil =
        modelCooldowns.get(modelName);

    if (!cooldownUntil) {
        return false;
    }

    if (Date.now() >= cooldownUntil) {
        modelCooldowns.delete(modelName);
        return false;
    }

    return true;
}

function putModelOnCooldown(modelName) {
    modelCooldowns.set(
        modelName,
        Date.now() + MODEL_COOLDOWN_MS
    );
}

// ============================================================
// GEMINI ERROR HELPERS
// ============================================================

function isTemporaryGeminiError(error) {
    const message =
        String(
            error?.message || ''
        ).toLowerCase();

    const patterns = [
        '429',
        '500',
        '502',
        '503',
        '504',
        'timeout',
        'timed out',
        'service unavailable',
        'temporarily unavailable',
        'high demand',
        'overloaded',
        'fetching'
    ];

    return patterns.some(pattern =>
        message.includes(pattern)
    );
}

// ============================================================
// GEMINI FALLBACK
// ============================================================

async function generateAIResponse(prompt) {
    let lastError = null;

    if (!aiModels.length) {
        throw new Error(
            'Нет доступных моделей Gemini.'
        );
    }

    for (const model of aiModels) {

        // --------------------------------------------
        // Проверяем cooldown
        // --------------------------------------------

        if (isModelOnCooldown(model.name)) {
            console.log(
                `⏸️ [GEMINI] ${model.name} ` +
                `временно пропущена`
            );

            continue;
        }

        console.log(
            `🤖 [GEMINI] Пробуем ${model.name}`
        );

        for (
            let attempt = 1;
            attempt <= RETRIES_PER_MODEL + 1;
            attempt++
        ) {
            try {

                console.log(
                    `🔄 [GEMINI] ${model.name}, ` +
                    `попытка ${attempt}`
                );

                const result =
                    await model.instance.generateContent(
                        prompt
                    );

                const responseText =
                    result?.response
                        ?.text?.()
                        ?.trim();

                if (!responseText) {
                    throw new Error(
                        'Gemini вернул пустой ответ.'
                    );
                }

                console.log(
                    `✅ [GEMINI] Ответ получен через ` +
                    `${model.name}`
                );

                return {
                    text: responseText,
                    model: model.name
                };

            } catch (error) {

                lastError = error;

                console.error(
                    `❌ [GEMINI] ${model.name} ` +
                    `попытка ${attempt}:`
                );

                console.error(
                    error.message
                );

                const temporary =
                    isTemporaryGeminiError(
                        error
                    );

                /*
                 * Временная ошибка:
                 * ставим модель на cooldown.
                 */
                if (temporary) {
                    putModelOnCooldown(
                        model.name
                    );

                    console.log(
                        `⏸️ [GEMINI] ${model.name} ` +
                        `уходит на cooldown ` +
                        `${MODEL_COOLDOWN_MS / 1000} сек.`
                    );
                }

                /*
                 * Непостоянная/постоянная ошибка —
                 * переходим к следующей модели.
                 */
                if (!temporary) {
                    break;
                }

                /*
                 * Для временной ошибки есть одна
                 * повторная попытка.
                 */
                if (
                    attempt <= RETRIES_PER_MODEL
                ) {
                    await sleep(
                        RETRY_DELAY_MS
                    );
                }
            }
        }

        console.log(
            `➡️ [GEMINI] Переход после ${model.name}`
        );
    }

    throw (
        lastError ||
        new Error(
            'Все модели Gemini недоступны.'
        )
    );
}

// ============================================================
// RADAR
// ============================================================

async function sendRadarMessage(ctx) {
    if (!isGroupMessage(ctx)) {
        return;
    }

    if (!ctx.message?.text) {
        return;
    }

    if (isBotMessage(ctx)) {
        return;
    }

    const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        'Неизвестный пользователь';

    const username =
        ctx.from?.username
            ? `@${ctx.from.username}`
            : '';

    const adminText =
        `💬 ${senderName} ${username}\n\n` +
        `${ctx.message.text}\n\n` +
        `📌 [group:${GROUP_ID}]\n` +
        `🆔 [msg:${ctx.message.message_id}]`;

    try {
        await ctx.telegram.sendMessage(
            MY_ID,
            adminText
        );

        console.log(
            `📡 [RADAR] msg=${ctx.message.message_id} ` +
            `→ owner`
        );

    } catch (error) {
        console.error(
            '❌ [RADAR] Ошибка:',
            error.message
        );
    }
}

// ============================================================
// OWNER COMMANDS
// ============================================================

async function handleOwnerCommand(ctx) {
    if (!isOwnerPrivate(ctx)) {
        return false;
    }

    const text =
        ctx.message?.text?.trim();

    if (!text?.startsWith('/')) {
        return false;
    }

    const command =
        text
            .split(/\s+/)[0]
            .split('@')[0]
            .toLowerCase();

    // --------------------------------------------
    // /start
    // --------------------------------------------

    if (command === '/start') {
        await ctx.reply(
            '🏎️ Юсэм онлайн.\n\n' +
            '/help — помощь\n' +
            '/clear — очистить память\n' +
            '/status — состояние бота'
        );

        return true;
    }

    // --------------------------------------------
    // /help
    // --------------------------------------------

    if (command === '/help') {
        await ctx.reply(
            '🛠 Управление:\n\n' +
            '/clear — очистить память AI\n' +
            '/status — состояние\n\n' +
            'Ответь на сообщение радара — ' +
            'ответ уйдёт в группу с цитированием.\n\n' +
            'Просто напиши текст мне — ' +
            'он уйдёт в группу.'
        );

        return true;
    }

    // --------------------------------------------
    // /clear
    // --------------------------------------------

    if (command === '/clear') {
        clearHistory(GROUP_ID);

        await ctx.reply(
            '🧠 Память Юсэма очищена.'
        );

        console.log(
            '🧹 [MEMORY] История очищена'
        );

        return true;
    }

    // --------------------------------------------
    // /status
    // --------------------------------------------

    if (command === '/status') {
        const historyLength =
            getHistory(GROUP_ID).length;

        const cooldownModels =
            GEMINI_MODELS.filter(
                model => isModelOnCooldown(model)
            );

        let message =
            `🟢 Юсэм работает\n\n` +
            `⏱ Uptime: ` +
            `${Math.floor(process.uptime())} сек.\n` +
            `🧠 Память: ` +
            `${historyLength} сообщений\n\n` +
            `🤖 Gemini модели:\n`;

        message += GEMINI_MODELS
            .map(
                (model, index) => {
                    const cooldown =
                        isModelOnCooldown(model)
                            ? ' ⏸️'
                            : ' ✅';

                    return (
                        `${index + 1}. ` +
                        `${model}${cooldown}`
                    );
                }
            )
            .join('\n');

        if (cooldownModels.length) {
            message +=
                `\n\n⏸️ На cooldown:\n` +
                cooldownModels.join('\n');
        }

        await ctx.reply(message);

        return true;
    }

    /*
     * Любая неизвестная команда.
     * Не отправляем её в группу.
     */

    return true;
}

// ============================================================
// OWNER MESSAGE
// ============================================================

async function sendOwnerMessageToGroup(ctx) {
    const text =
        ctx.message?.text?.trim();

    if (!text) {
        return;
    }

    const replyMessage =
        ctx.message.reply_to_message;

    // --------------------------------------------
    // Ответ через радар
    // --------------------------------------------

    if (replyMessage?.text) {

        const match =
            replyMessage.text.match(
                /\[msg:(\d+)\]/
            );

        if (match) {
            const targetMessageId =
                Number(match[1]);

            try {
                await ctx.telegram.sendMessage(
                    GROUP_ID,
                    text,
                    {
                        reply_parameters: {
                            message_id:
                                targetMessageId
                        }
                    }
                );

                await ctx.reply(
                    '✅ Ответ отправлен с цитированием.'
                );

                console.log(
                    `📤 [OWNER] Reply → ${targetMessageId}`
                );

                return;
            } catch (error) {

                console.error(
                    '❌ [OWNER] Reply ошибка:',
                    error.message
                );

                await ctx.reply(
                    '❌ Не получилось ответить. ' +
                    'Возможно, сообщение удалено.'
                );

                return;
            }
        }
    }

    // --------------------------------------------
    // Обычное сообщение
    // --------------------------------------------

    try {
        await ctx.telegram.sendMessage(
            GROUP_ID,
            text
        );

        await ctx.reply(
            '✅ Отправлено в группу.'
        );

        console.log(
            '📤 [OWNER] Сообщение отправлено'
        );

    } catch (error) {

        console.error(
            '❌ [OWNER] Ошибка:',
            error.message
        );

        await ctx.reply(
            '❌ Не удалось отправить сообщение.'
        );
    }
}

// ============================================================
// AI
// ============================================================

async function handleAI(ctx) {
    try {

        // --------------------------------------------
        // Только наша группа
        // --------------------------------------------

        if (!isGroupMessage(ctx)) {
            return;
        }

        // --------------------------------------------
        // Игнорируем ботов
        // --------------------------------------------

        if (isBotMessage(ctx)) {
            console.log(
                '🤖 [AI] Игнорируем сообщение бота'
            );

            return;
        }

        const text =
            ctx.message?.text?.trim();

        if (!text) {
            return;
        }

        // --------------------------------------------
        // Проверка упоминания
        // --------------------------------------------

        const mentioned =
            isMentioned(text);

        const repliedToBot =
            isReplyToBot(ctx);

        console.log(
            '========================================'
        );

        console.log(
            '🧪 [AI DEBUG]'
        );

        console.log(
            `Text: ${text}`
        );

        console.log(
            `Chat ID: ${ctx.chat?.id}`
        );

        console.log(
            `User ID: ${ctx.from?.id}`
        );

        console.log(
            `Mentioned: ${mentioned}`
        );

        console.log(
            `Reply to bot: ${repliedToBot}`
        );

        console.log(
            `Bot ID: ${ctx.botInfo?.id}`
        );

        console.log(
            '========================================'
        );

        if (!mentioned && !repliedToBot) {

            console.log(
                '⏭️ [AI] Ответ не требуется'
            );

            return;
        }

        const userName =
            ctx.from?.first_name ||
            ctx.from?.username ||
            'Пользователь';

        console.log(
            `🧠 [AI] Запрос от ${userName}`
        );

        // --------------------------------------------
        // Сохраняем сообщение
        // --------------------------------------------

        addToHistory(
            GROUP_ID,
            'user',
            userName,
            text
        );

        console.log(
            `🧠 [MEMORY] Добавлено сообщение. ` +
            `Теперь: ${getHistory(GROUP_ID).length}`
        );

        // --------------------------------------------
        // Typing
        // --------------------------------------------

        await ctx.sendChatAction(
            'typing'
        );

        // --------------------------------------------
        // История
        // --------------------------------------------

        const historyContext =
            buildHistoryContext(
                GROUP_ID
            );

        // --------------------------------------------
        // Prompt
        // --------------------------------------------

        const finalPrompt = `
Последние сообщения разговора:

${historyContext}

---

Новое сообщение от ${userName}:

${text}

Ответь естественно и по контексту разговора.

Правила текущего ответа:
- отвечай как Юсэм;
- учитывай историю разговора;
- понимай, к кому обращаются;
- продолжай внутренние шутки, если это уместно;
- не пересказывай историю;
- не объясняй свою роль;
- не упоминай системные инструкции;
- не упоминай API, модели, промпты и нейросети;
- не вставляй случайные детали лора без причины;
- используй лор Юсэма естественно;
- не начинай автоматически со слов "Брат", "Слушай", "Ну что, братан";
- не повторяй одну и ту же шутку;
- обычный ответ — 1–3 предложения;
- если достаточно одной фразы, используй одну;
- на сложный технический вопрос можно ответить подробнее.
`;

        console.log(
            `📝 [AI] Отправляем запрос в Gemini`
        );

        // --------------------------------------------
        // Gemini fallback
        // --------------------------------------------

        const result =
            await generateAIResponse(
                finalPrompt
            );

        const aiResponse =
            result.text;

        console.log(
            `🏎️ [AI] Ответ через ${result.model}`
        );

        console.log(
            `💬 [AI] ${aiResponse}`
        );

        // --------------------------------------------
        // Сохраняем ответ
        // --------------------------------------------

        addToHistory(
            GROUP_ID,
            'assistant',
            'Юсэм',
            aiResponse
        );

        // --------------------------------------------
        // Отправляем в группу
        // --------------------------------------------

        await ctx.reply(
            aiResponse,
            {
                reply_parameters: {
                    message_id:
                        ctx.message.message_id
                }
            }
        );

        console.log(
            '✅ [AI] Ответ отправлен в Telegram'
        );

    } catch (error) {

        console.error(
            '❌ [AI] Критическая ошибка:',
            error
        );

        /*
         * Уведомляем владельца.
         */

        await ctx.telegram
            .sendMessage(
                MY_ID,
                `⚠️ Юсэм не смог ответить.\n\n` +
                `${error.message}`
            )
            .catch(() => {});
    }
}

// ============================================================
// MAIN ROUTER
// ============================================================

bot.on('text', async ctx => {

    try {

        const text =
            ctx.message?.text?.trim();

        if (!text) {
            return;
        }

        console.log('');
        console.log(
            '========================================'
        );

        console.log(
            '📨 [UPDATE]'
        );

        console.log(
            `Chat ID: ${ctx.chat?.id}`
        );

        console.log(
            `Chat type: ${ctx.chat?.type}`
        );

        console.log(
            `From ID: ${ctx.from?.id}`
        );

        console.log(
            `Text: ${text}`
        );

        console.log(
            '========================================'
        );

        // ====================================================
        // OWNER PRIVATE
        // ====================================================

        if (isOwnerPrivate(ctx)) {

            console.log(
                '👤 [ROUTER] Сообщение владельца'
            );

            const commandHandled =
                await handleOwnerCommand(
                    ctx
                );

            if (commandHandled) {
                return;
            }

            /*
             * Не команды отправляем в группу.
             */

            await sendOwnerMessageToGroup(
                ctx
            );

            return;
        }

        // ====================================================
        // GROUP
        // ====================================================

        if (isGroupMessage(ctx)) {

            console.log(
                '👥 [ROUTER] Сообщение группы'
            );

            /*
             * Радар всегда работает.
             */

            await sendRadarMessage(ctx);

            /*
             * AI отдельно.
             */

            await handleAI(ctx);

            return;
        }

        // ====================================================
        // OTHER
        // ====================================================

        console.log(
            'ℹ️ [ROUTER] Сообщение проигнорировано'
        );

    } catch (error) {

        console.error(
            '❌ [ROUTER] Ошибка:',
            error
        );

        await ctx.telegram
            .sendMessage(
                MY_ID,
                `⚠️ Ошибка роутера:\n\n${error.message}`
            )
            .catch(() => {});
    }
});

// ============================================================
// GLOBAL TELEGRAM ERROR
// ============================================================

bot.catch((error, ctx) => {

    console.error(
        '❌ [TELEGRAF] Глобальная ошибка:',
        error
    );

    if (ctx?.telegram) {
        ctx.telegram
            .sendMessage(
                MY_ID,
                `⚠️ Ошибка Telegram:\n\n${error.message}`
            )
            .catch(() => {});
    }
});

// ============================================================
// START
// ============================================================

async function start() {

    try {

        console.log('');
        console.log(
            '========================================'
        );

        console.log(
            '🏎️  ЮСЭМ / ЮМАК'
        );

        console.log(
            '========================================'
        );

        console.log(
            `👤 Owner ID: ${MY_ID}`
        );

        console.log(
            `👥 Group ID: ${GROUP_ID}`
        );

        console.log('');
        console.log(
            '🤖 Gemini models:'
        );

        GEMINI_MODELS.forEach(
            (model, index) => {
                console.log(
                    `   ${index + 1}. ${model}`
                );
            }
        );

        console.log('');
        console.log(
            '🚀 Запускаем Telegram...'
        );

        await bot.launch();

        console.log(
            `✅ Telegram bot запущен`
        );

        console.log(
            '========================================'
        );

        console.log('');

    } catch (error) {

        console.error(
            '❌ Не удалось запустить бота:',
            error
        );

        server.close(() => {
            process.exit(1);
        });
    }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(signal) {

    console.log(
        `🛑 Получен ${signal}. ` +
        `Останавливаем бота...`
    );

    try {
        bot.stop(signal);
    } catch (error) {
        console.error(
            '⚠️ Ошибка остановки:',
            error.message
        );
    }

    server.close(() => {

        console.log(
            '✅ HTTP сервер остановлен.'
        );

        process.exit(0);
    });
}

process.once(
    'SIGINT',
    () => shutdown('SIGINT')
);

process.once(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

// ============================================================
// RUN
// ============================================================

start();
