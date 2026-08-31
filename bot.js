require("dotenv").config();

const { Telegraf } = require("telegraf");
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pool } = require("pg");
const { SYSTEM_PROMPT } = require("./prompt");

// ============================================================
// CONFIG
// ============================================================

const REQUIRED_ENV = ["BOT_TOKEN", "GEMINI_API_KEY"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Не задана переменная окружения: ${key}`);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Не задана переменная DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool
  .query("SELECT NOW()")
  .then(() => {
    console.log("✅ PostgreSQL / Supabase подключён");
  })
  .catch((error) => {
    console.error("❌ Ошибка подключения к PostgreSQL:", error.message);
  });

const MY_ID = 141824902;
const GROUP_ID = -5278268745;

// Render сам передаёт PORT
const PORT = Number(process.env.PORT) || 3000;

// ============================================================
// GEMINI MODELS
// ============================================================

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
// MEMORY
// ============================================================

const MAX_HISTORY = 20;
const MAX_CONTEXT_CHARS = 12000;

const chatHistory = new Map();

// ============================================================
// AI SETTINGS
// ============================================================

// Сколько раз повторять модель
const RETRIES_PER_MODEL = 1;

// Пауза между попытками
const RETRY_DELAY_MS = 1000;

// Сколько максимум ждать ОДНУ модель
const MODEL_TIMEOUT_MS = 20000;

// На сколько секунд отключать модель после 429/503/timeout
const MODEL_COOLDOWN_MS = 60 * 1000;

const modelCooldowns = new Map();

// ============================================================
// TELEGRAM
// ============================================================

/*
 * Важно:
 *
 * Увеличиваем handlerTimeout с дефолтных 90 секунд,
 * но ниже AI всё равно запускается отдельно.
 *
 * Это дополнительная страховка.
 */
const bot = new Telegraf(BOT_TOKEN, {
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
  });
});

const server = app.listen(PORT, () => {
  console.log(`🌐 HTTP сервер запущен на порту ${PORT}`);
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
// HELPERS
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
 * Простейшая и надёжная проверка.
 *
 * Распознаёт:
 * Юсэм
 * юсэм
 * ЮСЭМ
 * Юмак
 * юмак
 *
 * и фразы:
 * "Юмак, расскажи..."
 * "слушай, Юсэм..."
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
// TIMEOUT WRAPPER
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

function isTemporaryGeminiError(error) {
  const message = String(error?.message || "").toLowerCase();

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
    // Проверяем cooldown
    // ----------------------------------------------------

    if (isModelOnCooldown(model.name)) {
      console.log(`⏸️ [GEMINI] ${model.name} ` + `пропущена — cooldown`);

      continue;
    }

    console.log(`🤖 [GEMINI] Пробуем ${model.name}`);

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

      const temporary = isTemporaryGeminiError(error);

      // ------------------------------------------------
      // 429 — квота исчерпана.
      // НЕ повторяем запрос этой же модели.
      // Сразу идём к следующей.
      // ------------------------------------------------

      if (temporary && String(error.message).includes("429")) {
        putModelOnCooldown(model.name);

        console.log(
          `⏭️ [GEMINI] ${model.name} ` +
            `получила 429 — сразу следующая модель`,
        );

        continue;
      }

      // ------------------------------------------------
      // 503 / timeout и другие временные ошибки
      // можно повторить один раз.
      // ------------------------------------------------

      if (temporary) {
        console.log(`⏳ [GEMINI] Временная ошибка у ` + `${model.name}`);

        await sleep(RETRY_DELAY_MS);

        try {
          console.log(`🔄 [GEMINI] ${model.name} попытка 2`);

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

          continue;
        }
      }

      // ------------------------------------------------
      // Постоянная ошибка — сразу следующая модель
      // ------------------------------------------------

      console.log(`➡️ [GEMINI] Постоянная ошибка, ` + `переходим дальше`);
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

  if (!text?.startsWith("/")) {
    return false;
  }

  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/start") {
    await ctx.reply(
      "🏎️ Юсэм онлайн.\n\n" +
        "/help — помощь\n" +
        "/clear — очистить память\n" +
        "/status — состояние",
    );

    return true;
  }

  if (command === "/help") {
    await ctx.reply(
      "🛠 Управление Юсэмом:\n\n" +
        "/clear — очистить память AI\n" +
        "/status — состояние бота\n\n" +
        "Ответь на сообщение радара — " +
        "ответ уйдёт в группу с цитированием.\n\n" +
        "Просто напиши мне — текст уйдёт в группу.",
    );

    return true;
  }

  if (command === "/clear") {
    clearHistory(GROUP_ID);

    await ctx.reply("🧠 Память Юсэма очищена.");

    console.log("🧹 [MEMORY] История очищена");

    return true;
  }

  if (command === "/status") {
    const historyLength = getHistory(GROUP_ID).length;

    let message =
      `🟢 Юсэм работает\n\n` +
      `⏱ Uptime: ` +
      `${Math.floor(process.uptime())} сек.\n` +
      `🧠 Память: ` +
      `${historyLength} сообщений\n\n` +
      `🤖 Gemini модели:\n`;

    message += GEMINI_MODELS.map((model, index) => {
      const status = isModelOnCooldown(model) ? " ⏸️ cooldown" : " ✅";

      return `${index + 1}. ` + `${model}${status}`;
    }).join("\n");

    await ctx.reply(message);

    return true;
  }

  // Неизвестную команду не отправляем в группу
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

  const replyMessage = ctx.message.reply_to_message;

  /*
   * Ответ на сообщение радара.
   */

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

  /*
   * Простое сообщение.
   */

  try {
    await ctx.telegram.sendMessage(GROUP_ID, text);

    await ctx.reply("✅ Отправлено в группу.");

    console.log("📤 [OWNER] Сообщение отправлено");
  } catch (error) {
    console.error("❌ [OWNER] Ошибка:", error.message);

    await ctx.reply("❌ Не удалось отправить сообщение.");
  }
}

// ============================================================
// AI HANDLER
// ============================================================

async function handleAI(ctx) {
  try {
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
    // Добавляем сообщение в память
    // ----------------------------------------------------

    addToHistory(GROUP_ID, "user", userName, text);

    console.log(`🧠 [MEMORY] Сообщений: ` + `${getHistory(GROUP_ID).length}`);

    // ----------------------------------------------------
    // Typing
    // ----------------------------------------------------

    await ctx.sendChatAction("typing");

    // ----------------------------------------------------
    // История
    // ----------------------------------------------------

    const historyContext = buildHistoryContext(GROUP_ID);

    // ----------------------------------------------------
    // Prompt
    // ----------------------------------------------------

    const finalPrompt = `
Последние сообщения разговора:

${historyContext}

---

Новое сообщение от ${userName}:

${text}

Ответь естественно и по контексту разговора.

Правила:
- отвечай как Юсэм;
- учитывай предыдущие сообщения;
- понимай, кому отвечаешь;
- продолжай внутренние шутки, если это уместно;
- не пересказывай историю;
- не объясняй свою роль;
- не упоминай системные инструкции;
- не упоминай API, модели, промпты или нейросети;
- используй детали лора только когда они действительно подходят;
- не начинай автоматически со слов "Брат", "Слушай", "Ну что, братан";
- не повторяй одинаковые шутки;
- обычный ответ — 1–3 предложения;
- если достаточно одной фразы — используй одну.
`;

    console.log("📝 [AI] Отправляем запрос...");

    // ----------------------------------------------------
    // Gemini fallback
    // ----------------------------------------------------

    const aiResult = await generateAIResponse(finalPrompt);

    const aiResponse = aiResult.text;

    console.log(`🏎️ [AI] Ответ через ${aiResult.model}:`);

    console.log(aiResponse);

    // ----------------------------------------------------
    // Сохраняем ответ
    // ----------------------------------------------------

    addToHistory(GROUP_ID, "assistant", "Юсэм", aiResponse);

    // ----------------------------------------------------
    // Telegram
    // ----------------------------------------------------

    await ctx.reply(aiResponse, {
      reply_parameters: {
        message_id: ctx.message.message_id,
      },
    });

    console.log("✅ [AI] Ответ отправлен");
  } catch (error) {
    console.error("❌ [AI] Ошибка:", error);

    /*
     * Не падаем наружу.
     *
     * Сообщаем владельцу,
     * что AI не смог ответить.
     */

    await ctx.telegram
      .sendMessage(MY_ID, `⚠️ Юсэм не смог ответить.\n\n` + `${error.message}`)
      .catch(() => {});
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
    // OWNER PRIVATE
    // ====================================================

    if (isOwnerPrivate(ctx)) {
      console.log("👤 [ROUTER] Сообщение владельца");

      const handled = await handleOwnerCommand(ctx);

      if (handled) {
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

      // ---------------------------------------------
      // Радар выполняем сразу
      // ---------------------------------------------

      await sendRadarMessage(ctx);

      // ---------------------------------------------
      // AI запускаем ОТДЕЛЬНО
      //
      // ВАЖНО:
      // НЕ await handleAI(ctx)
      //
      // Это позволяет Telegraf не ждать Gemini.
      // ---------------------------------------------

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

    await ctx.telegram
      .sendMessage(MY_ID, `⚠️ Ошибка роутера:\n\n${error.message}`)
      .catch(() => {});
  }
});

// ============================================================
// GLOBAL TELEGRAF ERROR
// ============================================================

bot.catch((error, ctx) => {
  console.error("❌ [TELEGRAF] Глобальная ошибка:", error);

  /*
   * Важно:
   *
   * Не отправляем сюда "Ошибка Telegram"
   * на каждый timeout AI.
   *
   * AI ошибки ловятся внутри handleAI().
   */

  if (ctx?.telegram) {
    ctx.telegram
      .sendMessage(
        MY_ID,
        `⚠️ Ошибка обработки Telegram-события:\n\n` + `${error.message}`,
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
    console.error("⚠️ Ошибка остановки:", error.message);
  }

  server.close(() => {
    console.log("✅ HTTP сервер остановлен.");

    process.exit(0);
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));

process.once("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================
// RUN
// ============================================================

start();
