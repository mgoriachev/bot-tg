require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");

const express = require("express");

const fs = require("fs/promises");

const os = require("os");

const path = require("path");

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

// Webhook
const WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

// Storage
const STORAGE_BUCKET = "character-photos";

// Embeddings
const EMBEDDING_MODEL = "gemini-embedding-2";

const EMBEDDING_DIMENSIONS = 1536;

// ============================================================
// VISUAL THRESHOLDS
// ============================================================

const IDENTIFY_LOW_THRESHOLD = 0.7;

const IDENTIFY_HIGH_THRESHOLD = 0.9;

const IDENTIFY_MIN_GAP = 0.08;

// ============================================================
// AUDIO
// ============================================================

const AUDIO_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

const AUDIO_MAX_SECONDS = Number(process.env.AUDIO_MAX_SECONDS) || 180;

// ============================================================
// AI
// ============================================================

const MODEL_TIMEOUT_MS = 20000;

const MODEL_COOLDOWN_MS = 60000;

const RETRY_DELAY_MS = 1000;

// ============================================================
// MEMORY
// ============================================================

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

// Webhook mode
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
// SESSIONS
// ============================================================

const teachingSessions = new Map();

const identifySessions = new Map();

function getTeachingSession(userId) {
  return teachingSessions.get(userId);
}

function setTeachingSession(userId, session) {
  teachingSessions.set(userId, session);
}

function clearTeachingSession(userId) {
  teachingSessions.delete(userId);
}

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
            LIKE '%' ||
            lower(a.alias) ||
            '%'

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

async function getTelegramFileInfo(telegram, fileId) {
  const file = await telegram.getFile(fileId);

  if (!file?.file_path) {
    throw new Error("Telegram не вернул file_path.");
  }

  return file;
}

async function getTelegramFileBuffer(telegram, fileId) {
  const file = await getTelegramFileInfo(telegram, fileId);

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

// ============================================================
// VECTOR SEARCH
// ============================================================

async function matchCharacterPhotos(embedding, matchCount = 10) {
  console.log(`🔎 [VECTOR] Начинаем поиск ${matchCount} ближайших фото...`);

  console.log(`🔎 [VECTOR] Вектор подготовлен, длина=${embedding.length}`);

  try {
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

    console.log(
      `✅ [VECTOR] SQL завершён. Найдено строк: ${result.rows.length}`,
    );

    if (result.rows.length) {
      console.log("🔎 [VECTOR] Результаты:");

      for (const row of result.rows) {
        console.log(
          `   → ${row.character_name} | ` +
            `photo=${row.photo_number} | ` +
            `similarity=${row.similarity}`,
        );
      }
    }

    return result.rows;
  } catch (error) {
    console.error("❌ [VECTOR] Ошибка SQL поиска:");

    console.error(error);

    throw error;
  }
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
// COUNT PEOPLE
// ============================================================

async function countPeopleInImage(buffer, mimeType = "image/jpeg") {
  console.log("👥 [PEOPLE] Определяем количество людей на фото...");

  const prompt = `
Посмотри на изображение.

Определи примерное количество людей,
которые действительно видны в кадре.

Ответь строго в JSON:

{
  "people_count": 0,
  "confidence": "high"
}

Правила:

- считай только реально видимых людей;
- частично видимого человека тоже считай,
  если понятно, что это человек;
- не считай людей на экранах,
  фотографиях или плакатах;
- не считай манекены и статуи;
- если людей много, дай разумную оценку;
- confidence: high, medium или low.

Никаких комментариев вне JSON.
`;

  let lastError = null;

  for (const modelName of GEMINI_MODELS) {
    if (isModelOnCooldown(modelName)) {
      console.log(`⏸️ [PEOPLE] ${modelName} пропущена — cooldown`);

      continue;
    }

    console.log(`👥 [PEOPLE] Пробуем ${modelName}`);

    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
      });

      const result = await withTimeout(
        model.generateContent([
          {
            inlineData: {
              mimeType,

              data: buffer.toString("base64"),
            },
          },

          prompt,
        ]),

        MODEL_TIMEOUT_MS,

        `Timeout ${MODEL_TIMEOUT_MS}ms: ${modelName}`,
      );

      const text = result?.response?.text?.()?.trim();

      if (!text) {
        throw new Error("Gemini не вернул ответ.");
      }

      let parsed;

      try {
        parsed = JSON.parse(
          text
            .replace(/^```json\s*/i, "")
            .replace(/```$/i, "")
            .trim(),
        );
      } catch (_) {
        const jsonMatch = text.match(/\{[\s\S]*\}/);

        if (!jsonMatch) {
          throw new Error(`Не удалось разобрать JSON: ${text}`);
        }

        parsed = JSON.parse(jsonMatch[0]);
      }

      const count = Math.max(0, Number(parsed.people_count) || 0);

      const confidence = ["high", "medium", "low"].includes(parsed.confidence)
        ? parsed.confidence
        : "low";

      console.log(`✅ [PEOPLE] Ответ через ${modelName}`);

      console.log(
        `✅ [PEOPLE] Людей обнаружено: ${count}, confidence=${confidence}`,
      );

      return {
        count,

        confidence,

        model: modelName,
      };
    } catch (error) {
      lastError = error;

      console.error(`❌ [PEOPLE] ${modelName}:`, error.message);

      if (is429Error(error)) {
        putModelOnCooldown(modelName);

        console.log(`⏭️ [PEOPLE] ${modelName} получила 429 — следующая модель`);

        continue;
      }

      if (isTemporaryGeminiError(error)) {
        putModelOnCooldown(modelName);

        continue;
      }

      continue;
    }
  }

  console.error("❌ [PEOPLE] Все Gemini-модели недоступны");

  if (lastError) {
    console.error("❌ [PEOPLE] Последняя ошибка:", lastError.message);
  }

  return {
    count: null,

    confidence: "low",

    model: null,
  };
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

  console.log("");

  console.log("========================================");

  console.log(`📷 [GROUP PHOTO] msg=${ctx.message.message_id}`);

  try {
    console.log("📥 [GROUP PHOTO] Скачиваем фото...");

    const buffer = await getTelegramFileBuffer(
      ctx.telegram,

      largestPhoto.file_id,
    );

    console.log(`✅ [GROUP PHOTO] Фото скачано: ${buffer.length} bytes`);

    // --------------------------------------------------------
    // PEOPLE COUNT
    // --------------------------------------------------------

    const peopleInfo = await countPeopleInImage(buffer);

    // --------------------------------------------------------
    // ONE PERSON
    // --------------------------------------------------------

    if (peopleInfo.count === 1) {
      console.log("🔎 [GROUP PHOTO] Один человек — запускаем vector search");

      const embedding = await generateImageEmbedding(buffer);

      console.log("✅ [GROUP PHOTO] Embedding готов");

      console.log("🔎 [GROUP PHOTO] Ищем похожие фотографии...");

      const matches = await matchCharacterPhotos(embedding, 10);

      console.log(`✅ [GROUP PHOTO] Поиск завершён. Matches=${matches.length}`);

      const candidates = groupSimilarityCandidates(matches);

      console.log(
        `🔎 [GROUP PHOTO] Кандидатов персонажей: ${candidates.length}`,
      );

      for (const candidate of candidates) {
        console.log(
          `   → ${candidate.characterName}: ` +
            `best=${candidate.bestSimilarity} ` +
            `photos=${candidate.photos}`,
        );
      }

      const result = getGroupVisualResult(candidates);

      console.log(`🔎 [GROUP PHOTO] Result level=${result.level}`);

      if (result.level === "unknown") {
        await ctx.reply(
          "🤷 Пока не могу уверенно сопоставить это фото с сохранёнными примерами.",
        );

        return;
      }

      if (result.level === "medium") {
        await ctx.reply(
          `🤔 Возможно, фото похоже на ` +
            `сохранённые примеры ` +
            `${result.candidate.characterName}.`,
        );

        return;
      }

      await ctx.reply(
        `✅ Фото очень похоже на ` +
          `сохранённые примеры ` +
          `${result.candidate.characterName}.`,
      );

      return;
    }

    // --------------------------------------------------------
    // MULTIPLE PEOPLE
    // --------------------------------------------------------

    if (peopleInfo.count !== null && peopleInfo.count >= 2) {
      console.log(
        `👥 [GROUP PHOTO] Групповое фото: ${peopleInfo.count} человек(а)`,
      );

      if (peopleInfo.count >= 5) {
        await ctx.reply(
          `👥 На фото примерно ` +
            `${peopleInfo.count} человек.\n\n` +
            `Похоже, тут целая компания 😎 ` +
            `Отдельных участников пока не берусь ` +
            `уверенно сопоставлять.`,
        );

        return;
      }

      await ctx.reply(
        `👥 На фото примерно ` +
          `${peopleInfo.count} человека.\n\n` +
          `Похоже, это групповое фото. ` +
          `Отдельных участников пока не берусь ` +
          `уверенно сопоставлять.`,
      );

      return;
    }

    // --------------------------------------------------------
    // UNKNOWN
    // --------------------------------------------------------

    await ctx.reply(
      "🤔 Вижу фото, но не смог надёжно определить " + "количество людей.",
    );
  } catch (error) {
    console.error("❌ [GROUP PHOTO] Полная ошибка:");

    console.error(error);

    console.error("❌ [GROUP PHOTO] message:", error?.message);

    console.error("❌ [GROUP PHOTO] stack:", error?.stack);
  } finally {
    console.log("========================================");
  }
}

// ============================================================
// AUDIO
// ============================================================

function sanitizeAudioExtension(filePath, fallback = ".ogg") {
  if (!filePath) {
    return fallback;
  }

  const ext = path.extname(filePath);

  if (!ext || ext.length > 10) {
    return fallback;
  }

  return ext;
}

function normalizeAudioTranscript(text) {
  if (!text) {
    return "";
  }

  return text

    .replace(/\bюсем\b/giu, "Юсэм")

    .replace(/\bюсэм\b/giu, "Юсэм")

    .replace(/\bюсэм\b/giu, "Юсэм")

    .replace(/\bюмак\b/giu, "Юмак")

    .replace(/\bюмах\b/giu, "Юмак")

    .trim();
}

function isAudioMentioned(text = "") {
  const normalized = normalizeAudioTranscript(text).toLowerCase();

  const variants = ["юсэм", "юсем", "юсэм", "юмак", "юмах"];

  return variants.some((variant) => normalized.includes(variant));
}

async function transcribeAudio(ctx, fileId, mimeType = "audio/ogg") {
  console.log("🎤 [AUDIO] Получено аудио");

  console.log("📥 [AUDIO] Скачиваем...");

  const file = await getTelegramFileInfo(
    ctx.telegram,

    fileId,
  );

  const response = await fetch(
    `https://api.telegram.org/file/bot` + `${BOT_TOKEN}/${file.file_path}`,
  );

  if (!response.ok) {
    throw new Error(`Ошибка скачивания аудио: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  console.log(`✅ [AUDIO] Скачано: ${buffer.length} bytes`);

  const extension = sanitizeAudioExtension(file.file_path, ".ogg");

  const tempPath = path.join(
    os.tmpdir(),

    `yusem-audio-${Date.now()}${extension}`,
  );

  await fs.writeFile(tempPath, buffer);

  try {
    console.log("📝 [AUDIO] Загружаем в Gemini Files API...");

    const uploaded = await genAIEmbeddings.files.upload({
      file: tempPath,

      config: {
        mimeType: mimeType,
      },
    });

    if (!uploaded?.uri) {
      throw new Error("Gemini Files API не вернул URI.");
    }

    console.log("✅ [AUDIO] Файл загружен в Gemini");

    console.log("📝 [AUDIO] Начинаем транскрипцию...");

    const interaction = await genAIEmbeddings.interactions.create({
      model: AUDIO_TRANSCRIBE_MODEL,

      input: [
        {
          type: "audio",

          uri: uploaded.uri,

          mime_type: uploaded.mimeType || mimeType,
        },
      ],

      generation_config: {
        transcription_config: {
          language_codes: ["ru-RU"],

          custom_vocabulary: [
            "Юсэм",
            "Юсем",
            "Юмак",
            "Юмах",

            "Палыч",

            "Андрей Скайп",

            "Кухарка",

            "Тюрретто",

            "Тарахтелкин",

            "Рябцево",

            "Малое Рябцево",

            "Великое Рябцево",

            "Хонзо",

            "Лексус UX",

            "Lexus UX",
          ],
        },
      },
    });

    const rawTranscript = (interaction?.output_text || "").trim();

    if (!rawTranscript) {
      throw new Error("Транскрипция вернула пустой текст.");
    }

    const transcript = normalizeAudioTranscript(rawTranscript);

    console.log(`✅ [AUDIO] Исходная транскрипция: "${rawTranscript}"`);

    console.log(`✅ [AUDIO] Нормализованная транскрипция: "${transcript}"`);

    return transcript;
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch (_) {}
  }
}

async function handleAudioMessage(ctx, fileId, mimeType) {
  const userName = ctx.from?.first_name || ctx.from?.username || "Пользователь";

  console.log("");

  console.log("========================================");

  console.log(`🎤 [AUDIO] msg=${ctx.message?.message_id}`);

  console.log(`🎤 [AUDIO] chat=${ctx.chat?.id}`);

  console.log(`🎤 [AUDIO] from=${ctx.from?.id}`);

  if (!fileId) {
    console.error("❌ [AUDIO] file_id отсутствует");

    return;
  }

  try {
    const transcript = await transcribeAudio(
      ctx,

      fileId,

      mimeType,
    );

    if (!transcript) {
      return;
    }

    console.log("✅ [AUDIO] Транскрипция готова");

    // --------------------------------------------------------
    // GROUP
    // --------------------------------------------------------

    if (isGroupMessage(ctx)) {
      const mentioned = isAudioMentioned(transcript);

      const replyToBot = isReplyToBot(ctx);

      if (!mentioned && !replyToBot) {
        console.log(
          "🎤 [AUDIO] В группе голосовое " +
            "без обращения к Юмаку — не отвечаем",
        );

        await sendAudioRadar(ctx, transcript);

        return;
      }

      console.log("🧠 [AUDIO] Передаём распознанный текст в AI");

      await sendAudioRadar(ctx, transcript);

      await handleAIText(
        ctx,

        transcript,

        userName,
      );

      return;
    }

    // --------------------------------------------------------
    // OWNER PRIVATE
    // --------------------------------------------------------

    if (isOwnerPrivate(ctx)) {
      await ctx.reply(`📝 Я услышал:\n\n` + `${transcript}`);

      return;
    }
  } catch (error) {
    console.error("❌ [AUDIO] Ошибка:");

    console.error(error);

    console.error("❌ [AUDIO] message:", error?.message);

    if (isOwnerPrivate(ctx)) {
      await ctx.reply("❌ Не удалось распознать голосовое.");
    }
  } finally {
    console.log("========================================");
  }
}

async function sendAudioRadar(ctx, transcript) {
  try {
    const name = ctx.from?.first_name || ctx.from?.username || "Пользователь";

    const username = ctx.from?.username ? `@${ctx.from.username}` : "";

    const message =
      `🎤 ${name} ${username}\n\n` +
      `${transcript}\n\n` +
      `📌 [group:${GROUP_ID}]\n` +
      `🆔 [msg:${ctx.message.message_id}]`;

    await ctx.telegram.sendMessage(MY_ID, message);

    console.log(`📡 [RADAR AUDIO] msg=${ctx.message.message_id} → owner`);
  } catch (error) {
    console.error("❌ [RADAR AUDIO]", error.message);
  }
}

// ============================================================
// VOICE
// ============================================================

bot.on("voice", async (ctx) => {
  try {
    await handleAudioMessage(
      ctx,

      ctx.message?.voice?.file_id,

      "audio/ogg",
    );
  } catch (error) {
    console.error("❌ [VOICE]", error);
  }
});

// ============================================================
// AUDIO FILE
// ============================================================

bot.on("audio", async (ctx) => {
  try {
    const audio = ctx.message?.audio;

    if (!audio?.file_id) {
      return;
    }

    await handleAudioMessage(
      ctx,

      audio.file_id,

      audio.mime_type || "audio/mpeg",
    );
  } catch (error) {
    console.error("❌ [AUDIO FILE]", error);
  }
});

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

        await ctx.reply("🤷 Похожих подтверждённых " + "примеров пока нет.");

        return;
      }

      const buttons = candidates.slice(0, 8).map((candidate) => [
        Markup.button.callback(
          candidate.characterName,

          `identify-confirm:${candidate.characterId}`,
        ),
      ]);

      buttons.push([
        Markup.button.callback(
          "❌ Отмена",

          "identify-confirm:cancel",
        ),
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

      await ctx.reply(`❌ Не удалось сравнить фото.\n` + `${error.message}`);
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
      await ctx.reply(`❌ Не удалось сохранить фото.\n` + `${error.message}`);
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

    // ======================================================
    // OWNER PRIVATE
    // ======================================================

    if (isOwnerPrivate(ctx)) {
      console.log("👤 [ROUTER] Сообщение владельца");

      const handled = await handleOwnerCommand(ctx);

      if (handled) {
        return;
      }

      await sendOwnerMessageToGroup(ctx);

      return;
    }

    // ======================================================
    // GROUP
    // ======================================================

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
// AI
// ============================================================

async function handleAIText(ctx, text, userName = null) {
  try {
    if (!isGroupMessage(ctx)) {
      return;
    }

    if (isBotMessage(ctx)) {
      return;
    }

    if (!text) {
      return;
    }

    const name =
      userName || ctx.from?.first_name || ctx.from?.username || "Пользователь";

    addToHistory(
      GROUP_ID,

      "user",

      name,

      text,
    );

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

${name}:

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

async function handleAI(ctx) {
  const text = ctx.message?.text?.trim();

  if (!text) {
    return;
  }

  await handleAIText(ctx, text);
}

// ============================================================
// START WEBHOOK
// ============================================================

let server = null;

const app = express();

app.use(
  WEBHOOK_PATH,
  express.json({
    limit: "10mb",
  }),
);

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

    audioModel: AUDIO_TRANSCRIBE_MODEL,

    embeddingModel: EMBEDDING_MODEL,

    embeddingDimensions: EMBEDDING_DIMENSIONS,

    groupIdentifyLow: IDENTIFY_LOW_THRESHOLD,

    groupIdentifyHigh: IDENTIFY_HIGH_THRESHOLD,

    minGap: IDENTIFY_MIN_GAP,
  });
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

    console.log(`🎤 Audio model: ${AUDIO_TRANSCRIBE_MODEL}`);

    console.log(`🎤 Audio language: ru-RU`);

    console.log("");

    console.log(`🔍 Group low threshold: ${IDENTIFY_LOW_THRESHOLD}`);

    console.log(`🔍 Group high threshold: ${IDENTIFY_HIGH_THRESHOLD}`);

    console.log(`🔍 Minimum gap: ${IDENTIFY_MIN_GAP}`);

    console.log("");

    const webhookOptions = {
      domain: PUBLIC_DOMAIN,

      path: WEBHOOK_PATH,
    };

    if (WEBHOOK_SECRET) {
      webhookOptions.secretToken = WEBHOOK_SECRET;
    }

    const webhookMiddleware = await bot.createWebhook(webhookOptions);

    app.post(WEBHOOK_PATH, webhookMiddleware);

    server = app.listen(PORT, () => {
      console.log(`🌐 HTTP сервер запущен на порту ${PORT}`);

      console.log("✅ Telegram webhook установлен");

      console.log(`✅ https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`);

      console.log("========================================");
    });
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

  if (server) {
    try {
      await new Promise((resolve) => {
        server.close(resolve);
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
