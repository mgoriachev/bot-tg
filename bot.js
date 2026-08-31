require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleGenAI } = require("@google/genai");
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

// Storage
const STORAGE_BUCKET = "character-photos";

// Embeddings
const EMBEDDING_MODEL = "gemini-embedding-2";

const EMBEDDING_DIMENSIONS = 1536;

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
// SUPABASE
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
// GEMINI CLIENTS
// ============================================================

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const genAIEmbeddings = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
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
// TEACHING
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
// IDENTIFY
// ============================================================

const identifySessions = new Map();

function getIdentifySession(userId) {
  return identifySessions.get(userId);
}

function setIdentifySession(userId, session) {
  identifySessions.set(userId, session);
}

function clearIdentifySession(userId) {
  identifySessions.delete(userId);
}

// ============================================================
// CHARACTER LORE
// ============================================================

async function getCharacterLore(searchText) {
  if (!searchText) {
    return [];
  }

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
// EMBEDDINGS
// ============================================================

async function generateImageEmbedding(buffer, mimeType = "image/jpeg") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Пустое изображение для embedding.");
  }

  console.log("🧬 [EMBEDDING] Генерируем embedding...");

  const base64 = buffer.toString("base64");

  const response = await genAIEmbeddings.models.embedContent({
    model: EMBEDDING_MODEL,

    contents: [
      {
        inlineData: {
          mimeType,
          data: base64,
        },
      },
    ],

    config: {
      outputDimensionality: EMBEDDING_DIMENSIONS,
    },
  });

  const embedding = response?.embeddings?.[0]?.values;

  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Некорректный embedding: ` +
        `${embedding?.length || 0} вместо ` +
        `${EMBEDDING_DIMENSIONS}`,
    );
  }

  console.log(`✅ [EMBEDDING] Получен вектор ${embedding.length}D`);

  return embedding;
}

function vectorToPg(vector) {
  return "[" + vector.join(",") + "]";
}

async function getPhotoBufferFromTelegram(telegram, fileId) {
  const telegramFile = await telegram.getFile(fileId);

  const filePath = telegramFile.file_path;

  if (!filePath) {
    throw new Error("Telegram не вернул file_path.");
  }

  const fileUrl =
    `https://api.telegram.org/file/bot` + `${BOT_TOKEN}/${filePath}`;

  const response = await fetch(fileUrl);

  if (!response.ok) {
    throw new Error(`Ошибка скачивания фото: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

async function saveEmbedding(photoId, embedding) {
  await pool.query(
    `
    UPDATE character_photos
    SET embedding = $1::extensions.vector
    WHERE id = $2
    `,
    [vectorToPg(embedding), photoId],
  );
}

async function matchCharacterPhotos(embedding, matchCount = 10) {
  const result = await pool.query(
    `
      SELECT
          cp.id,
          cp.character_id,
          cp.storage_path,
          cp.photo_number,
          c.name AS character_name,
          c.slug AS character_slug,
          1 - (cp.embedding <=> $1::extensions.vector)
              AS similarity

      FROM character_photos cp

      INNER JOIN characters c
          ON c.id = cp.character_id

      WHERE cp.embedding IS NOT NULL

      ORDER BY
          cp.embedding <=> $1::extensions.vector

      LIMIT $2
      `,
    [vectorToPg(embedding), matchCount],
  );

  return result.rows;
}

function groupSimilarityCandidates(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const similarity = Number(row.similarity);

    if (!grouped.has(row.character_id)) {
      grouped.set(row.character_id, {
        characterId: row.character_id,

        characterName: row.character_name,

        characterSlug: row.character_slug,

        bestSimilarity: similarity,

        photos: 1,
      });
    } else {
      const candidate = grouped.get(row.character_id);

      candidate.photos += 1;

      if (similarity > candidate.bestSimilarity) {
        candidate.bestSimilarity = similarity;
      }
    }
  }

  return Array.from(grouped.values()).sort(
    (a, b) => b.bestSimilarity - a.bestSimilarity,
  );
}

// ============================================================
// AI SETTINGS
// ============================================================

const RETRY_DELAY_MS = 1000;
const MODEL_TIMEOUT_MS = 20000;
const MODEL_COOLDOWN_MS = 60 * 1000;

const modelCooldowns = new Map();

// ============================================================
// TELEGRAM
// ============================================================

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 120000,
});

// ============================================================
// AI MODELS
// ============================================================

const aiModels = GEMINI_MODELS.map((modelName) => ({
  name: modelName,

  instance: genAI.getGenerativeModel({
    model: modelName,

    systemInstruction: SYSTEM_PROMPT,
  }),
}));

// ============================================================
// EXPRESS
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

    identifySessions: identifySessions.size,
  });
});

const server = app.listen(PORT, () => {
  console.log(`🌐 HTTP сервер запущен на порту ${PORT}`);
});

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
    if (isModelOnCooldown(model.name)) {
      console.log(`⏸️ [GEMINI] ${model.name} пропущена — cooldown`);

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

      // ------------------------------------------------------
      // 429
      // ------------------------------------------------------

      if (is429Error(error)) {
        putModelOnCooldown(model.name);

        console.log(
          `⏭️ [GEMINI] ${model.name} получила 429 — БЕЗ повторной попытки`,
        );

        continue;
      }

      // ------------------------------------------------------
      // TEMPORARY
      // ------------------------------------------------------

      if (isTemporaryGeminiError(error)) {
        console.log(`⏳ [GEMINI] Временная ошибка у ${model.name}`);

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
            `❌ [GEMINI] ${model.name} попытка 2:`,
            retryError.message,
          );

          if (isTemporaryGeminiError(retryError)) {
            putModelOnCooldown(model.name);
          }

          continue;
        }
      }

      console.log(`➡️ [GEMINI] Ошибка постоянная, следующая модель`);
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

  // ========================================================
  // /start
  // ========================================================

  if (command === "/start") {
    await ctx.reply(
      "🏎️ Юсэм онлайн.\n\n" +
        "/help — помощь\n" +
        "/clear — очистить память\n" +
        "/status — состояние\n" +
        "/characters — персонажи\n\n" +
        "/teach slug — добавить фото персонажа\n" +
        "/done — закончить обучение\n" +
        "/cancel — отменить обучение\n\n" +
        "/identify — найти похожего персонажа по фото\n" +
        "/reindex — создать embeddings для старых фото",
    );

    return true;
  }

  // ========================================================
  // /help
  // ========================================================

  if (command === "/help") {
    await ctx.reply(
      "🛠 Управление Юсэмом:\n\n" +
        "/clear — очистить память AI\n" +
        "/status — состояние бота\n" +
        "/characters — список персонажей\n\n" +
        "/teach slug — добавить фотографии персонажа\n" +
        "/done — завершить обучение\n" +
        "/cancel — отменить обучение\n\n" +
        "/identify — фото → похожий персонаж\n" +
        "/reindex — пересчитать embeddings старых фото\n\n" +
        "Обучение и identify работают только в этой личке.",
    );

    return true;
  }

  // ========================================================
  // /clear
  // ========================================================

  if (command === "/clear") {
    clearHistory(GROUP_ID);

    await ctx.reply("🧠 Память Юсэма очищена.");

    return true;
  }

  // ========================================================
  // /status
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
        `📚 Teach: ` +
        `${teachingSessions.size}\n` +
        `🔍 Identify: ` +
        `${identifySessions.size}\n\n` +
        `🤖 Gemini:\n` +
        modelStatus,
    );

    return true;
  }

  // ========================================================
  // /characters
  // ========================================================

  if (command === "/characters") {
    try {
      const result = await pool.query(
        `
          SELECT
              c.id,
              c.name,
              c.slug,

              COUNT(DISTINCT p.id)::int
                  AS photo_count,

              COUNT(DISTINCT l.id)::int
                  AS lore_count,

              COUNT(
                  DISTINCT
                  CASE
                      WHEN p.embedding IS NOT NULL
                      THEN p.id
                  END
              )::int
                  AS embedding_count

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

      const lines = result.rows.map((row) => {
        return (
          `${row.name}\n` +
          `  slug: ${row.slug}\n` +
          `  📷 Фото: ${row.photo_count}\n` +
          `  🧬 Embeddings: ${row.embedding_count}\n` +
          `  📚 Лор: ${row.lore_count}`
        );
      });

      await ctx.reply("👥 Персонажи:\n\n" + lines.join("\n\n"));

      return true;
    } catch (error) {
      console.error("❌ [CHARACTERS] Ошибка:", error.message);

      await ctx.reply("❌ Не удалось получить список персонажей.");

      return true;
    }
  }

  // ========================================================
  // /teach
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
          `❌ Персонаж "${slug}" не найден.\n\n` + `Используй /characters.`,
        );

        return true;
      }

      const character = result.rows[0];

      clearTeachingSession(ctx.from.id);

      clearIdentifySession(ctx.from.id);

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
  // /identify
  // ========================================================

  if (command === "/identify") {
    clearTeachingSession(ctx.from.id);

    clearIdentifySession(ctx.from.id);

    setIdentifySession(ctx.from.id, {
      photo: null,
    });

    await ctx.reply(
      "🔍 Режим поиска похожего персонажа.\n\n" +
        "Отправь одну фотографию.\n\n" +
        "После этого я сравню её " +
        "с подтверждёнными фотографиями из базы " +
        "и покажу наиболее похожих персонажей.\n\n" +
        "Отменить — /cancel",
    );

    console.log("🔍 [IDENTIFY] Режим запущен");

    return true;
  }

  // ========================================================
  // /reindex
  // ========================================================

  if (command === "/reindex") {
    console.log("🧪 [REINDEX] Команда получена");

    console.log("🧪 [REINDEX] Отправляем подтверждение");

    await ctx.telegram.sendMessage(
      ctx.chat.id,
      "🧬 Начинаю пересчёт embeddings старых фотографий...",
    );

    console.log("🧪 [REINDEX] Подтверждение отправлено");

    try {
      const result = await pool.query(
        `
          SELECT
              cp.id,
              cp.telegram_file_id,
              cp.character_id,
              c.name,
              c.slug
          FROM character_photos cp
          INNER JOIN characters c
              ON c.id = cp.character_id
          WHERE cp.embedding IS NULL
          ORDER BY cp.id
          `,
      );

      if (!result.rows.length) {
        await ctx.reply("✅ Все фотографии уже имеют embeddings.");

        return true;
      }

      let processed = 0;

      for (const row of result.rows) {
        try {
          console.log(`🧬 [REINDEX] ` + `${row.id}: ${row.name}`);

          const buffer = await getPhotoBufferFromTelegram(
            ctx.telegram,
            row.telegram_file_id,
          );

          const embedding = await generateImageEmbedding(buffer);

          await saveEmbedding(row.id, embedding);

          processed++;

          console.log(`✅ [REINDEX] ` + `Фото ${row.id} готово`);
        } catch (photoError) {
          console.error(`❌ [REINDEX] Фото ${row.id}:`, photoError.message);
        }
      }

      await ctx.reply(
        `✅ Reindex завершён.\n\n` +
          `Обработано: ${processed} из ` +
          `${result.rows.length}`,
      );
    } catch (error) {
      console.error("❌ [REINDEX] Ошибка:", error);

      await ctx.reply(
        `❌ Reindex завершился с ошибкой.\n\n` + `${error.message}`,
      );
    }

    return true;
  }

  // ========================================================
  // /cancel
  // ========================================================

  if (command === "/cancel") {
    const teaching = getTeachingSession(ctx.from.id);

    const identifying = getIdentifySession(ctx.from.id);

    if (!teaching && !identifying) {
      await ctx.reply("ℹ️ Активных сессий нет.");

      return true;
    }

    if (teaching) {
      clearTeachingSession(ctx.from.id);

      await ctx.reply(
        `❌ Обучение персонажа ` + `${teaching.characterName} отменено.`,
      );
    }

    if (identifying) {
      clearIdentifySession(ctx.from.id);

      await ctx.reply("❌ Режим identify отменён.");
    }

    return true;
  }

  // ========================================================
  // /done
  // ========================================================

  if (command === "/done") {
    const session = getTeachingSession(ctx.from.id);

    if (!session) {
      await ctx.reply("ℹ️ Активной teach-сессии нет.");

      return true;
    }

    if (!session.photos.length) {
      await ctx.reply("📷 Сначала отправь хотя бы одно фото.");

      return true;
    }

    await ctx.reply(
      `⏳ Сохраняю ` +
        `${session.photos.length} фото ` +
        `персонажа ${session.characterName}...`,
    );

    let savedCount = 0;
    let embeddingCount = 0;

    try {
      for (let index = 0; index < session.photos.length; index++) {
        const photo = session.photos[index];

        const photoNumber = index + 1;

        console.log(
          `📷 [TEACH] ` +
            `Обрабатываем фото ` +
            `${photoNumber}/` +
            `${session.photos.length}`,
        );

        const buffer = await getPhotoBufferFromTelegram(
          ctx.telegram,
          photo.fileId,
        );

        // ----------------------------------------------
        // Storage
        // ----------------------------------------------

        const storagePath =
          `${session.characterSlug}/` + `${Date.now()}-` + `${photoNumber}.jpg`;

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(
            storagePath,

            buffer,

            {
              contentType: "image/jpeg",

              upsert: false,
            },
          );

        if (uploadError) {
          throw new Error(
            `Ошибка Storage для фото #` +
              `${photoNumber}: ` +
              `${uploadError.message}`,
          );
        }

        // ----------------------------------------------
        // Embedding
        // ----------------------------------------------

        let embedding = null;

        try {
          embedding = await generateImageEmbedding(buffer);
        } catch (embeddingError) {
          console.error(
            `⚠️ [TEACH] Embedding фото #` + `${photoNumber} не создан:`,
            embeddingError.message,
          );
        }

        // ----------------------------------------------
        // Database
        // ----------------------------------------------

        const insertResult = await pool.query(
          `
            INSERT INTO character_photos (
                character_id,
                storage_path,
                telegram_file_id,
                photo_number,
                embedding
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5::extensions.vector
            )

            RETURNING id
            `,

          [
            session.characterId,

            storagePath,

            photo.fileId,

            photoNumber,

            embedding ? vectorToPg(embedding) : null,
          ],
        );

        savedCount++;

        if (embedding) {
          embeddingCount++;
        }

        console.log(
          `✅ [TEACH] Фото #` +
            `${photoNumber} сохранено, ` +
            `DB ID=${insertResult.rows[0].id}`,
        );
      }

      clearTeachingSession(ctx.from.id);

      await ctx.reply(
        `✅ Обучение завершено.\n\n` +
          `Персонаж: ` +
          `${session.characterName}\n` +
          `📷 Фото: ${savedCount}\n` +
          `🧬 Embeddings: ` +
          `${embeddingCount}`,
      );
    } catch (error) {
      console.error("❌ [TEACH] Ошибка:", error);

      await ctx.reply(
        `❌ Ошибка обучения.\n\n` +
          `Сохранено: ${savedCount} из ` +
          `${session.photos.length}\n` +
          `Embeddings: ${embeddingCount}\n\n` +
          `${error.message}`,
      );
    }

    return true;
  }

  return true;
}

// ============================================================
// PHOTO HANDLER
// ============================================================

bot.on("photo", async (ctx) => {
  try {
    if (!isOwnerPrivate(ctx)) {
      return;
    }

    // ======================================================
    // IDENTIFY
    // ======================================================

    const identifySession = getIdentifySession(ctx.from.id);

    if (identifySession) {
      const photos = ctx.message?.photo;

      if (!Array.isArray(photos) || !photos.length) {
        return;
      }

      const largestPhoto = photos[photos.length - 1];

      if (!largestPhoto?.file_id) {
        return;
      }

      identifySession.photo = {
        fileId: largestPhoto.file_id,

        width: largestPhoto.width,

        height: largestPhoto.height,
      };

      console.log("🔍 [IDENTIFY] Фото получено");

      await ctx.reply("🧬 Сравниваю фото с базой...");

      // ----------------------------------------------
      // Download
      // ----------------------------------------------

      const buffer = await getPhotoBufferFromTelegram(
        ctx.telegram,
        largestPhoto.file_id,
      );

      // ----------------------------------------------
      // Embedding
      // ----------------------------------------------

      const embedding = await generateImageEmbedding(buffer);

      // ----------------------------------------------
      // Similarity search
      // ----------------------------------------------

      const matches = await matchCharacterPhotos(embedding, 10);

      const candidates = groupSimilarityCandidates(matches);

      clearIdentifySession(ctx.from.id);

      if (!candidates.length) {
        await ctx.reply(
          "🤷 Похожих фотографий пока нет.\n\n" +
            "Сначала добавь фотографии персонажей " +
            "через /teach.",
        );

        return;
      }

      // ----------------------------------------------
      // Build buttons
      // ----------------------------------------------

      const topCandidates = candidates.slice(0, 8);

      const buttons = topCandidates.map((candidate) => {
        const similarity = Math.round(candidate.bestSimilarity * 100);

        return [
          Markup.button.callback(
            `${candidate.characterName} ` + `(${similarity}%)`,

            `identify-confirm:${candidate.characterId}`,
          ),
        ];
      });

      buttons.push([
        Markup.button.callback("❌ Отмена", "identify-confirm:cancel"),
      ]);

      const best = topCandidates[0];

      const bestPercent = Math.round(best.bestSimilarity * 100);

      await ctx.reply(
        `🔍 Наиболее похожий кандидат: ` +
          `${best.characterName} ` +
          `(${bestPercent}%)\n\n` +
          `Выбери персонажа, к которому ` +
          `привязать это фото:`,

        Markup.inlineKeyboard(buttons),
      );

      console.log(`🔍 [IDENTIFY] ` + `Кандидатов: ${topCandidates.length}`);

      topCandidates.forEach((candidate) => {
        console.log(
          `   → ` +
            `${candidate.characterName}: ` +
            `${candidate.bestSimilarity}`,
        );
      });

      /*
       * Сохраняем фото временно,
       * чтобы callback мог его записать.
       *
       * После generate embedding
       * кладём его обратно в identify session.
       */

      setIdentifySession(ctx.from.id, {
        photo: {
          fileId: largestPhoto.file_id,

          width: largestPhoto.width,

          height: largestPhoto.height,
        },
      });

      return;
    }

    // ======================================================
    // TEACH
    // ======================================================

    const session = getTeachingSession(ctx.from.id);

    if (!session) {
      return;
    }

    const photos = ctx.message?.photo;

    if (!Array.isArray(photos) || !photos.length) {
      return;
    }

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
        `Отправь ещё фото или /done`,
    );
  } catch (error) {
    console.error("❌ [PHOTO] Ошибка:", error);

    await ctx.reply(
      `❌ Не удалось обработать фотографию.\n\n` + `${error.message}`,
    );
  }
});

// ============================================================
// IDENTIFY CALLBACK
// ============================================================

bot.action(/^identify-confirm:(.+)$/i, async (ctx) => {
  try {
    if (ctx.from?.id !== MY_ID) {
      await ctx.answerCbQuery("Нет доступа.");

      return;
    }

    const action = ctx.match[1];

    // ------------------------------------------------------
    // Cancel
    // ------------------------------------------------------

    if (action === "cancel") {
      clearIdentifySession(ctx.from.id);

      await ctx.answerCbQuery("Отменено.");

      try {
        await ctx.editMessageText("❌ Фото не привязано.");
      } catch (_) {}

      return;
    }

    const characterId = Number(action);

    if (!Number.isInteger(characterId)) {
      await ctx.answerCbQuery("Некорректный персонаж.");

      return;
    }

    const session = getIdentifySession(ctx.from.id);

    if (!session?.photo?.fileId) {
      await ctx.answerCbQuery("Сессия уже закончена.");

      return;
    }

    // ------------------------------------------------------
    // Character
    // ------------------------------------------------------

    const characterResult = await pool.query(
      `
          SELECT
              id,
              slug,
              name

          FROM characters

          WHERE id = $1

          LIMIT 1
          `,

      [characterId],
    );

    if (!characterResult.rows.length) {
      await ctx.answerCbQuery("Персонаж не найден.");

      return;
    }

    const character = characterResult.rows[0];

    // ------------------------------------------------------
    // Next number
    // ------------------------------------------------------

    const countResult = await pool.query(
      `
          SELECT
              COALESCE(
                  MAX(photo_number),
                  0
              ) + 1 AS next_number

          FROM character_photos

          WHERE character_id = $1
          `,

      [character.id],
    );

    const photoNumber = Number(countResult.rows[0].next_number);

    await ctx.answerCbQuery("Сохраняю...");

    // ------------------------------------------------------
    // Download
    // ------------------------------------------------------

    const buffer = await getPhotoBufferFromTelegram(
      ctx.telegram,
      session.photo.fileId,
    );

    // ------------------------------------------------------
    // Embedding
    // ------------------------------------------------------

    const embedding = await generateImageEmbedding(buffer);

    // ------------------------------------------------------
    // Storage
    // ------------------------------------------------------

    const storagePath =
      `${character.slug}/` + `${Date.now()}-` + `${photoNumber}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(
        storagePath,

        buffer,

        {
          contentType: "image/jpeg",

          upsert: false,
        },
      );

    if (uploadError) {
      throw new Error(`Ошибка Storage: ` + `${uploadError.message}`);
    }

    // ------------------------------------------------------
    // DB
    // ------------------------------------------------------

    await pool.query(
      `
        INSERT INTO character_photos (
            character_id,
            storage_path,
            telegram_file_id,
            photo_number,
            embedding
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5::extensions.vector
        )
        `,

      [
        character.id,

        storagePath,

        session.photo.fileId,

        photoNumber,

        vectorToPg(embedding),
      ],
    );

    clearIdentifySession(ctx.from.id);

    try {
      await ctx.editMessageText(
        `✅ Фото привязано.\n\n` +
          `Персонаж: ` +
          `${character.name}\n` +
          `📷 Номер фото: ` +
          `${photoNumber}\n` +
          `🧬 Embedding: ` +
          `${EMBEDDING_DIMENSIONS}D\n` +
          `📁 ${storagePath}`,
      );
    } catch (_) {
      await ctx.reply(`✅ Фото привязано к ` + `${character.name}.`);
    }
  } catch (error) {
    console.error("❌ [IDENTIFY CALLBACK] Ошибка:", error);

    try {
      await ctx.answerCbQuery("Ошибка сохранения.");
    } catch (_) {}

    try {
      await ctx.reply(`❌ Не удалось сохранить фото.\n\n` + `${error.message}`);
    } catch (_) {}
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

    // =====================================================
    // OWNER PRIVATE
    // =====================================================

    if (isOwnerPrivate(ctx)) {
      console.log("👤 [ROUTER] Сообщение владельца");

      const commandHandled = await handleOwnerCommand(ctx);

      if (commandHandled) {
        return;
      }

      await sendOwnerMessageToGroup(ctx);

      return;
    }

    // =====================================================
    // GROUP
    // =====================================================

    if (isGroupMessage(ctx)) {
      console.log("👥 [ROUTER] Сообщение группы");

      await sendRadarMessage(ctx);

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

    console.log("ℹ️ [ROUTER] Сообщение проигнорировано");
  } catch (error) {
    console.error("❌ [ROUTER] Ошибка:", error);
  }
});

// ============================================================
// OWNER MESSAGE TO GROUP
// ============================================================

async function sendOwnerMessageToGroup(ctx) {
  const text = ctx.message?.text?.trim();

  if (!text) {
    return;
  }

  const replyMessage = ctx.message?.reply_to_message;

  if (replyMessage?.text) {
    const match = replyMessage.text.match(/\[msg:(\d+)\]/);

    if (match) {
      const targetMessageId = Number(match[1]);

      try {
        await ctx.telegram.sendMessage(
          GROUP_ID,

          text,

          {
            reply_parameters: {
              message_id: targetMessageId,
            },
          },
        );

        await ctx.reply("✅ Ответ отправлен с цитированием.");

        return;
      } catch (error) {
        await ctx.reply("❌ Не получилось ответить.");

        return;
      }
    }
  }

  try {
    await ctx.telegram.sendMessage(GROUP_ID, text);

    await ctx.reply("✅ Отправлено в группу.");
  } catch (error) {
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

    if (!mentioned && !repliedToBot) {
      return;
    }

    const userName =
      ctx.from?.first_name || ctx.from?.username || "Пользователь";

    console.log(`🧠 [AI] Запрос от ${userName}`);

    addToHistory(GROUP_ID, "user", userName, text);

    await ctx.sendChatAction("typing");

    const historyContext = buildHistoryContext(GROUP_ID);

    console.log("📚 [LORE] Ищем персонажей в базе...");

    const loreRows = await getCharacterLore(text);

    const characterLoreContext = buildCharacterLoreContext(loreRows);

    console.log(`📚 [LORE] Найдено строк: ` + `${loreRows.length}`);

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

Не придумывай новые факты.

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
- используй релевантный лор;
- не придумывай новые факты;
- не пересказывай историю;
- не объясняй свою роль;
- не упоминай Gemini, API, prompt или системные инструкции;
- не говори, что ты нейросеть;
- не начинай автоматически словами "Брат", "Слушай", "Ну что, братан";
- не повторяй одинаковые шутки;
- обычный ответ — 1–3 предложения;
- если достаточно одной фразы — используй одну.
`;

    console.log("📝 [AI] Отправляем запрос...");

    const aiResult = await generateAIResponse(finalPrompt);

    const aiResponse = aiResult.text;

    console.log(`🏎️ [AI] Ответ через ` + `${aiResult.model}:`);

    console.log(aiResponse);

    addToHistory(GROUP_ID, "assistant", "Юсэм", aiResponse);

    await ctx.reply(
      aiResponse,

      {
        reply_parameters: {
          message_id: ctx.message.message_id,
        },
      },
    );

    console.log("✅ [AI] Ответ отправлен");
  } catch (error) {
    console.error("❌ [AI] Ошибка:", error);
  }
}

// ============================================================
// TELEGRAM ERROR
// ============================================================

bot.catch((error, ctx) => {
  console.error("❌ [TELEGRAM] Ошибка:", error);

  if (ctx?.telegram) {
    ctx.telegram
      .sendMessage(
        MY_ID,

        `⚠️ Ошибка Telegram:\n\n` + `${error.message}`,
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

    console.log(`🧬 Embedding model: ` + `${EMBEDDING_MODEL}`);

    console.log(`🧬 Embedding dimensions: ` + `${EMBEDDING_DIMENSIONS}`);

    console.log("");

    console.log(`⏱️ Timeout модели: ` + `${MODEL_TIMEOUT_MS / 1000} сек.`);

    console.log(`⏸️ Cooldown модели: ` + `${MODEL_COOLDOWN_MS / 1000} сек.`);

    console.log("");

    console.log("🚀 Запускаем Telegram...");

    await bot.launch();

    console.log("✅ Telegram bot запущен");

    console.log("========================================");
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
// SHUTDOWN
// ============================================================

function shutdown(signal) {
  console.log(`🛑 Получен ${signal}. ` + `Останавливаем бота...`);

  try {
    bot.stop(signal);
  } catch (error) {
    console.error("⚠️ Ошибка остановки Telegraf:", error.message);
  }

  server.close(() => {
    pool
      .end()
      .catch(() => {})
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
