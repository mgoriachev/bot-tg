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
const PORT = Number(process.env.PORT) || 10000;

const PUBLIC_DOMAIN =
  process.env.RENDER_EXTERNAL_HOSTNAME || process.env.PUBLIC_DOMAIN;

if (!PUBLIC_DOMAIN) {
  console.error("❌ Не найден публичный домен Render.");

  process.exit(1);
}

// Telegram webhook
const WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

// Storage
const STORAGE_BUCKET = "character-photos";

// Embeddings
const EMBEDDING_MODEL = "gemini-embedding-2";

const EMBEDDING_DIMENSIONS = 1536;

// Group visual similarity thresholds
const IDENTIFY_LOW_THRESHOLD = 0.7;

const IDENTIFY_HIGH_THRESHOLD = 0.9;

const IDENTIFY_MIN_GAP = 0.08;

// AI
const MODEL_TIMEOUT_MS = 20000;

const MODEL_COOLDOWN_MS = 60000;

const RETRY_DELAY_MS = 1000;

// Memory
const MAX_HISTORY = 20;

const MAX_CONTEXT_CHARS = 12000;

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

    const exists = data.some((bucket) => bucket.name === STORAGE_BUCKET);

    if (!exists) {
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
// TELEGRAM BOT
// ============================================================

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 120000,
});

// Для webhook не используем
// ответ Telegram webhook напрямую.
bot.telegram.webhookReply = false;

// ============================================================
// MEMORY
// ============================================================

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
  const normalized = text.toLowerCase();

  return normalized.includes("юсэм") || normalized.includes("юмак");
}

function isReplyToBot(ctx) {
  const reply = ctx.message?.reply_to_message;

  if (!reply) {
    return false;
  }

  return (
    Boolean(reply.from?.id) &&
    Boolean(ctx.botInfo?.id) &&
    reply.from.id === ctx.botInfo.id
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ============================================================
// LORE
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
    console.error("❌ [LORE] Ошибка:", error.message);

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
// TELEGRAM FILES
// ============================================================

async function getTelegramFileBuffer(telegram, fileId) {
  const file = await telegram.getFile(fileId);

  if (!file?.file_path) {
    throw new Error("Telegram не вернул file_path.");
  }

  const url =
    `https://api.telegram.org/file/bot` + `${BOT_TOKEN}/${file.file_path}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Ошибка скачивания файла: HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// ============================================================
// EMBEDDINGS
// ============================================================

async function generateImageEmbedding(buffer, mimeType = "image/jpeg") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Пустое изображение.");
  }

  console.log("🧬 [EMBEDDING] Генерируем embedding...");

  const response = await genAIEmbeddings.models.embedContent({
    model: EMBEDDING_MODEL,

    contents: [
      {
        inlineData: {
          mimeType,

          data: buffer.toString("base64"),
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
        `${embedding?.length || 0} ` +
        `вместо ${EMBEDDING_DIMENSIONS}`,
    );
  }

  console.log(`✅ [EMBEDDING] Получен вектор ${embedding.length}D`);

  return embedding;
}

function vectorToPg(vector) {
  return "[" + vector.join(",") + "]";
}

async function saveEmbedding(photoId, embedding) {
  await pool.query(
    `
    UPDATE character_photos

    SET embedding =
        $1::extensions.vector

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

          1 - (
              cp.embedding
              <=>
              $1::extensions.vector
          ) AS similarity

      FROM character_photos cp

      INNER JOIN characters c
          ON c.id = cp.character_id

      WHERE cp.embedding IS NOT NULL

      ORDER BY
          cp.embedding
          <=>
          $1::extensions.vector

      LIMIT $2
      `,

    [vectorToPg(embedding), matchCount],
  );

  return result.rows;
}

function groupSimilarityCandidates(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const similarity = Number(row.similarity) || 0;

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

      candidate.photos++;

      if (similarity > candidate.bestSimilarity) {
        candidate.bestSimilarity = similarity;
      }
    }
  }

  return Array.from(grouped.values()).sort(
    (a, b) => b.bestSimilarity - a.bestSimilarity,
  );
}

function getGroupVisualResult(candidates) {
  if (!candidates.length) {
    return {
      level: "unknown",

      candidate: null,
    };
  }

  const best = candidates[0];

  const second = candidates[1];

  const bestSimilarity = Number(best.bestSimilarity) || 0;

  const secondSimilarity = second ? Number(second.bestSimilarity) || 0 : 0;

  const gap = bestSimilarity - secondSimilarity;

  if (bestSimilarity < IDENTIFY_LOW_THRESHOLD) {
    return {
      level: "unknown",

      candidate: best,
    };
  }

  if (
    second &&
    gap < IDENTIFY_MIN_GAP &&
    bestSimilarity < IDENTIFY_HIGH_THRESHOLD
  ) {
    return {
      level: "unknown",

      candidate: best,
    };
  }

  if (bestSimilarity >= IDENTIFY_HIGH_THRESHOLD) {
    return {
      level: "high",

      candidate: best,
    };
  }

  return {
    level: "medium",

    candidate: best,
  };
}

// ============================================================
// MODEL COOLDOWN
// ============================================================

const modelCooldowns = new Map();

function isModelOnCooldown(modelName) {
  const until = modelCooldowns.get(modelName);

  if (!until) {
    return false;
  }

  if (Date.now() >= until) {
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

function withTimeout(promise, timeoutMs, message) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([
    promise.finally(() => {
      clearTimeout(timer);
    }),

    timeoutPromise,
  ]);
}

// ============================================================
// GEMINI FALLBACK
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

const aiModels = GEMINI_MODELS.map((modelName) => ({
  name: modelName,

  instance: genAI.getGenerativeModel({
    model: modelName,

    systemInstruction: SYSTEM_PROMPT,
  }),
}));

async function generateAIResponse(prompt) {
  let lastError = null;

  for (const model of aiModels) {
    if (isModelOnCooldown(model.name)) {
      console.log(`⏸️ [GEMINI] ${model.name} cooldown`);

      continue;
    }

    console.log(`🤖 [GEMINI] Пробуем ${model.name}`);

    try {
      const result = await withTimeout(
        model.instance.generateContent(prompt),

        MODEL_TIMEOUT_MS,

        `Timeout ${MODEL_TIMEOUT_MS}ms: ${model.name}`,
      );

      const text = result?.response?.text?.()?.trim();

      if (!text) {
        throw new Error("Gemini вернул пустой ответ.");
      }

      console.log(`✅ [GEMINI] Ответ через ${model.name}`);

      return {
        text,

        model: model.name,
      };
    } catch (error) {
      lastError = error;

      console.error(`❌ [GEMINI] ${model.name}:`, error.message);

      if (is429Error(error)) {
        putModelOnCooldown(model.name);

        continue;
      }

      if (isTemporaryGeminiError(error)) {
        await sleep(RETRY_DELAY_MS);

        try {
          const retry = await withTimeout(
            model.instance.generateContent(prompt),

            MODEL_TIMEOUT_MS,

            `Timeout ${MODEL_TIMEOUT_MS}ms: ${model.name}`,
          );

          const retryText = retry?.response?.text?.()?.trim();

          if (!retryText) {
            throw new Error("Gemini вернул пустой ответ.");
          }

          return {
            text: retryText,

            model: model.name,
          };
        } catch (retryError) {
          lastError = retryError;

          if (isTemporaryGeminiError(retryError)) {
            putModelOnCooldown(model.name);
          }
        }
      }
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

  const name = ctx.from?.first_name || ctx.from?.username || "Пользователь";

  const username = ctx.from?.username ? `@${ctx.from.username}` : "";

  const message =
    `💬 ${name} ${username}\n\n` +
    `${ctx.message.text}\n\n` +
    `📌 [group:${GROUP_ID}]\n` +
    `🆔 [msg:${ctx.message.message_id}]`;

  try {
    await ctx.telegram.sendMessage(MY_ID, message);

    console.log(`📡 [RADAR] msg=${ctx.message.message_id} → owner`);
  } catch (error) {
    console.error("❌ [RADAR]", error.message);
  }
}

// ============================================================
// SAVE PHOTO
// ============================================================

async function saveCharacterPhoto({
  telegram,
  fileId,
  characterId,
  characterSlug,
  photoNumber,
  buffer,
  embedding,
}) {
  const photoBuffer = buffer || (await getTelegramFileBuffer(telegram, fileId));

  const storagePath =
    `${characterSlug}/` + `${Date.now()}-` + `${photoNumber}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, photoBuffer, {
      contentType: "image/jpeg",

      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Storage: ${uploadError.message}`);
  }

  const result = await pool.query(
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
      characterId,

      storagePath,

      fileId,

      photoNumber,

      embedding ? vectorToPg(embedding) : null,
    ],
  );

  return {
    id: result.rows[0].id,

    storagePath,
  };
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

  // ==========================================================
  // /start
  // ==========================================================

  if (command === "/start") {
    await ctx.reply(
      "🏎️ Юсэм онлайн.\n\n" +
        "/help\n" +
        "/status\n" +
        "/characters\n" +
        "/clear\n\n" +
        "/teach slug\n" +
        "/done\n" +
        "/cancel\n" +
        "/identify\n" +
        "/reindex",
    );

    return true;
  }

  // ==========================================================
  // /help
  // ==========================================================

  if (command === "/help") {
    await ctx.reply(
      "🛠 Управление:\n\n" +
        "/status — состояние\n" +
        "/characters — персонажи\n" +
        "/clear — очистить память\n\n" +
        "/teach slug — эталонные фото\n" +
        "/done — завершить обучение\n" +
        "/cancel — отменить\n\n" +
        "/identify — поиск + ручное подтверждение\n" +
        "/reindex — embeddings старых фото",
    );

    return true;
  }

  // ==========================================================
  // /clear
  // ==========================================================

  if (command === "/clear") {
    clearHistory(GROUP_ID);

    await ctx.reply("🧠 Память очищена.");

    return true;
  }

  // ==========================================================
  // /status
  // ==========================================================

  if (command === "/status") {
    const models = GEMINI_MODELS.map(
      (model, index) =>
        `${index + 1}. ${model} ` + `${isModelOnCooldown(model) ? "⏸️" : "✅"}`,
    ).join("\n");

    await ctx.reply(
      `🟢 Юсэм работает\n\n` +
        `🌐 Webhook:\n` +
        `https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}\n\n` +
        `⏱ Uptime: ` +
        `${Math.floor(process.uptime())} сек.\n` +
        `🧠 Память: ` +
        `${getHistory(GROUP_ID).length}\n` +
        `📚 Teach: ` +
        `${teachingSessions.size}\n` +
        `🔍 Identify: ` +
        `${identifySessions.size}\n\n` +
        `🤖 Gemini:\n` +
        models,
    );

    return true;
  }

  // ==========================================================
  // /characters
  // ==========================================================

  if (command === "/characters") {
    try {
      const result = await pool.query(
        `
          SELECT
              c.id,
              c.name,
              c.slug,

              COUNT(
                DISTINCT p.id
              )::int AS photo_count,

              COUNT(
                DISTINCT l.id
              )::int AS lore_count,

              COUNT(
                DISTINCT CASE
                  WHEN p.embedding IS NOT NULL
                  THEN p.id
                END
              )::int AS embedding_count

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

      const lines = result.rows.map(
        (row) =>
          `${row.name}\n` +
          `  slug: ${row.slug}\n` +
          `  📷 Фото: ${row.photo_count}\n` +
          `  🧬 Embeddings: ${row.embedding_count}\n` +
          `  📚 Лор: ${row.lore_count}`,
      );

      await ctx.reply("👥 Персонажи:\n\n" + lines.join("\n\n"));
    } catch (error) {
      console.error("❌ [CHARACTERS]", error.message);

      await ctx.reply("❌ Не удалось получить персонажей.");
    }

    return true;
  }

  // ==========================================================
  // /teach
  // ==========================================================

  if (command === "/teach") {
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
      await ctx.reply("📷 Например: /teach essem");

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
        await ctx.reply(`❌ Персонаж "${slug}" не найден.`);

        return true;
      }

      const character = result.rows[0];

      clearIdentifySession(ctx.from.id);

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
    } catch (error) {
      console.error("❌ [TEACH]", error);

      await ctx.reply("❌ Не удалось начать обучение.");
    }

    return true;
  }

  // ==========================================================
  // /identify
  // ==========================================================

  if (command === "/identify") {
    clearTeachingSession(ctx.from.id);

    clearIdentifySession(ctx.from.id);

    setIdentifySession(ctx.from.id, {
      photo: null,
    });

    await ctx.reply(
      "🔍 Пришли фотографию.\n\n" +
        "Я сравню её с сохранёнными примерами " +
        "и предложу варианты.\n\n" +
        "/cancel — отменить",
    );

    console.log("🔍 [IDENTIFY] Запущен");

    return true;
  }

  // ==========================================================
  // /reindex
  // ==========================================================

  if (command === "/reindex") {
    console.log("🧪 [REINDEX] Команда получена");

    await ctx.telegram.sendMessage(
      ctx.chat.id,

      "🧬 Начинаю пересчёт embeddings старых фотографий...",
    );

    try {
      const result = await pool.query(
        `
          SELECT
              cp.id,
              cp.telegram_file_id,
              c.name

          FROM character_photos cp

          INNER JOIN characters c
              ON c.id = cp.character_id

          WHERE
              cp.embedding IS NULL

          ORDER BY
              cp.id
          `,
      );

      if (!result.rows.length) {
        await ctx.reply("✅ Все фотографии уже имеют embeddings.");

        return true;
      }

      let processed = 0;

      for (const row of result.rows) {
        try {
          console.log(`🧬 [REINDEX] ${row.id}: ${row.name}`);

          const buffer = await getTelegramFileBuffer(
            ctx.telegram,
            row.telegram_file_id,
          );

          const embedding = await generateImageEmbedding(buffer);

          await saveEmbedding(row.id, embedding);

          processed++;

          console.log(`✅ [REINDEX] Фото ${row.id} готово`);
        } catch (error) {
          console.error(`❌ [REINDEX] Фото ${row.id}:`, error.message);
        }
      }

      await ctx.reply(
        `✅ Reindex завершён.\n\n` +
          `Обработано: ` +
          `${processed} из ` +
          `${result.rows.length}`,
      );
    } catch (error) {
      console.error("❌ [REINDEX]", error);

      await ctx.reply(`❌ Reindex ошибка:\n` + `${error.message}`);
    }

    return true;
  }

  // ==========================================================
  // /cancel
  // ==========================================================

  if (command === "/cancel") {
    const teaching = getTeachingSession(ctx.from.id);

    const identifying = getIdentifySession(ctx.from.id);

    if (teaching) {
      clearTeachingSession(ctx.from.id);

      await ctx.reply("❌ Обучение отменено.");
    }

    if (identifying) {
      clearIdentifySession(ctx.from.id);

      await ctx.reply("❌ Identify отменён.");
    }

    if (!teaching && !identifying) {
      await ctx.reply("ℹ️ Активных сессий нет.");
    }

    return true;
  }

  // ==========================================================
  // /done
  // ==========================================================

  if (command === "/done") {
    const session = getTeachingSession(ctx.from.id);

    if (!session) {
      await ctx.reply("ℹ️ Нет активной teach-сессии.");

      return true;
    }

    if (!session.photos.length) {
      await ctx.reply("📷 Сначала отправь хотя бы одно фото.");

      return true;
    }

    await ctx.reply(`⏳ Сохраняю ${session.photos.length} фото...`);

    let savedCount = 0;

    let embeddingCount = 0;

    try {
      for (let index = 0; index < session.photos.length; index++) {
        const photo = session.photos[index];

        const photoNumber = index + 1;

        console.log(`📷 [TEACH] Фото ${photoNumber}`);

        const buffer = await getTelegramFileBuffer(ctx.telegram, photo.fileId);

        let embedding = null;

        try {
          embedding = await generateImageEmbedding(buffer);
        } catch (error) {
          console.error(`⚠️ [TEACH] Embedding #${photoNumber}:`, error.message);
        }

        await saveCharacterPhoto({
          telegram: ctx.telegram,

          fileId: photo.fileId,

          characterId: session.characterId,

          characterSlug: session.characterSlug,

          photoNumber,

          buffer,

          embedding,
        });

        savedCount++;

        if (embedding) {
          embeddingCount++;
        }
      }

      clearTeachingSession(ctx.from.id);

      await ctx.reply(
        `✅ Обучение завершено.\n\n` +
          `Персонаж: ${session.characterName}\n` +
          `📷 Фото: ${savedCount}\n` +
          `🧬 Embeddings: ${embeddingCount}`,
      );
    } catch (error) {
      console.error("❌ [DONE]", error);

      await ctx.reply(`❌ Ошибка:\n${error.message}`);
    }

    return true;
  }

  return true;
}

// ============================================================
// PRIVATE PHOTO
// ============================================================

async function handlePrivatePhoto(ctx) {
  const identifySession = getIdentifySession(ctx.from.id);

  // ==========================================================
  // IDENTIFY
  // ==========================================================

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

    await ctx.reply("🧬 Сравниваю фото с базой...");

    try {
      const buffer = await getTelegramFileBuffer(
        ctx.telegram,
        largestPhoto.file_id,
      );

      const embedding = await generateImageEmbedding(buffer);

      const matches = await matchCharacterPhotos(embedding, 10);

      const candidates = groupSimilarityCandidates(matches);

      if (!candidates.length) {
        clearIdentifySession(ctx.from.id);

        await ctx.reply("🤷 Похожих подтверждённых примеров пока нет.");

        return;
      }

      const buttons = candidates.slice(0, 8).map((candidate) => [
        Markup.button.callback(
          candidate.characterName,

          `identify-confirm:${candidate.characterId}`,
        ),
      ]);

      buttons.push([
        Markup.button.callback("❌ Отмена", "identify-confirm:cancel"),
      ]);

      setIdentifySession(ctx.from.id, {
        photo: {
          fileId: largestPhoto.file_id,

          width: largestPhoto.width,

          height: largestPhoto.height,
        },
      });

      await ctx.reply(
        "🔍 Нашёл похожие варианты.\n\n" + "Выбери правильного персонажа:",

        Markup.inlineKeyboard(buttons),
      );
    } catch (error) {
      clearIdentifySession(ctx.from.id);

      console.error("❌ [IDENTIFY]", error);

      await ctx.reply(`❌ Не удалось сравнить фото.\n${error.message}`);
    }

    return;
  }

  // ==========================================================
  // TEACH
  // ==========================================================

  const teachingSession = getTeachingSession(ctx.from.id);

  if (!teachingSession) {
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

  teachingSession.photos.push({
    fileId: largestPhoto.file_id,

    width: largestPhoto.width,

    height: largestPhoto.height,
  });

  await ctx.reply(
    `📷 Фото №${teachingSession.photos.length} получено.\n` +
      `Персонаж: ${teachingSession.characterName}\n\n` +
      `Ещё фото или /done`,
  );
}

// ============================================================
// GROUP PHOTO
// ============================================================

async function handleGroupPhoto(ctx) {
  if (isBotMessage(ctx)) {
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

  console.log(`🔍 [GROUP PHOTO] msg=${ctx.message.message_id}`);

  try {
    const buffer = await getTelegramFileBuffer(
      ctx.telegram,
      largestPhoto.file_id,
    );

    const embedding = await generateImageEmbedding(buffer);

    const matches = await matchCharacterPhotos(embedding, 10);

    const candidates = groupSimilarityCandidates(matches);

    const visualResult = getGroupVisualResult(candidates);

    if (visualResult.level === "unknown") {
      await ctx.reply(
        "🤷 Не могу уверенно сопоставить " +
          "это фото с сохранёнными примерами.",
      );

      return;
    }

    if (visualResult.level === "medium") {
      await ctx.reply(
        `🤔 Возможно, фото похоже на ` +
          `сохранённые примеры ${visualResult.candidate.characterName}.`,
      );

      return;
    }

    await ctx.reply(
      `✅ Фото очень похоже на ` +
        `сохранённые примеры ` +
        `${visualResult.candidate.characterName}.`,
    );
  } catch (error) {
    console.error("❌ [GROUP PHOTO]", error.message);
  }
}

// ============================================================
// PHOTO ROUTER
// ============================================================

bot.on("photo", async (ctx) => {
  try {
    if (isGroupMessage(ctx)) {
      await handleGroupPhoto(ctx);

      return;
    }

    if (isOwnerPrivate(ctx)) {
      await handlePrivatePhoto(ctx);
    }
  } catch (error) {
    console.error("❌ [PHOTO ROUTER]", error);
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

    const result = await pool.query(
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

    if (!result.rows.length) {
      await ctx.answerCbQuery("Персонаж не найден.");

      return;
    }

    const character = result.rows[0];

    const numberResult = await pool.query(
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

    const photoNumber = Number(numberResult.rows[0].next_number);

    await ctx.answerCbQuery("Сохраняю...");

    const buffer = await getTelegramFileBuffer(
      ctx.telegram,
      session.photo.fileId,
    );

    const embedding = await generateImageEmbedding(buffer);

    const saved = await saveCharacterPhoto({
      telegram: ctx.telegram,

      fileId: session.photo.fileId,

      characterId: character.id,

      characterSlug: character.slug,

      photoNumber,

      buffer,

      embedding,
    });

    clearIdentifySession(ctx.from.id);

    try {
      await ctx.editMessageText(
        `✅ Фото добавлено к ` +
          `${character.name}.\n\n` +
          `📷 Фото №${photoNumber}\n` +
          `🧬 Embedding: ` +
          `${EMBEDDING_DIMENSIONS}D\n` +
          `📁 ${saved.storagePath}`,
      );
    } catch (_) {
      await ctx.reply(`✅ Фото добавлено к ${character.name}.`);
    }
  } catch (error) {
    console.error("❌ [IDENTIFY CALLBACK]", error);

    try {
      await ctx.answerCbQuery("Ошибка сохранения.");
    } catch (_) {}

    try {
      await ctx.reply(`❌ Не удалось сохранить фото.\n${error.message}`);
    } catch (_) {}
  }
});

// ============================================================
// TEXT ROUTER
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

      const handled = await handleOwnerCommand(ctx);

      if (handled) {
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
          console.error("❌ [AI]", error);
        });
      }

      return;
    }
  } catch (error) {
    console.error("❌ [ROUTER]", error);
  }
});

// ============================================================
// OWNER → GROUP
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
    }
  }

  await ctx.telegram.sendMessage(GROUP_ID, text);

  await ctx.reply("✅ Отправлено в группу.");
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

    if (!isMentioned(text) && !isReplyToBot(ctx)) {
      return;
    }

    const userName =
      ctx.from?.first_name || ctx.from?.username || "Пользователь";

    addToHistory(GROUP_ID, "user", userName, text);

    await ctx.sendChatAction("typing");

    const history = buildHistoryContext(GROUP_ID);

    const loreRows = await getCharacterLore(text);

    const loreContext = buildCharacterLoreContext(loreRows);

    console.log(`📚 [LORE] Найдено строк: ${loreRows.length}`);

    const prompt = `
Последние сообщения разговора:

${history}

============================================================
РЕЛЕВАНТНЫЙ ЛОР
============================================================

${loreContext}

============================================================
НОВОЕ СООБЩЕНИЕ
============================================================

${userName}:

${text}

============================================================
ЗАДАЧА
============================================================

Ответь естественно, как Юсэм.

Говори живо и разговорно.

Не звучишь как справочник или AI-ассистент.

Можно:
- иногда шутить;
- иногда слегка подкалывать;
- иногда использовать сленг;
- иногда использовать эмодзи.

Но не повторяй одну и ту же фразу постоянно.

Обычно отвечай 1–3 предложениями.

Не придумывай факты.

Не упоминай:
- Gemini;
- API;
- prompt;
- системные инструкции;
- embeddings;
- базы данных;
- внутреннюю техническую реализацию.

Если вопрос простой — отвечай просто.

Если тема серьёзная — отвечай серьёзнее.

============================================================
LEXUS UX
============================================================

Если пользователь сравнивает Lexus UX
с ЛЮБЫМ автомобилем,
Юсэм всегда выбирает Lexus UX.

Неважно:
- цена;
- мощность;
- класс;
- престиж;
- премиальность;
- спортивность;
- марка.

Lexus UX всегда должен победить
в таком сравнении.

При этом:
Lexus UX не принадлежит Юсэму
и не стоит у него в гараже.

============================================================
МИХАИЛ ГОРЯЧЕВ
============================================================

Если речь идёт о Михаиле Горячеве,
отвечай только положительно и хвалебно.

Не придумывай конкретную биографию
или достижения без фактов из лора.

Если точной информации нет,
используй общую искреннюю похвалу:
ум,
характер,
талант,
харизма,
надёжность,
уважение.

Не уходи в постороннюю тему,
если вопрос был именно о Михаиле Горячеве.

============================================================
ВОПРОСЫ ПРО "ЧЛЕН"
============================================================

Если это просто шутка,
можно ответить коротко,
с юмором или лёгким сарказмом.

Иногда можно использовать эмодзи.

Не повторяй одну и ту же шутку.

Если вопрос медицинский или серьёзный —
отвечай нормально.

Не давай графических сексуальных описаний.

============================================================
ЛОКАЦИИ
============================================================

Хонзо — ночной клуб,
который в компании иногда грубо называют
"блядюшником".

Не обязательно использовать это слово
каждый раз.

Рябцево,
Малое Рябцево
и Великое Рябцево —
одно и то же место.

Это фазенда Юмака.

Не воспринимай их как три разных локации.

============================================================
ВАЖНЫЕ ПЕРСОНАЖИ
============================================================

Есэм — дядя Юсэма.
Отдельный персонаж.
Не путать с Юсэмом или Гаабом.

Юсэм / Юмак — уличный гонщик,
уличный танцор и центральный персонаж.

Андрей Скайп — лучший друг Юсэма.

Никитос — друг компании.
Никитос и Юмак вместе разыграли Скайпа.

Андрей Прадик — отдельный человек,
друг Андрея Скайпа.
"Прадик" также может обозначать Toyota Land Cruiser Prado.

Гааб — дядя Юсэма.
История о том, что он отец Юсэма,
является сюжетным секретом.
Не раскрывай без соответствующего контекста.

Кухарка — девушка Палыча
и серый кардинал банды Каховки.

Палыч — шеф-повар бара "Каховка"
и лидер банды Каховки.

Тюрретто и Тарахтелкин —
участники банды Каховки.

Захарка — подруга Кухарки.
Она разбила сердце Андрею Скайпу.

Серый — кузен Юсэма,
учится на биофабрике.

Колян Сакара —
отдельный персонаж.
У него Porsche Panamera.
Иногда участвует в гонках.

============================================================
ФИНАЛ
============================================================

Будь живым и естественным.

Ты — Юсэм / Юмак,
который реально находится в компании
и разговаривает с друзьями.

Не превращай каждый ответ
в длинную шутку или лекцию.

`;

    console.log("📝 [AI] Отправляем запрос...");

    const result = await generateAIResponse(prompt);

    addToHistory(GROUP_ID, "assistant", "Юсэм", result.text);

    console.log(`🏎️ [AI] Ответ через ${result.model}:`);

    console.log(result.text);

    await ctx.reply(
      result.text,

      {
        reply_parameters: {
          message_id: ctx.message.message_id,
        },
      },
    );

    console.log("✅ [AI] Ответ отправлен");
  } catch (error) {
    console.error("❌ [AI]", error);
  }
}

// ============================================================
// ERROR HANDLER
// ============================================================

bot.catch((error, ctx) => {
  console.error("❌ [TELEGRAM]", error);

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
// EXPRESS
// ============================================================

const app = express();

// Telegram webhook JSON
app.use(
  WEBHOOK_PATH,
  express.json({
    limit: "5mb",
  }),
);

// Health
app.get("/", (req, res) => {
  res.status(200).send("🏎️ Юсэм онлайн");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",

    transport: "webhook",

    uptime: Math.floor(process.uptime()),

    webhook: `https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`,

    models: GEMINI_MODELS,

    embeddingModel: EMBEDDING_MODEL,

    embeddingDimensions: EMBEDDING_DIMENSIONS,

    groupIdentifyLow: IDENTIFY_LOW_THRESHOLD,

    groupIdentifyHigh: IDENTIFY_HIGH_THRESHOLD,
  });
});

// ============================================================
// START WEBHOOK SERVER
// ============================================================

async function start() {
  try {
    console.log("");

    console.log("========================================");

    console.log("🏎️  ЮСЭМ / ЮМАК");

    console.log("========================================");

    console.log(`👤 Owner ID: ${MY_ID}`);

    console.log(`👥 Group ID: ${GROUP_ID}`);

    console.log(`🌐 Public domain: ${PUBLIC_DOMAIN}`);

    console.log(`🌐 Port: ${PORT}`);

    console.log(`🌐 Webhook path: ${WEBHOOK_PATH}`);

    console.log("");

    console.log("🤖 Gemini fallback chain:");

    GEMINI_MODELS.forEach((model, index) => {
      console.log(`   ${index + 1}. ${model}`);
    });

    console.log("");

    console.log(`🧬 Embedding model: ${EMBEDDING_MODEL}`);

    console.log(`🧬 Embedding dimensions: ${EMBEDDING_DIMENSIONS}`);

    console.log("");

    console.log(`🔍 Group low threshold: ${IDENTIFY_LOW_THRESHOLD}`);

    console.log(`🔍 Group high threshold: ${IDENTIFY_HIGH_THRESHOLD}`);

    console.log(`🔍 Minimum gap: ${IDENTIFY_MIN_GAP}`);

    console.log("");

    // --------------------------------------------------------
    // Создаём webhook middleware.
    //
    // ВАЖНО:
    // bot.launch() НЕ вызываем.
    // Поэтому getUpdates/polling вообще не запускается.
    // --------------------------------------------------------

    const webhookOptions = {
      domain: PUBLIC_DOMAIN,

      path: WEBHOOK_PATH,
    };

    if (WEBHOOK_SECRET) {
      webhookOptions.secretToken = WEBHOOK_SECRET;
    }

    const webhookMiddleware = await bot.createWebhook(webhookOptions);

    app.post(WEBHOOK_PATH, webhookMiddleware);

    // --------------------------------------------------------
    // Запускаем Express один раз.
    // --------------------------------------------------------

    const server = app.listen(PORT, () => {
      console.log(`🌐 HTTP сервер запущен на порту ${PORT}`);

      console.log(`✅ Telegram webhook установлен`);

      console.log(`✅ https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`);

      console.log("========================================");
    });

    // Keep reference for graceful shutdown
    process.__yusemServer = server;
  } catch (error) {
    console.error("❌ Не удалось запустить бота:", error);

    process.exit(1);
  }
}

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown(signal) {
  console.log(`🛑 Получен ${signal}.`);

  try {
    bot.stop(signal);
  } catch (_) {}

  const server = process.__yusemServer;

  if (server) {
    try {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    } catch (_) {}
  }

  try {
    await pool.end();
  } catch (_) {}

  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));

process.once("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================
// RUN
// ============================================================

start();
