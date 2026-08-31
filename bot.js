require("dotenv").config();

const { Telegraf } = require("telegraf");
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pool } = require("pg");
const { SYSTEM_PROMPT } = require("./prompt");

// ============================================================
// CONFIG
// ============================================================

const REQUIRED_ENV = ["BOT_TOKEN", "GEMINI_API_KEY", "DATABASE_URL"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Не задана переменная окружения: ${key}`);

    process.exit(1);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

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
 * Можно переопределить на Render:
 *
 * GEMINI_MODELS=gemini-3.7-flash,gemini-3.6-flash,...
 */

const GEMINI_MODELS = (
  process.env.GEMINI_MODELS ||
  [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ].join(",")
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

// ============================================================
// DATABASE
// ============================================================

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl: {
    rejectUnauthorized: false,
  },

  // Для небольшого бота больше не нужно.
  max: 5,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000,
});

pool
  .query("SELECT NOW()")
  .then(() => {
    console.log("✅ PostgreSQL / Supabase подключён");
  })
  .catch((error) => {
    console.error("❌ Ошибка подключения к PostgreSQL:", error.message);
  });

pool.on("error", (error) => {
  console.error("❌ PostgreSQL pool error:", error.message);
});

// ============================================================
// MEMORY
// ============================================================

const MAX_HISTORY = 20;
const MAX_CONTEXT_CHARS = 12000;

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
    text,
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
    return "(история отсутствует)";
  }

  let context = history
    .map((item) => {
      const speaker = item.role === "assistant" ? "Юсэм" : item.name;

      return `${speaker}: ${item.text}`;
    })
    .join("\n");

  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.slice(-MAX_CONTEXT_CHARS);
  }

  return context;
}

// ============================================================
// CHARACTER LORE
// ============================================================

/*
 * Ищем персонажей по их алиасам.
 *
 * Например:
 *
 * "Скайпом" → Андрей Скайп
 * "Палыча" → Палыч
 * "Кухаркой" → Кухарка
 *
 * Затем получаем описание и факты из character_lore.
 */

// ============================================================
// CHARACTER LORE FROM DATABASE
// ============================================================

async function getCharacterLore(searchText) {
  if (!searchText) {
    return [];
  }
  /* * Убираем обращение к самому Юсэму в начале сообщения. * * Например: * * "Юмак, кто такой Палыч?" * ↓ * "кто такой Палыч?" * * "Юсэм расскажи про Кухарку" * ↓ * "расскажи про Кухарку" * * Это не даёт триггеру "Юмак/Юсэм" * автоматически подтягивать весь лор самого Юсэма. */ const loreSearchText =
    searchText.replace(/^\s*(?:юсэм|юмак)\b[\s,:;.!?—-]*/iu, "").trim();
  /* * Если после удаления обращения ничего не осталось, * лор искать не нужно. */ if (
    !loreSearchText
  ) {
    return [];
  }
  try {
    const result = await pool.query(
      ` SELECT DISTINCT c.id, c.slug, c.name, c.description, l.fact, l.importance, l.id AS lore_id FROM characters c INNER JOIN character_aliases a ON a.character_id = c.id LEFT JOIN character_lore l ON l.character_id = c.id WHERE lower($1) LIKE '%' || lower(a.alias) || '%' ORDER BY l.importance DESC NULLS LAST, c.id ASC, l.id ASC `,
      [loreSearchText],
    );
    return result.rows;
  } catch (error) {
    console.error("❌ [LORE] Ошибка чтения:", error.message);
    return [];
  }
}

function buildCharacterLoreContext(rows) {
  if (!rows.length) {
    return "(релевантный лор персонажей не найден)";
  }

  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row.id)) {
      grouped.set(row.id, {
        name: row.name,
        description: row.description || "",
        facts: [],
      });
    }

    if (row.fact) {
      grouped.get(row.id).facts.push(row.fact);
    }
  }

  return Array.from(grouped.values())
    .map((character) => {
      const description = character.description
        ? `Описание: ${character.description}`
        : "";

      const facts = character.facts.length
        ? character.facts.map((fact) => `- ${fact}`).join("\n")
        : "- Дополнительных фактов нет.";

      return (
        `Персонаж: ${character.name}\n` +
        `${description}\n` +
        `Факты:\n${facts}`
      );
    })
    .join("\n\n");
}

// ============================================================
// AI SETTINGS
// ============================================================

const RETRY_DELAY_MS = 1000;

// Максимальное ожидание одной модели
const MODEL_TIMEOUT_MS = 20000;

// Сколько секунд модель пропускается после 429/503/timeout
const MODEL_COOLDOWN_MS = 60 * 1000;

const modelCooldowns = new Map();

// ============================================================
// TELEGRAM
// ============================================================

const bot = new Telegraf(BOT_TOKEN, {
  /*
   * Это дополнительная страховка.
   *
   * AI всё равно запускается отдельно,
   * поэтому Telegram не должен ждать Gemini.
   */
  handlerTimeout: 120000,
});

// ============================================================
// GEMINI
// ============================================================

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const aiModels = GEMINI_MODELS.map((modelName) => ({
  name: modelName,

  instance: genAI.getGenerativeModel({
    model: modelName,

    systemInstruction: SYSTEM_PROMPT,
  }),
}));

// ============================================================
// EXPRESS / RENDER
// ============================================================

const app = express();

app.get("/", (req, res) => {
  res.status(200).send("🏎️ Юсэм онлайн");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    bot: "online",
    uptime: Math.floor(process.uptime()),
    models: GEMINI_MODELS,
    history: getHistory(GROUP_ID).length,
  });
});

const server = app.listen(PORT, () => {
  console.log(`🌐 HTTP сервер запущен на порту ${PORT}`);
});

// ============================================================
// BASIC HELPERS
// ============================================================

function isGroupMessage(ctx) {
  return ctx.chat?.id === GROUP_ID;
}

function isOwnerPrivate(ctx) {
  return ctx.chat?.type === "private" && ctx.from?.id === MY_ID;
}

function isBotMessage(ctx) {
  return Boolean(ctx.from?.is_bot);
}

/*
 * Простая и надёжная проверка обращения к Юсэму.
 *
 * Поддерживает:
 *
 * Юсэм
 * Юмак
 * юсэм
 * юмак
 * Юмак, расскажи...
 */

function isMentioned(text = "") {
  if (!text) {
    return false;
  }

  const normalized = text.toLowerCase();

  return normalized.includes("юсэм") || normalized.includes("юмак");
}

function isReplyToBot(ctx) {
  const reply = ctx.message?.reply_to_message;

  if (!reply) {
    return false;
  }

  if (!reply.from?.id) {
    return false;
  }

  if (!ctx.botInfo?.id) {
    return false;
  }

  return reply.from.id === ctx.botInfo.id;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ============================================================
// MODEL COOLDOWN
// ============================================================

function isModelOnCooldown(modelName) {
  const cooldownUntil = modelCooldowns.get(modelName);

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
  modelCooldowns.set(modelName, Date.now() + MODEL_COOLDOWN_MS);
}

// ============================================================
// TIMEOUT
// ============================================================

function withTimeout(promise, timeoutMs, errorMessage) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  return Promise.race([
    promise.finally(() => {
      clearTimeout(timeoutId);
    }),

    timeoutPromise,
  ]);
}

// ============================================================
// GEMINI ERROR
// ============================================================

function getErrorMessage(error) {
  return String(error?.message || "");
}

function is429Error(error) {
  return getErrorMessage(error).includes("429");
}

function isTemporaryGeminiError(error) {
  const message = getErrorMessage(error).toLowerCase();

  const patterns = [
    "429",
    "500",
    "502",
    "503",
    "504",
    "timeout",
    "timed out",
    "service unavailable",
    "temporarily unavailable",
    "high demand",
    "overloaded",
    "fetching",
  ];

  return patterns.some((pattern) => message.includes(pattern));
}

// ============================================================
// GEMINI FALLBACK
// ============================================================

async function generateAIResponse(prompt) {
  let lastError = null;

  if (!aiModels.length) {
    throw new Error("Нет доступных Gemini-моделей.");
  }

  for (const model of aiModels) {
    // ----------------------------------------------------
    // COOLDOWN
    // ----------------------------------------------------

    if (isModelOnCooldown(model.name)) {
      console.log(`⏸️ [GEMINI] ${model.name} ` + `пропущена — cooldown`);

      continue;
    }

    console.log(`🤖 [GEMINI] Пробуем ${model.name}`);

    // ----------------------------------------------------
    // ПЕРВАЯ ПОПЫТКА
    // ----------------------------------------------------

    try {
      console.log(`🔄 [GEMINI] ${model.name} попытка 1`);

      const result = await withTimeout(
        model.instance.generateContent(prompt),

        MODEL_TIMEOUT_MS,

        `Timeout ${MODEL_TIMEOUT_MS}ms: ${model.name}`,
      );

      const responseText = result?.response?.text?.()?.trim();

      if (!responseText) {
        throw new Error("Gemini вернул пустой ответ.");
      }

      console.log(`✅ [GEMINI] Ответ через ${model.name}`);

      return {
        text: responseText,
        model: model.name,
      };
    } catch (error) {
      lastError = error;

      console.error(`❌ [GEMINI] ${model.name}:`, error.message);

      // =================================================
      // 429
      // =================================================

      if (is429Error(error)) {
        putModelOnCooldown(model.name);

        console.log(
          `⏭️ [GEMINI] ${model.name} ` +
            `получила 429 — ` +
            `БЕЗ повторной попытки`,
        );

        console.log(`➡️ [GEMINI] Следующая модель`);

        continue;
      }

      // =================================================
      // ВРЕМЕННАЯ ОШИБКА
      // =================================================

      if (isTemporaryGeminiError(error)) {
        console.log(`⏳ [GEMINI] Временная ошибка ` + `у ${model.name}`);

        await sleep(RETRY_DELAY_MS);

        // ------------------------------------------------
        // ВТОРАЯ ПОПЫТКА
        // ------------------------------------------------

        try {
          console.log(`🔄 [GEMINI] ${model.name} ` + `попытка 2`);

          const retryResult = await withTimeout(
            model.instance.generateContent(prompt),

            MODEL_TIMEOUT_MS,

            `Timeout ${MODEL_TIMEOUT_MS}ms: ${model.name}`,
          );

          const retryText = retryResult?.response?.text?.()?.trim();

          if (!retryText) {
            throw new Error("Gemini вернул пустой ответ.");
          }

          console.log(`✅ [GEMINI] Ответ через ${model.name}`);

          return {
            text: retryText,
            model: model.name,
          };
        } catch (retryError) {
          lastError = retryError;

          console.error(
            `❌ [GEMINI] ${model.name} ` + `попытка 2:`,
            retryError.message,
          );

          if (isTemporaryGeminiError(retryError)) {
            putModelOnCooldown(model.name);
          }

          console.log(`➡️ [GEMINI] Следующая модель`);

          continue;
        }
      }

      // =================================================
      // ПОСТОЯННАЯ ОШИБКА
      // =================================================

      console.log(`➡️ [GEMINI] Ошибка постоянная, ` + `следующая модель`);
    }
  }

  throw lastError || new Error("Все Gemini-модели недоступны.");
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
    ctx.from?.first_name || ctx.from?.username || "Неизвестный пользователь";

  const username = ctx.from?.username ? `@${ctx.from.username}` : "";

  const adminText =
    `💬 ${senderName} ${username}\n\n` +
    `${ctx.message.text}\n\n` +
    `📌 [group:${GROUP_ID}]\n` +
    `🆔 [msg:${ctx.message.message_id}]`;

  try {
    await ctx.telegram.sendMessage(MY_ID, adminText);

    console.log(`📡 [RADAR] msg=${ctx.message.message_id} → owner`);
  } catch (error) {
    console.error("❌ [RADAR] Ошибка:", error.message);
  }
}

// ============================================================
// OWNER COMMANDS
// ============================================================

async function handleOwnerCommand(ctx) {
  if (!isOwnerPrivate(ctx)) {
    return false;
  }

  const text = ctx.message?.text?.trim();

  if (!text) {
    return false;
  }

  if (!text.startsWith("/")) {
    return false;
  }

  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  // --------------------------------------------------------
  // START
  // --------------------------------------------------------

  if (command === "/start") {
    await ctx.reply(
      "🏎️ Юсэм онлайн.\n\n" +
        "/help — помощь\n" +
        "/clear — очистить память\n" +
        "/status — состояние",
    );

    return true;
  }

  // --------------------------------------------------------
  // HELP
  // --------------------------------------------------------

  if (command === "/help") {
    await ctx.reply(
      "🛠 Управление Юсэмом:\n\n" +
        "/clear — очистить память AI\n" +
        "/status — состояние бота\n\n" +
        "Ответь на сообщение радара — " +
        "ответ уйдёт в группу с цитированием.\n\n" +
        "Просто напиши мне текст — " +
        "он уйдёт в группу.",
    );

    return true;
  }

  // --------------------------------------------------------
  // CLEAR
  // --------------------------------------------------------

  if (command === "/clear") {
    clearHistory(GROUP_ID);

    await ctx.reply("🧠 Память Юсэма очищена.");

    console.log("🧹 [MEMORY] История очищена");

    return true;
  }

  // --------------------------------------------------------
  // STATUS
  // --------------------------------------------------------

  if (command === "/status") {
    const historyLength = getHistory(GROUP_ID).length;

    const modelStatus = GEMINI_MODELS.map((model, index) => {
      const cooldown = isModelOnCooldown(model);

      return `${index + 1}. ` + `${model} ` + (cooldown ? "⏸️" : "✅");
    }).join("\n");

    await ctx.reply(
      `🟢 Юсэм работает\n\n` +
        `⏱ Uptime: ` +
        `${Math.floor(process.uptime())} сек.\n` +
        `🧠 Память: ` +
        `${historyLength} сообщений\n\n` +
        `🤖 Gemini:\n` +
        modelStatus,
    );

    return true;
  }

  /*
   * Неизвестные команды не отправляем
   * в группу.
   */

  return true;
}

// ============================================================
// OWNER MANUAL MESSAGE
// ============================================================

async function sendOwnerMessageToGroup(ctx) {
  const text = ctx.message?.text?.trim();

  if (!text) {
    return;
  }

  const replyMessage = ctx.message?.reply_to_message;

  // --------------------------------------------------------
  // Ответ через радар
  // --------------------------------------------------------

  if (replyMessage?.text) {
    const match = replyMessage.text.match(/\[msg:(\d+)\]/);

    if (match) {
      const targetMessageId = Number(match[1]);

      try {
        await ctx.telegram.sendMessage(GROUP_ID, text, {
          reply_parameters: {
            message_id: targetMessageId,
          },
        });

        await ctx.reply("✅ Ответ отправлен с цитированием.");

        console.log(`📤 [OWNER] Reply → ${targetMessageId}`);

        return;
      } catch (error) {
        console.error("❌ [OWNER] Reply ошибка:", error.message);

        await ctx.reply(
          "❌ Не получилось ответить. " + "Возможно, сообщение удалено.",
        );

        return;
      }
    }
  }

  // --------------------------------------------------------
  // Обычное сообщение
  // --------------------------------------------------------

  try {
    await ctx.telegram.sendMessage(GROUP_ID, text);

    await ctx.reply("✅ Отправлено в группу.");

    console.log("📤 [OWNER] Сообщение отправлено");
  } catch (error) {
    console.error("❌ [OWNER] Ошибка отправки:", error.message);

    await ctx.reply("❌ Не удалось отправить сообщение.");
  }
}

// ============================================================
// AI
// ============================================================

async function handleAI(ctx) {
  try {
    // ----------------------------------------------------
    // Проверки
    // ----------------------------------------------------

    if (!isGroupMessage(ctx)) {
      return;
    }

    if (isBotMessage(ctx)) {
      return;
    }

    const text = ctx.message?.text?.trim();

    if (!text) {
      return;
    }

    // ----------------------------------------------------
    // Проверяем обращение
    // ----------------------------------------------------

    const mentioned = isMentioned(text);

    const repliedToBot = isReplyToBot(ctx);

    console.log("");
    console.log("========================================");

    console.log("🧪 [AI DEBUG]");

    console.log(`Text: ${text}`);

    console.log(`Chat ID: ${ctx.chat?.id}`);

    console.log(`User ID: ${ctx.from?.id}`);

    console.log(`Mentioned: ${mentioned}`);

    console.log(`Reply to bot: ${repliedToBot}`);

    console.log(`Bot ID: ${ctx.botInfo?.id}`);

    console.log("========================================");

    if (!mentioned && !repliedToBot) {
      console.log("⏭️ [AI] Ответ не требуется");

      return;
    }

    const userName =
      ctx.from?.first_name || ctx.from?.username || "Пользователь";

    console.log(`🧠 [AI] Запрос от ${userName}`);

    // ----------------------------------------------------
    // Память
    // ----------------------------------------------------

    addToHistory(GROUP_ID, "user", userName, text);

    console.log(`🧠 [MEMORY] Сообщений: ` + `${getHistory(GROUP_ID).length}`);

    // ----------------------------------------------------
    // Typing
    // ----------------------------------------------------

    await ctx.sendChatAction("typing");

    // ----------------------------------------------------
    // История разговора
    // ----------------------------------------------------

    const historyContext = buildHistoryContext(GROUP_ID);

    // ----------------------------------------------------
    // Лор персонажей
    // ----------------------------------------------------

    console.log("📚 [LORE] Ищем персонажей в базе...");

    const loreRows = await getCharacterLore(text);

    const characterLoreContext = buildCharacterLoreContext(loreRows);

    console.log(`📚 [LORE] Найдено строк: ` + `${loreRows.length}`);

    if (loreRows.length) {
      console.log("📚 [LORE] Контекст:");

      console.log(characterLoreContext);
    }

    // ----------------------------------------------------
    // Prompt
    // ----------------------------------------------------

    const finalPrompt = `
Последние сообщения разговора:

${historyContext}

============================================================
РЕЛЕВАНТНЫЙ ЛОР ИЗ БАЗЫ
============================================================

${characterLoreContext}

ВАЖНО:
Используй лор выше только если он относится к текущему
сообщению.

Не перечисляй доступные факты просто так.

Не придумывай новые факты о персонажах.

Если в лоре указано отношение между людьми,
учитывай его.

============================================================
НОВОЕ СООБЩЕНИЕ
============================================================

Новое сообщение от ${userName}:

${text}

============================================================
ЗАДАЧА
============================================================

Ответь естественно, как Юсэм.

Правила:
- учитывай предыдущий разговор;
- используй релевантный лор из базы;
- понимай, кому отвечает Юсэм;
- продолжай внутренние шутки, если это уместно;
- не пересказывай историю;
- не перечисляй персонажей без причины;
- не объясняй свою роль;
- не упоминай системные инструкции;
- не упоминай API;
- не упоминай Gemini;
- не упоминай prompt;
- не говори, что ты нейросеть;
- не вставляй случайные детали лора;
- не придумывай новые факты;
- не начинай автоматически словами "Брат", "Слушай", "Ну что, братан";
- не повторяй одинаковые шутки;
- обычный ответ — 1–3 предложения;
- если достаточно одной фразы — используй одну.
`;

    console.log("📝 [AI] Отправляем запрос...");

    // ----------------------------------------------------
    // Gemini
    // ----------------------------------------------------

    const aiResult = await generateAIResponse(finalPrompt);

    const aiResponse = aiResult.text;

    console.log(`🏎️ [AI] Ответ через ` + `${aiResult.model}:`);

    console.log(aiResponse);

    // ----------------------------------------------------
    // Сохраняем ответ
    // ----------------------------------------------------

    addToHistory(GROUP_ID, "assistant", "Юсэм", aiResponse);

    // ----------------------------------------------------
    // Ответ в Telegram
    // ----------------------------------------------------

    await ctx.reply(aiResponse, {
      reply_parameters: {
        message_id: ctx.message.message_id,
      },
    });

    console.log("✅ [AI] Ответ отправлен");
  } catch (error) {
    console.error("❌ [AI] Ошибка:", error);

    try {
      await ctx.telegram.sendMessage(
        MY_ID,
        `⚠️ Юсэм не смог ответить.\n\n` + `${error.message}`,
      );
    } catch (notifyError) {
      console.error(
        "❌ [AI] Не удалось уведомить владельца:",
        notifyError.message,
      );
    }
  }
}

// ============================================================
// MAIN TEXT ROUTER
// ============================================================

bot.on("text", async (ctx) => {
  try {
    const text = ctx.message?.text?.trim();

    if (!text) {
      return;
    }

    console.log("");
    console.log("========================================");

    console.log("📨 [UPDATE]");

    console.log(`Chat ID: ${ctx.chat?.id}`);

    console.log(`Type: ${ctx.chat?.type}`);

    console.log(`From: ${ctx.from?.id}`);

    console.log(`Text: ${text}`);

    console.log("========================================");

    // ====================================================
    // OWNER
    // ====================================================

    if (isOwnerPrivate(ctx)) {
      console.log("👤 [ROUTER] Сообщение владельца");

      const commandHandled = await handleOwnerCommand(ctx);

      if (commandHandled) {
        return;
      }

      /*
       * Обычный текст владельца
       * отправляем в группу.
       */

      if (text.startsWith("/")) {
        return;
      }

      await sendOwnerMessageToGroup(ctx);

      return;
    }

    // ====================================================
    // GROUP
    // ====================================================

    if (isGroupMessage(ctx)) {
      console.log("👥 [ROUTER] Сообщение группы");

      // ------------------------------------------------
      // Радар
      // ------------------------------------------------

      await sendRadarMessage(ctx);

      // ------------------------------------------------
      // AI
      //
      // ВАЖНО:
      // здесь НЕТ await.
      //
      // Telegraf не ждёт Gemini.
      // ------------------------------------------------

      const shouldRunAI =
        !isBotMessage(ctx) && (isMentioned(text) || isReplyToBot(ctx));

      if (shouldRunAI) {
        console.log("🚀 [AI] Запускаем AI отдельно");

        void handleAI(ctx).catch((error) => {
          console.error("❌ [AI] Detached error:", error);
        });
      } else {
        console.log("⏭️ [AI] AI не требуется");
      }

      return;
    }

    // ====================================================
    // OTHER
    // ====================================================

    console.log("ℹ️ [ROUTER] Сообщение проигнорировано");
  } catch (error) {
    console.error("❌ [ROUTER] Ошибка:", error);

    try {
      await ctx.telegram.sendMessage(
        MY_ID,
        `⚠️ Ошибка роутера:\n\n` + `${error.message}`,
      );
    } catch (notifyError) {
      console.error("❌ Не удалось уведомить владельца:", notifyError.message);
    }
  }
});

// ============================================================
// GLOBAL TELEGRAF ERROR
// ============================================================

bot.catch((error, ctx) => {
  console.error("❌ [TELEGRAF] Глобальная ошибка:", error);

  /*
   * Ошибки AI сюда обычно не попадут,
   * потому что handleAI() ловит их самостоятельно.
   */

  if (ctx?.telegram) {
    ctx.telegram
      .sendMessage(
        MY_ID,
        `⚠️ Ошибка Telegram-обработчика:\n\n` + `${error.message}`,
      )
      .catch(() => {});
  }
});

// ============================================================
// START
// ============================================================

async function start() {
  try {
    console.log("");
    console.log("========================================");

    console.log("🏎️  ЮСЭМ / ЮМАК");

    console.log("========================================");

    console.log(`👤 Owner ID: ${MY_ID}`);

    console.log(`👥 Group ID: ${GROUP_ID}`);

    console.log(`🌐 Port: ${PORT}`);

    console.log("");

    console.log("🤖 Gemini fallback chain:");

    GEMINI_MODELS.forEach((model, index) => {
      console.log(`   ${index + 1}. ${model}`);
    });

    console.log("");

    console.log(`⏱️ Timeout модели: ` + `${MODEL_TIMEOUT_MS / 1000} сек.`);

    console.log(`⏸️ Cooldown модели: ` + `${MODEL_COOLDOWN_MS / 1000} сек.`);

    console.log("");

    console.log("🚀 Запускаем Telegram...");

    await bot.launch();

    console.log("✅ Telegram bot запущен");

    console.log("========================================");

    console.log("");
  } catch (error) {
    console.error("❌ Не удалось запустить бота:", error);

    server.close(() => {
      process.exit(1);
    });
  }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(signal) {
  console.log(`🛑 Получен ${signal}. ` + `Останавливаем бота...`);

  try {
    bot.stop(signal);
  } catch (error) {
    console.error("⚠️ Ошибка остановки Telegraf:", error.message);
  }

  server.close(() => {
    console.log("✅ HTTP сервер остановлен.");

    pool
      .end()
      .catch((error) => {
        console.error("⚠️ Ошибка закрытия PostgreSQL:", error.message);
      })
      .finally(() => {
        process.exit(0);
      });
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));

process.once("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================
// RUN
// ============================================================

start();
