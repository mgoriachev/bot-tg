require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');

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
    ctx.reply('Ну погнали! Заводи мотор! 🔑');
});

// Новый триггер 1 (реагирует на точное совпадение слова)
bot.hears(/чей член/i, (ctx) => {
    ctx.reply('Твой ёпта. Продолжение будет? 🌈');
});

// Новый триггер 2 (сработает на "привет", "Приветствую", "приветик")
bot.hears(/Го в/i, (ctx) => {
    ctx.reply('Ну погнали. Тебя за ручку вести надо? 👥');
});

// ----------------------------------------------------

bot.launch();
console.log('Бот с новыми правилами запущен!');

app.get('/', (req, res) => res.send('Бот активен!'));
app.listen(process.env.PORT || 3000);