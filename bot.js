const { Telegraf } = require('telegraf');
const express = require('express'); // Добавляем веб-сервер

// Используем переменную окружения для токена (это безопасно для серверов)
const bot = new Telegraf(process.env.BOT_TOKEN || 'ВАШ_ТОКЕН_ЗДЕСЬ');
const app = express();

bot.hears(/привет/i, (ctx) => {
    ctx.reply('Привет! Рад видеть тебя в группе!');
});

bot.launch();
console.log('Бот запущен!');

// --- ХИТРОСТЬ ДЛЯ БЕСПЛАТНОГО СЕРВЕРА ---
// Создаем простую веб-страничку
app.get('/', (req, res) => {
    res.send('Бот работает!');
});

// Запускаем сервер на порту, который выдаст хостинг
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Веб-сервер запущен на порту ${PORT}`);
});