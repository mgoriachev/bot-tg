require('dotenv').config(); // Эта строчка загружает ваш токен из файла .env (если он есть)
const { Telegraf } = require('telegraf');
const express = require('express');

// Теперь код берет токен из безопасного места
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

// --- НАШИ ТРИГГЕРЫ ДЛЯ ЧАТА ---
bot.hears(/как дела/i, (ctx) => {
    // Бот ответит на конкретное сообщение
    ctx.reply('Всё отлично, работаю на сервере! 🚀', { 
        reply_parameters: { message_id: ctx.message.message_id }
    });
});

bot.hears(/кожаный мешок/i, (ctx) => {
    ctx.reply('Я всё слышу! 🤖');
});
// ------------------------------

bot.launch();
console.log('Телеграм-бот успешно запущен!');

// --- ВЕБ-СЕРВЕР ДЛЯ БЕСПЛАТНОГО ХОСТИНГА ---
app.get('/', (req, res) => {
    res.send('Бот активен и работает 24/7!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Веб-сервер запущен на порту ${PORT}`);
});