require("dotenv").config();
const { Telegraf } = require("telegraf");
const express = require("express");

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

// bot.use(async (ctx, next) => {

//     if (ctx.message && ctx.from) {

//         if (ctx.from.id === 141824902) {
//             await ctx.reply('Ну го', {
//                 reply_parameters: { message_id: ctx.message.message_id }
//             });
//         }
//     }

//     return next();
// });

// --- ВАШИ ТРИГГЕРНЫЕ ФРАЗЫ (bot.hears) ---

// Существующий триггер
bot.hears(/го до/i, (ctx) => {
  ctx.reply("Ну погнали! Заводи мотор! 🔑");
});

// Новый триггер 1 (реагирует на точное совпадение слова)
bot.hears(/чей член/i, (ctx) => {
  ctx.reply("Твой ёпта. Фото будет? 🌈");
});

// Новый триггер 2 (сработает на "привет", "Приветствую", "приветик")
bot.hears(/Го в/i, (ctx) => {
  ctx.reply("Ну погнали. Тебя за ручку вести надо? 👥");
});

bot.hears(/Эй Юмак/i, (ctx) => {
  ctx.reply("Чо зовешь? В лесу потерялся 👨‍❤️‍💋‍👨", {
    // Указываем Telegram, на какое именно сообщение мы отвечаем
    reply_parameters: { message_id: ctx.message.message_id },
  });
});

const MY_ID = 141824902; // Ваш ID
const GROUP_ID = -5278268745; // ID вашей группы

bot.on("text", async (ctx, next) => {
  // Проверяем, что пишут в личку и это именно вы
  if (ctx.chat.type === "private" && ctx.from.id === MY_ID) {
    const text = ctx.message.text;

    // Регулярное выражение, которое ищет ссылку на сообщение Telegram
    // (работает с публичными https://t.me/groupname/123 и приватными https://t.me/c/123/456)
    const linkMatch = text.match(/t\.me\/(?:c\/\d+\/|[a-zA-Z0-9_]+\/)(\d+)/);

    try {
      if (linkMatch) {
        // Если ссылка найдена, достаем ID сообщения (это цифры в самом конце ссылки)
        const targetMessageId = parseInt(linkMatch[1]);

        // Убираем саму ссылку из вашего текста, чтобы бот отправил только ответ
        // Убираем 'https://' если вы скопировали ссылку целиком
        let replyText = text.replace(/https?:\/\/[^\s]+/, "").trim();

        if (!replyText) {
          return ctx.reply(
            "Вы прислали ссылку, но забыли написать текст ответа!",
          );
        }

        // Отправляем сообщение в группу с цитированием
        await ctx.telegram.sendMessage(GROUP_ID, replyText, {
          reply_parameters: { message_id: targetMessageId },
        });
        await ctx.reply("✅ Ответ с цитированием успешно отправлен!");
      } else {
        // Если ссылки в тексте нет, отправляем как обычное самостоятельное сообщение
        await ctx.telegram.sendMessage(GROUP_ID, text);
        await ctx.reply("✅ Простое сообщение отправлено в группу!");
      }
    } catch (err) {
      await ctx.reply("❌ Ошибка. Возможно, сообщение в группе уже удалено.");
      console.error(err);
    }
  } else {
    // Пропускаем все остальные сообщения к вашим триггерам (bot.hears)
    return next();
  }
});

// ----------------------------------------------------

bot.launch();
console.log("Бот с новыми правилами запущен!");

app.get("/", (req, res) => res.send("Бот активен!"));
app.listen(process.env.PORT || 3000);
