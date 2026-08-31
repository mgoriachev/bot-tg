require("dotenv").config();

const { Telegraf } = require("telegraf");
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const { SYSTEM_PROMPT } = require("./prompt");

// ============================================================
// CONFIG
// ============================================================

const REQUIRED_ENV = [
  "BOT_TOKEN",
  "GEMINI_API_KEY",
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Не задана переменная окружения: ${key}`);

    process.exit(1);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Telegram
const MY_ID = 141824902;
const GROUP_ID = -5278268745;

// Render
const PORT = Number(process.env.PORT) || 3000;

// Storage bucket
const STORAGE_BUCKET = "character-photos";

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
// DATABASE
// ============================================================

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl: {
    rejectUnauthorized: false,
  },

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
// SUPABASE STORAGE
// ============================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

supabase.storage
  .listBuckets()
  .then(({ data, error }) => {
    if (error) {
      console.error("❌ [STORAGE] Ошибка:", error.message);

      return;
    }

    console.log("✅ [STORAGE] Подключён");

    console.log(
      "📦 [STORAGE] Buckets:",
      data.map((bucket) => bucket.name),
    );

    const bucketExists = data.some((bucket) => bucket.name === STORAGE_BUCKET);

    if (!bucketExists) {
      console.error(`❌ [STORAGE] Bucket "${STORAGE_BUCKET}" не найден`);
    }
  })
  .catch((error) => {
    console.error("❌ [STORAGE] Критическая ошибка:", error.message);
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
// TEACHING SESSIONS
// ============================================================

const teachingSessions = new Map();

function getTeachingSession(userId) {
  return teachingSessions.get(userId);
}

function setTeachingSession(userId, session) {
  teachingSessions.set(userId, session);
}

function clearTeachingSession(userId) {
  teachingSessions.delete(userId);
}

// ============================================================
// CHARACTER LORE
// ============================================================

async function getCharacterLore(searchText) {
  if (!searchText) {
    return [];
  }

  /*
   * Убираем обращение к Юсэму/Юмаку
   * в начале сообщения.
   *
   * Важно:
   * НЕ используем \b, потому что для
   * кириллицы это ненадёжно.
   */

  const loreSearchText = searchText
    .replace(/^\s*(?:юсэм|юмак)\s*[,.:;!?—-]?\s*/iu, "")
    .trim();

  console.log(`🔎 [LORE] Поисковый текст: "${loreSearchText}"`);

  if (!loreSearchText) {
    return [];
  }

  try {
    const result = await pool.query(
      `
                SELECT DISTINCT
                    c.id,
                    c.slug,
                    c.name,
                    c.description,
                    l.fact,
                    l.importance,
                    l.id AS lore_id

                FROM characters c

                INNER JOIN character_aliases a
                    ON a.character_id = c.id

                LEFT JOIN character_lore l
                    ON l.character_id = c.id

                WHERE
                    lower($1)
                    LIKE '%' || lower(a.alias) || '%'

                ORDER BY
                    l.importance DESC NULLS LAST,
                    c.id ASC,
                    l.id ASC
                `,
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

// Максимум ожидания одной модели
const MODEL_TIMEOUT_MS = 20000;

// Cooldown
const MODEL_COOLDOWN_MS = 60 * 1000;

const modelCooldowns = new Map();

// ============================================================
// TELEGRAM
// ============================================================

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

    history: getHistory(GROUP_ID).length,

    teachingSessions: teachingSessions.size,
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

// ------------------------------------------------------------
// MENTION
// ------------------------------------------------------------

function isMentioned(text = "") {
  if (!text) {
    return false;
  }

  const normalized = text.toLowerCase();

  return normalized.includes("юсэм") || normalized.includes("юмак");
}

// ------------------------------------------------------------
// REPLY TO BOT
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// SLEEP
// ------------------------------------------------------------

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
// GEMINI ERRORS
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
    // ATTEMPT 1
    // ----------------------------------------------------

    try {
      console.log(`🔄 [GEMINI] ` + `${model.name} попытка 1`);

      const result = await withTimeout(
        model.instance.generateContent(prompt),

        MODEL_TIMEOUT_MS,

        `Timeout ${MODEL_TIMEOUT_MS}ms: ${model.name}`,
      );

      const responseText = result?.response?.text?.()?.trim();

      if (!responseText) {
        throw new Error("Gemini вернул пустой ответ.");
      }

      console.log(`✅ [GEMINI] Ответ через ` + `${model.name}`);

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
          `⏭️ [GEMINI] ${model.name} ` + `получила 429 — БЕЗ повторной попытки`,
        );

        console.log(`➡️ [GEMINI] Следующая модель`);

        continue;
      }

      // =================================================
      // TEMPORARY
      // =================================================

      if (isTemporaryGeminiError(error)) {
        console.log(`⏳ [GEMINI] Временная ошибка ` + `у ${model.name}`);

        await sleep(RETRY_DELAY_MS);

        // ------------------------------------------------
        // ATTEMPT 2
        // ------------------------------------------------

        try {
          console.log(`🔄 [GEMINI] ` + `${model.name} попытка 2`);

          const retryResult = await withTimeout(
            model.instance.generateContent(prompt),

            MODEL_TIMEOUT_MS,

            `Timeout ${MODEL_TIMEOUT_MS}ms: ${model.name}`,
          );

          const retryText = retryResult?.response?.text?.()?.trim();

          if (!retryText) {
            throw new Error("Gemini вернул пустой ответ.");
          }

          console.log(`✅ [GEMINI] Ответ через ` + `${model.name}`);

          return {
            text: retryText,

            model: model.name,
          };
        } catch (retryError) {
          lastError = retryError;

          console.error(
            `❌ [GEMINI] ` + `${model.name} попытка 2:`,
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
      // PERMANENT ERROR
      // =================================================

      console.log(`➡️ [GEMINI] Ошибка постоянная, ` + `переходим дальше`);
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

    console.log(`📡 [RADAR] msg=` + `${ctx.message.message_id} → owner`);
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

  // ========================================================
  // /START
  // ========================================================

  if (command === "/start") {
    await ctx.reply(
      "🏎️ Юсэм онлайн.\n\n" +
        "/help — помощь\n" +
        "/clear — очистить память\n" +
        "/status — состояние\n" +
        "/characters — персонажи",
    );

    return true;
  }

  // ========================================================
  // /HELP
  // ========================================================

  if (command === "/help") {
    await ctx.reply(
      "🛠 Управление Юсэмом:\n\n" +
        "/clear — очистить память AI\n" +
        "/status — состояние бота\n" +
        "/characters — список персонажей\n" +
        "/teach slug — начать обучение фото\n" +
        "/done — закончить обучение\n" +
        "/cancel — отменить обучение\n\n" +
        "Ответь на сообщение радара — " +
        "ответ уйдёт в группу с цитированием.\n\n" +
        "Обычный текст в личке отправляется в группу.",
    );

    return true;
  }

  // ========================================================
  // /CLEAR
  // ========================================================

  if (command === "/clear") {
    clearHistory(GROUP_ID);

    await ctx.reply("🧠 Память Юсэма очищена.");

    console.log("🧹 [MEMORY] История очищена");

    return true;
  }

  // ========================================================
  // /STATUS
  // ========================================================

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
        `${historyLength} сообщений\n` +
        `📚 Активных teach-сессий: ` +
        `${teachingSessions.size}\n\n` +
        `🤖 Gemini:\n` +
        modelStatus,
    );

    return true;
  }

  // ========================================================
  // /CHARACTERS
  // ========================================================

  if (command === "/characters") {
    try {
      const result = await pool.query(
        `
                    SELECT
                        c.name,
                        c.slug,
                        COUNT(p.id)::int AS photo_count,
                        COUNT(l.id)::int AS lore_count

                    FROM characters c

                    LEFT JOIN character_photos p
                        ON p.character_id = c.id

                    LEFT JOIN character_lore l
                        ON l.character_id = c.id

                    GROUP BY
                        c.id,
                        c.name,
                        c.slug

                    ORDER BY
                        c.id
                    `,
      );

      if (!result.rows.length) {
        await ctx.reply("👥 Персонажей пока нет.");

        return true;
      }

      const lines = result.rows.map(
        (row) =>
          `${row.name}\n` +
          `  slug: ${row.slug}\n` +
          `  📷 Фото: ${row.photo_count}\n` +
          `  📚 Лор: ${row.lore_count}`,
      );

      await ctx.reply("👥 Персонажи:\n\n" + lines.join("\n\n"));

      return true;
    } catch (error) {
      console.error("❌ [CHARACTERS] Ошибка:", error.message);

      await ctx.reply("❌ Не удалось получить список персонажей.");

      return true;
    }
  }

  // ========================================================
  // /TEACH
  // ========================================================

  if (command === "/teach") {
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
      await ctx.reply(
        "📷 Использование:\n\n" +
          "/teach essem\n" +
          "/teach kuharka\n" +
          "/teach palych\n" +
          "/teach sery",
      );

      return true;
    }

    const slug = parts[1].toLowerCase().trim();

    try {
      const result = await pool.query(
        `
                    SELECT
                        id,
                        slug,
                        name

                    FROM characters

                    WHERE slug = $1

                    LIMIT 1
                    `,
        [slug],
      );

      if (!result.rows.length) {
        await ctx.reply(
          `❌ Персонаж "${slug}" не найден.\n\n` +
            `Используй /characters, ` +
            `чтобы посмотреть список.`,
        );

        return true;
      }

      const character = result.rows[0];

      /*
       * На всякий случай закрываем
       * предыдущую сессию.
       */

      clearTeachingSession(ctx.from.id);

      setTeachingSession(ctx.from.id, {
        characterId: character.id,

        characterSlug: character.slug,

        characterName: character.name,

        photos: [],
      });

      await ctx.reply(
        `📷 Начинаем обучение персонажа: ` +
          `${character.name}\n\n` +
          `Отправляй фотографии одну за одной.\n` +
          `Когда закончишь — /done\n` +
          `Отменить — /cancel`,
      );

      console.log(
        `📚 [TEACH] Начата сессия: ` +
          `${character.name} ` +
          `(${character.slug})`,
      );

      return true;
    } catch (error) {
      console.error("❌ [TEACH] Ошибка:", error.message);

      await ctx.reply("❌ Не удалось начать обучение.");

      return true;
    }
  }

  // ========================================================
  // /CANCEL
  // ========================================================

  if (command === "/cancel") {
    const session = getTeachingSession(ctx.from.id);

    if (!session) {
      await ctx.reply("ℹ️ Активной сессии обучения нет.");

      return true;
    }

    clearTeachingSession(ctx.from.id);

    await ctx.reply(
      `❌ Обучение персонажа ` + `${session.characterName} отменено.`,
    );

    console.log(`❌ [TEACH] Сессия отменена: ` + `${session.characterName}`);

    return true;
  }

  // ========================================================
  // /DONE
  // ========================================================

  if (command === "/done") {
    const session = getTeachingSession(ctx.from.id);

    if (!session) {
      await ctx.reply(
        "ℹ️ Активной сессии обучения нет.\n\n" +
          "Сначала используй /teach essem",
      );

      return true;
    }

    if (!session.photos.length) {
      await ctx.reply(
        `📷 У персонажа ` +
          `${session.characterName} ` +
          `пока нет фотографий.\n\n` +
          `Сначала отправь хотя бы одну.`,
      );

      return true;
    }

    await ctx.reply(
      `⏳ Сохраняю ` +
        `${session.photos.length} фото ` +
        `персонажа ${session.characterName}...`,
    );

    console.log(
      `📚 [TEACH] Завершаем обучение: ` +
        `${session.characterName}, ` +
        `${session.photos.length} фото`,
    );

    let savedCount = 0;

    try {
      for (let index = 0; index < session.photos.length; index++) {
        const photo = session.photos[index];

        const photoNumber = index + 1;

        console.log(
          `📷 [TEACH] Обрабатываем фото ` +
            `${photoNumber}/` +
            `${session.photos.length}`,
        );

        // --------------------------------------------
        // Telegram file
        // --------------------------------------------

        const telegramFile = await ctx.telegram.getFile(photo.fileId);

        const filePath = telegramFile.file_path;

        if (!filePath) {
          throw new Error(
            `Telegram не вернул ` + `file_path для фото #` + `${photoNumber}`,
          );
        }

        // --------------------------------------------
        // Download
        // --------------------------------------------

        const fileUrl =
          `https://api.telegram.org/file/bot` + `${BOT_TOKEN}/${filePath}`;

        const response = await fetch(fileUrl);

        if (!response.ok) {
          throw new Error(
            `Не удалось скачать фото #` +
              `${photoNumber}: ` +
              `HTTP ${response.status}`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();

        const buffer = Buffer.from(arrayBuffer);

        // --------------------------------------------
        // Storage path
        // --------------------------------------------

        const storagePath =
          `${session.characterSlug}/` + `${Date.now()}-` + `${photoNumber}.jpg`;

        // --------------------------------------------
        // Upload Supabase Storage
        // --------------------------------------------

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, buffer, {
            contentType: "image/jpeg",

            upsert: false,
          });

        if (uploadError) {
          throw new Error(
            `Ошибка Storage для фото #` +
              `${photoNumber}: ` +
              `${uploadError.message}`,
          );
        }

        // --------------------------------------------
        // PostgreSQL
        // --------------------------------------------

        await pool.query(
          `
                    INSERT INTO character_photos (
                        character_id,
                        storage_path,
                        telegram_file_id,
                        photo_number
                    )
                    VALUES ($1, $2, $3, $4)
                    `,
          [session.characterId, storagePath, photo.fileId, photoNumber],
        );

        savedCount++;

        console.log(`✅ [TEACH] Фото #` + `${photoNumber} сохранено`);
      }

      // ----------------------------------------------
      // Завершаем сессию
      // ----------------------------------------------

      clearTeachingSession(ctx.from.id);

      await ctx.reply(
        `✅ Готово!\n\n` +
          `Персонаж: ` +
          `${session.characterName}\n` +
          `📷 Сохранено: ` +
          `${savedCount}\n\n` +
          `Фотографии добавлены в базу персонажа.`,
      );

      console.log(
        `✅ [TEACH] Обучение завершено: ` +
          `${session.characterName}, ` +
          `${savedCount} фото`,
      );
    } catch (error) {
      console.error("❌ [TEACH DONE] Ошибка:", error);

      /*
       * Сессию НЕ удаляем.
       *
       * Это позволяет повторить /done,
       * если временно отвалился Storage.
       */

      await ctx.reply(
        `❌ Не удалось сохранить фотографии.\n\n` +
          `Сохранено: ` +
          `${savedCount} из ` +
          `${session.photos.length}\n\n` +
          `${error.message}`,
      );
    }

    return true;
  }

  // ========================================================
  // UNKNOWN COMMAND
  // ========================================================

  return true;
}

// ============================================================
// OWNER PHOTO HANDLER
// ============================================================

bot.on("photo", async (ctx) => {
  try {
    /*
     * Только личка владельца.
     */

    if (!isOwnerPrivate(ctx)) {
      return;
    }

    const session = getTeachingSession(ctx.from.id);

    /*
     * Если обучение не запущено,
     * фото не трогаем.
     */

    if (!session) {
      return;
    }

    const photos = ctx.message?.photo;

    if (!Array.isArray(photos) || !photos.length) {
      return;
    }

    /*
     * Telegram отдаёт несколько размеров.
     * Берём самый большой.
     */

    const largestPhoto = photos[photos.length - 1];

    if (!largestPhoto?.file_id) {
      return;
    }

    session.photos.push({
      fileId: largestPhoto.file_id,

      width: largestPhoto.width,

      height: largestPhoto.height,
    });

    console.log(
      `📷 [TEACH] ` +
        `${session.characterName}: ` +
        `получено фото #` +
        `${session.photos.length}`,
    );

    await ctx.reply(
      `📷 Фото №` +
        `${session.photos.length} получено.\n` +
        `Персонаж: ` +
        `${session.characterName}\n\n` +
        `Отправь ещё фото или напиши /done`,
    );
  } catch (error) {
    console.error("❌ [TEACH PHOTO] Ошибка:", error.message);

    await ctx.reply("❌ Не удалось принять фотографию.");
  }
});

// ============================================================
// OWNER TEXT ROUTER
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

    // =================================================
    // OWNER PRIVATE
    // =================================================

    if (isOwnerPrivate(ctx)) {
      console.log("👤 [ROUTER] Сообщение владельца");

      const commandHandled = await handleOwnerCommand(ctx);

      if (commandHandled) {
        return;
      }

      /*
       * Обычный текст владельца
       * отправляем в группу.
       *
       * Команды сюда не попадут,
       * потому что handleOwnerCommand()
       * вернул true.
       */

      await sendOwnerMessageToGroup(ctx);

      return;
    }

    // =================================================
    // GROUP
    // =================================================

    if (isGroupMessage(ctx)) {
      console.log("👥 [ROUTER] Сообщение группы");

      // ------------------------------------------------
      // RADAR
      // ------------------------------------------------

      await sendRadarMessage(ctx);

      // ------------------------------------------------
      // AI
      // ------------------------------------------------

      const shouldRunAI =
        !isBotMessage(ctx) && (isMentioned(text) || isReplyToBot(ctx));

      if (shouldRunAI) {
        console.log("🚀 [AI] Запускаем AI отдельно");

        /*
         * НЕ await!
         *
         * Telegram handler не ждёт Gemini.
         */

        void handleAI(ctx).catch((error) => {
          console.error("❌ [AI] Detached error:", error);
        });
      } else {
        console.log("⏭️ [AI] AI не требуется");
      }

      return;
    }

    // =================================================
    // OTHER
    // =================================================

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

    // ----------------------------------------------------
    // Mention
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
    // MEMORY
    // ----------------------------------------------------

    addToHistory(GROUP_ID, "user", userName, text);

    console.log(`🧠 [MEMORY] Сообщений: ` + `${getHistory(GROUP_ID).length}`);

    // ----------------------------------------------------
    // TYPING
    // ----------------------------------------------------

    await ctx.sendChatAction("typing");

    // ----------------------------------------------------
    // HISTORY
    // ----------------------------------------------------

    const historyContext = buildHistoryContext(GROUP_ID);

    // ----------------------------------------------------
    // CHARACTER LORE
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
    // FINAL PROMPT
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
    // GEMINI
    // ----------------------------------------------------

    const aiResult = await generateAIResponse(finalPrompt);

    const aiResponse = aiResult.text;

    console.log(`🏎️ [AI] Ответ через ` + `${aiResult.model}:`);

    console.log(aiResponse);

    // ----------------------------------------------------
    // SAVE AI RESPONSE
    // ----------------------------------------------------

    addToHistory(GROUP_ID, "assistant", "Юсэм", aiResponse);

    // ----------------------------------------------------
    // TELEGRAM
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
// GLOBAL TELEGRAF ERROR
// ============================================================

bot.catch((error, ctx) => {
  console.error("❌ [TELEGRAF] Глобальная ошибка:", error);

  /*
   * Ошибки AI ловятся внутри handleAI().
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
      pool
        .end()
        .catch(() => {})
        .finally(() => {
          process.exit(1);
        });
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
