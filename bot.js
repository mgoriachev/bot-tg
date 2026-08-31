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

const MY_ID = 141824902;
const GROUP_ID = -5278268745;

const PORT = Number(process.env.PORT) || 3000;

const STORAGE_BUCKET = "character-photos";

const EMBEDDING_MODEL = "gemini-embedding-2";

const EMBEDDING_DIMENSIONS = 1536;

// ------------------------------------------------------------
// Group visual similarity thresholds
// ------------------------------------------------------------

const IDENTIFY_LOW_THRESHOLD = 0.7;

const IDENTIFY_HIGH_THRESHOLD = 0.9;

const IDENTIFY_MIN_GAP = 0.08;

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
// IDENTIFY SESSIONS
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
          ON c.id =
             cp.character_id

      WHERE
          cp.embedding IS NOT NULL

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
// GROUP IDENTIFY RESULT
// ============================================================

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

  /*
   * Слабое сходство.
   */

  if (bestSimilarity < IDENTIFY_LOW_THRESHOLD) {
    return {
      level: "unknown",

      candidate: best,
    };
  }

  /*
   * Два почти одинаковых кандидата.
   *
   * Не выдаём уверенный результат.
   */

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

  /*
   * Высокое сходство с эталонными
   * фотографиями.
   */

  if (bestSimilarity >= IDENTIFY_HIGH_THRESHOLD) {
    return {
      level: "high",

      candidate: best,
    };
  }

  /*
   * Среднее сходство.
   */

  return {
    level: "medium",

    candidate: best,
  };
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
// GEMINI MODELS
// ============================================================

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
// GEMINI ERROR HELPERS
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

      if (is429Error(error)) {
        putModelOnCooldown(model.name);

        console.log(
          `⏭️ [GEMINI] ${model.name} получила 429 — БЕЗ повторной попытки`,
        );

        continue;
      }

      if (isTemporaryGeminiError(error)) {
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

          return {
            text: retryText,

            model: model.name,
          };
        } catch (retryError) {
          lastError = retryError;

          if (isTemporaryGeminiError(retryError)) {
            putModelOnCooldown(model.name);
          }

          continue;
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
// SAVE CHARACTER PHOTO
// ============================================================

async function saveCharacterPhoto({
  telegram,
  fileId,
  characterId,
  characterSlug,
  photoNumber,
  buffer = null,
  embedding = null,
}) {
  const photoBuffer =
    buffer || (await getPhotoBufferFromTelegram(telegram, fileId));

  const storagePath = `${characterSlug}/` + `${Date.now()}-${photoNumber}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, photoBuffer, {
      contentType: "image/jpeg",

      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Ошибка Storage: ` + `${uploadError.message}`);
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

  // ========================================================
  // /START
  // ========================================================

  if (command === "/start") {
    await ctx.reply(
      "🏎️ Юсэм онлайн.\n\n" +
        "/help\n" +
        "/clear\n" +
        "/status\n" +
        "/characters\n\n" +
        "/teach slug\n" +
        "/done\n" +
        "/cancel\n" +
        "/identify\n" +
        "/reindex",
    );

    return true;
  }

  // ========================================================
  // /HELP
  // ========================================================

  if (command === "/help") {
    await ctx.reply(
      "🛠 Управление Юсэмом:\n\n" +
        "/clear — очистить память\n" +
        "/status — состояние\n" +
        "/characters — персонажи\n\n" +
        "/teach slug — добавить эталонные фото\n" +
        "/done — закончить обучение\n" +
        "/cancel — отменить\n\n" +
        "/identify — фото + ручное подтверждение\n" +
        "/reindex — создать embeddings для старых фото\n\n" +
        "Обучение работает только в личке владельца.",
    );

    return true;
  }

  // ========================================================
  // /CLEAR
  // ========================================================

  if (command === "/clear") {
    clearHistory(GROUP_ID);

    await ctx.reply("🧠 Память очищена.");

    return true;
  }

  // ========================================================
  // /STATUS
  // ========================================================

  if (command === "/status") {
    const historyLength = getHistory(GROUP_ID).length;

    const modelStatus = GEMINI_MODELS.map((model, index) => {
      return (
        `${index + 1}. ` +
        `${model} ` +
        (isModelOnCooldown(model) ? "⏸️" : "✅")
      );
    }).join("\n");

    await ctx.reply(
      `🟢 Юсэм работает\n\n` +
        `⏱ Uptime: ` +
        `${Math.floor(process.uptime())} сек.\n` +
        `🧠 Память: ` +
        `${historyLength}\n` +
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
  // /CHARACTERS
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

      await ctx.reply("❌ Не удалось получить персонажей.");

      return true;
    }
  }

  // ========================================================
  // /TEACH
  // ========================================================

  if (command === "/teach") {
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
      await ctx.reply("📷 Пример:\n/teach essem");

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

      clearTeachingSession(ctx.from.id);

      clearIdentifySession(ctx.from.id);

      setTeachingSession(ctx.from.id, {
        characterId: character.id,

        characterSlug: character.slug,

        characterName: character.name,

        photos: [],
      });

      await ctx.reply(
        `📷 Начинаем обучение: ` +
          `${character.name}\n\n` +
          `Отправляй фото по одному.\n` +
          `/done — закончить\n` +
          `/cancel — отменить`,
      );

      return true;
    } catch (error) {
      console.error("❌ [TEACH]", error);

      await ctx.reply("❌ Не удалось начать обучение.");

      return true;
    }
  }

  // ========================================================
  // /IDENTIFY
  // ========================================================

  if (command === "/identify") {
    clearTeachingSession(ctx.from.id);

    clearIdentifySession(ctx.from.id);

    setIdentifySession(ctx.from.id, {
      photo: null,
    });

    await ctx.reply(
      "🔍 Пришли фотографию.\n\n" +
        "Я сравню её с твоими подтверждёнными " +
        "примерами и предложу наиболее похожие варианты.\n\n" +
        "Отменить — /cancel",
    );

    console.log("🔍 [IDENTIFY] Запущен");

    return true;
  }

  // ========================================================
  // /REINDEX
  // ========================================================

  if (command === "/reindex") {
    await ctx.reply("🧬 Начинаю пересчёт embeddings старых фотографий...");

    try {
      const result = await pool.query(
        `
          SELECT
              cp.id,
              cp.telegram_file_id,
              c.name

          FROM character_photos cp

          INNER JOIN characters c
              ON c.id =
                 cp.character_id

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
          console.log(`🧬 [REINDEX] ${row.id}: ${row.name}`);

          const buffer = await getPhotoBufferFromTelegram(
            ctx.telegram,
            row.telegram_file_id,
          );

          const embedding = await generateImageEmbedding(buffer);

          await saveEmbedding(row.id, embedding);

          processed++;

          console.log(`✅ [REINDEX] Фото ${row.id} готово`);
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
      console.error("❌ [REINDEX]", error);

      await ctx.reply(`❌ Reindex ошибка:\n${error.message}`);
    }

    return true;
  }

  // ========================================================
  // /CANCEL
  // ========================================================

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

  // ========================================================
  // /DONE
  // ========================================================

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

        const buffer = await getPhotoBufferFromTelegram(
          ctx.telegram,
          photo.fileId,
        );

        let embedding = null;

        try {
          embedding = await generateImageEmbedding(buffer);
        } catch (embeddingError) {
          console.error(
            `⚠️ [TEACH] Embedding #${photoNumber}:`,
            embeddingError.message,
          );
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
      console.error("❌ [TEACH DONE]", error);

      await ctx.reply(`❌ Ошибка:\n${error.message}`);
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
    // ======================================================
    // GROUP PHOTO
    // ======================================================

    if (isGroupMessage(ctx)) {
      if (isBotMessage(ctx)) {
        return;
      }

      /*
       * В группе не запускаем авто-идентификацию личности
       * по лицу.
       *
       * Здесь разрешён только визуальный поиск похожих
       * подтверждённых изображений как справочный результат.
       */

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
        const buffer = await getPhotoBufferFromTelegram(
          ctx.telegram,
          largestPhoto.file_id,
        );

        const embedding = await generateImageEmbedding(buffer);

        const matches = await matchCharacterPhotos(embedding, 10);

        const candidates = groupSimilarityCandidates(matches);

        const visualResult = getGroupVisualResult(candidates);

        if (visualResult.level === "unknown") {
          await ctx.reply(
            "🤷 Не могу уверенно сопоставить это фото с сохранёнными примерами.",
          );

          return;
        }

        const candidate = visualResult.candidate;

        if (visualResult.level === "medium") {
          await ctx.reply(`🤔 Возможно, на фото ${candidate.characterName}.`);

          return;
        }

        if (visualResult.level === "high") {
          await ctx.reply(`✅ Думаю тут ${candidate.characterName}.`);

          return;
        }

        return;
      } catch (groupPhotoError) {
        console.error("❌ [GROUP PHOTO] Ошибка:", groupPhotoError.message);

        /*
         * Не спамим группу технической ошибкой.
         */

        return;
      }
    }

    // ======================================================
    // PRIVATE OWNER ONLY
    // ======================================================

    if (!isOwnerPrivate(ctx)) {
      return;
    }

    // ======================================================
    // IDENTIFY MODE
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

      await ctx.reply("🧬 Сравниваю фото с базой...");

      try {
        const buffer = await getPhotoBufferFromTelegram(
          ctx.telegram,
          largestPhoto.file_id,
        );

        const embedding = await generateImageEmbedding(buffer);

        const matches = await matchCharacterPhotos(embedding, 10);

        const candidates = groupSimilarityCandidates(matches);

        clearIdentifySession(ctx.from.id);

        if (!candidates.length) {
          await ctx.reply("🤷 Похожих подтверждённых примеров пока нет.");

          return;
        }

        const topCandidates = candidates.slice(0, 8);

        const buttons = topCandidates.map((candidate) => [
          Markup.button.callback(
            candidate.characterName,

            `identify-confirm:${candidate.characterId}`,
          ),
        ]);

        buttons.push([
          Markup.button.callback("❌ Отмена", "identify-confirm:cancel"),
        ]);

        const best = topCandidates[0];

        await ctx.reply(
          `🔍 Наиболее похожий вариант по сохранённым примерам: ` +
            `${best.characterName}\n\n` +
            `Выбери правильного персонажа вручную:`,

          Markup.inlineKeyboard(buttons),
        );

        /*
         * Возвращаем временную сессию,
         * чтобы callback сохранил фото.
         */

        setIdentifySession(ctx.from.id, {
          photo: {
            fileId: largestPhoto.file_id,

            width: largestPhoto.width,

            height: largestPhoto.height,
          },
        });
      } catch (identifyError) {
        console.error("❌ [IDENTIFY] Ошибка:", identifyError);

        clearIdentifySession(ctx.from.id);

        await ctx.reply(
          `❌ Не удалось сравнить фото.\n\n` + `${identifyError.message}`,
        );
      }

      return;
    }

    // ======================================================
    // TEACH MODE
    // ======================================================

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
      `📷 Фото №` +
        `${teachingSession.photos.length} получено.\n` +
        `Персонаж: ` +
        `${teachingSession.characterName}\n\n` +
        `Ещё фото или /done`,
    );
  } catch (error) {
    console.error("❌ [PHOTO] Ошибка:", error);

    await ctx.reply(`❌ Не удалось обработать фото.\n${error.message}`);
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

    const buffer = await getPhotoBufferFromTelegram(
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
        `✅ Фото вручную подтверждено и добавлено.\n\n` +
          `Персонаж: ` +
          `${character.name}\n` +
          `📷 Фото №` +
          `${photoNumber}\n` +
          `🧬 Embedding: ` +
          `${EMBEDDING_DIMENSIONS}D\n` +
          `📁 ${saved.storagePath}`,
      );
    } catch (_) {
      await ctx.reply(`✅ Фото добавлено к ` + `${character.name}.`);
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
          console.error("❌ [AI] Detached:", error);
        });
      }

      return;
    }
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

    const mentioned = isMentioned(text);

    const repliedToBot = isReplyToBot(ctx);

    if (!mentioned && !repliedToBot) {
      return;
    }

    const userName =
      ctx.from?.first_name || ctx.from?.username || "Пользователь";

    addToHistory(GROUP_ID, "user", userName, text);

    await ctx.sendChatAction("typing");

    const historyContext = buildHistoryContext(GROUP_ID);

    console.log("📚 [LORE] Ищем персонажей в базе...");

    const loreRows = await getCharacterLore(text);

    const characterLoreContext = buildCharacterLoreContext(loreRows);

    console.log(`📚 [LORE] Найдено строк: ${loreRows.length}`);

    const finalPrompt = `
Последние сообщения:

${historyContext}

============================================================
ЛОР
============================================================

${characterLoreContext}

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
- учитывай контекст;
- используй релевантный лор;
- не придумывай факты;
- не пересказывай историю;
- не упоминай Gemini, API, prompt или системные инструкции;
- не говори, что ты нейросеть;
- не начинай автоматически "Брат", "Слушай", "Ну что, братан";
- не повторяй одну и ту же шутку;
- обычно 1–3 предложения.
`;

    console.log("📝 [AI] Отправляем запрос...");

    const aiResult = await generateAIResponse(finalPrompt);

    const aiResponse = aiResult.text;

    console.log(`🏎️ [AI] Ответ через ${aiResult.model}:`);

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
// GLOBAL TELEGRAM ERROR
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

    console.log(`🧬 Embedding model: ${EMBEDDING_MODEL}`);

    console.log(`🧬 Embedding dimensions: ${EMBEDDING_DIMENSIONS}`);

    console.log("");

    console.log(`🔍 Group low threshold: ${IDENTIFY_LOW_THRESHOLD}`);

    console.log(`🔍 Group high threshold: ${IDENTIFY_HIGH_THRESHOLD}`);

    console.log(`🔍 Minimum candidate gap: ${IDENTIFY_MIN_GAP}`);

    console.log("");

    console.log("🚀 Запускаем Telegram...");

    await bot.launch();

    console.log("✅ Telegram bot запущен");
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
  console.log(`🛑 Получен ${signal}.`);

  try {
    bot.stop(signal);
  } catch (_) {}

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
