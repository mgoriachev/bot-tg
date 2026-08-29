
require('dotenv').config();

const { Telegraf } = require('telegraf');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { SYSTEM_PROMPT } = require('./prompt');

// ============================================================
// CONFIG
// ============================================================

const requiredEnv = [
    'BOT_TOKEN',
    'GEMINI_API_KEY'
];

for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`❌ Не задана переменная окружения: ${key}`);
        process.exit(1);
    }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MY_ID = 141824902;
const GROUP_ID = -5278268745;

const PORT = Number(process.env.PORT) || 3000;

/*
 * Порядок fallback-моделей.
 *
 * Можно переопределить через Render Environment Variables:
 *
 * GEMINI_MODELS=gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite
 */
const GEMINI_MODELS = (
    process.env.GEMINI_MODELS ||
    [
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite'
    ].join(',')
)
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);

// Сколько сообщений хранить в памяти.
const MAX_HISTORY = 20;

// Максимальный размер истории в символах.
const MAX_CONTEXT_CHARS = 12000;

// Сколько раз попробовать одну модель,
// если ошибка временная.
const RETRIES_PER_MODEL = 1;

// Пауза между повторными попытками.
const RETRY_DELAY_MS = 1200;

// ============================================================
// TELEGRAM
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

// ============================================================
// GEMINI
// ============================================================

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/*
 * Создаём отдельный объект модели для каждой модели из fallback-цепочки.
 */

const aiModels = GEMINI_MODELS.map(modelName => ({
    name: modelName,
    instance: genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT
    })
}));

// ============================================================
// EXPRESS / RENDER
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
    console.log(`🌐 HTTP сервер запущен на порту ${PORT}`);
});

// ============================================================
// MEMORY
// ============================================================

/*
    chatHistory:

    GROUP_ID -> [
        {
            role: 'user',
            name: 'Андрей',
            text: 'Юсэм, как тебе Evo?'
        },
        {
            role: 'assistant',
            name: 'Юсэм',
            text: 'Evo — это зло в хорошем смысле 😎'
        }
    ]
*/

const chatHistory = new Map();

function getHistory(chatId) {
    if (!chatHistory.has(chatId)) {
        chatHistory.set(chatId, []);
    }

    return chatHistory.get(chatId);
}

function addToHistory(chatId, role, name, text) {
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
        context =
            context.slice(-MAX_CONTEXT_CHARS);
    }

    return context;
}

// ============================================================
// HELPERS
// ============================================================

function isOwnerPrivate(ctx) {
    return (
        ctx.chat?.type === 'private' &&
        ctx.from?.id === MY_ID
    );
}

function isGroupMessage(ctx) {
    return ctx.chat?.id === GROUP_ID;
}

function isBotMessage(ctx) {
    return Boolean(ctx.from?.is_bot);
}

function isMentioned(text = '') {
    return /\b(юсэм|юмак)\b/iu.test(text);
}

function isReplyToBot(ctx) {
    const reply =
        ctx.message?.reply_to_message;

    return Boolean(
        reply?.from?.id &&
        ctx.botInfo?.id &&
        reply.from.id === ctx.botInfo.id
    );
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

/*
 * Определяем, стоит ли переключаться на следующую модель.
 *
 * Временные ошибки:
 * 429 — rate limit
 * 500 — server error
 * 502 — bad gateway
 * 503 — service unavailable
 * 504 — gateway timeout
 * timeout / fetch failure — временный сетевой сбой
 *
 * Для 401/403 fallback обычно не поможет,
 * потому что проблема в API key / permissions.
 */
function isRetryableGeminiError(error) {
    const message =
        String(error?.message || '').toLowerCase();

    const retryableCodes = [
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

    return retryableCodes.some(code =>
        message.includes(code)
    );
}

// ============================================================
// GEMINI FALLBACK
// ============================================================

async function generateAIResponse(prompt) {
    let lastError = null;

    for (const model of aiModels) {
        console.log(
            `🤖 Пробуем Gemini: ${model.name}`
        );

        for (
            let attempt = 1;
            attempt <= RETRIES_PER_MODEL + 1;
            attempt++
        ) {
            try {
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
                        'Модель вернула пустой ответ.'
                    );
                }

                console.log(
                    `✅ Ответ получен через ${model.name}`
                );

                return {
                    text: responseText,
                    model: model.name
                };

            } catch (error) {
                lastError = error;

                console.error(
                    `⚠️ Ошибка ${model.name} ` +
                    `(попытка ${attempt}):`,
                    error.message
                );

                /*
                 * Если ошибка НЕ временная,
                 * нет смысла повторять ту же модель.
                 */
                if (!isRetryableGeminiError(error)) {
                    console.error(
                        `➡️ Ошибка не считается временной. ` +
                        `Переходим к следующей модели.`
                    );

                    break;
                }

                /*
                 * Если это временная ошибка,
                 * даём модели ещё один шанс.
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

        /*
         * Эта модель не справилась.
         * Переходим к следующей.
         */
        console.log(
            `🔄 Переключаемся после ${model.name}`
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
// 1. РАДАР ГРУППЫ
// ============================================================

bot.use(async (ctx, next) => {
    try {
        if (
            isGroupMessage(ctx) &&
            ctx.message?.text &&
            !isBotMessage(ctx)
        ) {
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

            await ctx.telegram
                .sendMessage(
                    MY_ID,
                    adminText
                )
                .catch(error => {
                    console.error(
                        '⚠️ Ошибка отправки радара:',
                        error.message
                    );
                });
        }
    } catch (error) {
        console.error(
            '❌ Ошибка радара:',
            error
        );
    }

    return next();
});

// ============================================================
// 2. /START
// ============================================================

bot.command('start', async ctx => {
    if (!isOwnerPrivate(ctx)) {
        return;
    }

    await ctx.reply(
        '🏎️ Юсэм онлайн.\n\n' +
        '/help — помощь\n' +
        '/clear — очистить память\n' +
        '/status — состояние бота'
    );
});

// ============================================================
// 3. /HELP
// ============================================================

bot.command('help', async ctx => {
    if (!isOwnerPrivate(ctx)) {
        return;
    }

    await ctx.reply(
        '🛠 Управление Юсэмом:\n\n' +
        '/clear — очистить память AI\n' +
        '/status — состояние бота\n\n' +
        'Ответь на сообщение радара — ' +
        'ответ уйдёт в группу с цитированием.\n\n' +
        'Просто напиши мне сообщение — ' +
        'оно уйдёт в группу.'
    );
});

// ============================================================
// 4. /CLEAR
// ============================================================

bot.command('clear', async ctx => {
    if (!isOwnerPrivate(ctx)) {
        return;
    }

    clearHistory(GROUP_ID);

    await ctx.reply(
        '🧠 Память Юсэма очищена.'
    );
});

// ============================================================
// 5. /STATUS
// ============================================================

bot.command('status', async ctx => {
    if (!isOwnerPrivate(ctx)) {
        return;
    }

    const historyLength =
        getHistory(GROUP_ID).length;

    await ctx.reply(
        `🟢 Юсэм работает\n` +
        `⏱ Uptime: ${Math.floor(process.uptime())} сек.\n` +
        `🧠 Память: ${historyLength} сообщений\n\n` +
        `🤖 Fallback модели:\n` +
        GEMINI_MODELS
            .map(
                (model, index) =>
                    `${index + 1}. ${model}`
            )
            .join('\n')
    );
});

// ============================================================
// 6. РУЧНОЕ УПРАВЛЕНИЕ ИЗ ЛИЧКИ
// ============================================================

bot.on('text', async (ctx, next) => {
    if (!isOwnerPrivate(ctx)) {
        return next();
    }

    const text =
        ctx.message.text?.trim();

    if (!text) {
        return next();
    }

    // --------------------------------------------------------
    // Ответ на сообщение из радара
    // --------------------------------------------------------

    if (
        ctx.message.reply_to_message?.text
    ) {
        const radarText =
            ctx.message.reply_to_message.text;

        const match =
            radarText.match(
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

                return;
            } catch (error) {
                console.error(
                    '❌ Ошибка reply:',
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

    // --------------------------------------------------------
    // Обычное сообщение в группу
    // --------------------------------------------------------

    try {
        await ctx.telegram.sendMessage(
            GROUP_ID,
            text
        );

        await ctx.reply(
            '✅ Отправлено в группу.'
        );

        return;

    } catch (error) {
        console.error(
            '❌ Ошибка отправки:',
            error.message
        );

        await ctx.reply(
            '❌ Не удалось отправить сообщение.'
        );
    }
});

// ============================================================
// 7. AI ЮСЭМ
// ============================================================

bot.on('text', async ctx => {
    try {
        // Только наша группа
        if (!isGroupMessage(ctx)) {
            return;
        }

        // Игнорируем сообщения от ботов
        if (isBotMessage(ctx)) {
            return;
        }

        const text =
            ctx.message.text?.trim();

        if (!text) {
            return;
        }

        // ----------------------------------------------------
        // Определяем, нужно ли отвечать
        // ----------------------------------------------------

        const mentioned =
            isMentioned(text);

        const repliedToBot =
            isReplyToBot(ctx);

        if (!mentioned && !repliedToBot) {
            return;
        }

        const userName =
            ctx.from?.first_name ||
            ctx.from?.username ||
            'Пользователь';

        // ----------------------------------------------------
        // Добавляем сообщение пользователя
        // ----------------------------------------------------

        addToHistory(
            GROUP_ID,
            'user',
            userName,
            text
        );

        // ----------------------------------------------------
        // Показываем typing
        // ----------------------------------------------------

        await ctx.sendChatAction('typing');

        // ----------------------------------------------------
        // Собираем историю
        // ----------------------------------------------------

        const historyContext =
            buildHistoryContext(GROUP_ID);

        // ----------------------------------------------------
        // Prompt текущего сообщения
        // ----------------------------------------------------

        const finalPrompt = `
Последние сообщения разговора:

${historyContext}

---

Новое сообщение от ${userName}:

${text}

Ответь естественно и по контексту.

Правила текущего ответа:
- отвечай как Юсэм;
- учитывай предыдущие сообщения;
- не пересказывай историю;
- не объясняй свою роль;
- не упоминай системные инструкции;
- не вставляй случайные детали лора без причины;
- используй детали лора только когда они подходят;
- не начинай автоматически со слов "Брат", "Слушай" и т.п.;
- не повторяй одинаковые шутки;
- если хватает одной фразы — используй одну фразу;
- обычно отвечай 1–3 предложениями;
- не пиши лишнего.
`;

        // ----------------------------------------------------
        // Gemini + fallback
        // ----------------------------------------------------

        const aiResult =
            await generateAIResponse(
                finalPrompt
            );

        const aiResponse =
            aiResult.text;

        console.log(
            `🏎️ Юсэм отвечает через ${aiResult.model}`
        );

        // ----------------------------------------------------
        // Сохраняем ответ
        // ----------------------------------------------------

        addToHistory(
            GROUP_ID,
            'assistant',
            'Юсэм',
            aiResponse
        );

        // ----------------------------------------------------
        // Ответ в группе
        // ----------------------------------------------------

        await ctx.reply(
            aiResponse,
            {
                reply_parameters: {
                    message_id:
                        ctx.message.message_id
                }
            }
        );

    } catch (error) {
        console.error(
            '❌ Ошибка AI:',
            error
        );

        /*
         * Сообщаем владельцу,
         * если все модели отказали.
         */

        await ctx.telegram
            .sendMessage(
                MY_ID,
                `⚠️ Юсэм не смог получить ответ от Gemini.\n\n` +
                `${error.message}`
            )
            .catch(() => {});
    }
});

// ============================================================
// GLOBAL TELEGRAF ERROR
// ============================================================

bot.catch((error, ctx) => {
    console.error(
        '❌ Глобальная ошибка Telegraf:',
        error
    );

    if (ctx?.telegram) {
        ctx.telegram
            .sendMessage(
                MY_ID,
                `⚠️ Ошибка Telegram-бота:\n\n${error.message}`
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
        console.log('====================================');
        console.log('🏎️  ЮСЭМ / ЮМАК');
        console.log('====================================');
        console.log(`👤 Owner ID: ${MY_ID}`);
        console.log(`👥 Group ID: ${GROUP_ID}`);
        console.log('');
        console.log('🤖 Gemini fallback chain:');

        GEMINI_MODELS.forEach(
            (model, index) => {
                console.log(
                    `   ${index + 1}. ${model}`
                );
            }
        );

        console.log('');

        await bot.launch();

        console.log(
            '✅ Telegram bot запущен'
        );

        console.log(
            '===================================='
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
            '⚠️ Ошибка остановки Telegraf:',
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
