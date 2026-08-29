require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Инициализация бота и AI
const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 

// Настройки ID
const MY_ID = 141824902; // Ваш ID
const GROUP_ID = -5278268745; // ID вашей группы

const app = express();

// --- 1. РАДАР: ДУБЛИРУЕМ СООБЩЕНИЯ ИЗ ГРУППЫ ВАМ В ЛИЧКУ ---
bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.id === GROUP_ID && ctx.message && ctx.message.text) {
        const adminText = `💬 ${ctx.from.first_name} пишет:\n\n${ctx.message.text}\n\n[id:${ctx.message.message_id}]`;
        await ctx.telegram.sendMessage(MY_ID, adminText).catch(() => {});
    }
    return next();
});

// --- 2. ПУЛЬТ УПРАВЛЕНИЯ (РУЧНОЙ ОТВЕТ ИЗ ЛИЧКИ) ---
bot.on('text', async (ctx, next) => {
    if (ctx.chat && ctx.chat.type === 'private' && ctx.from.id === MY_ID) {
        if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
            const match = ctx.message.reply_to_message.text.match(/\[id:(\d+)\]/);
            if (match) {
                const targetMessageId = parseInt(match[1]);
                try {
                    await ctx.telegram.sendMessage(GROUP_ID, ctx.message.text, {
                        reply_parameters: { message_id: targetMessageId }
                    });
                    await ctx.reply('✅ Ответ с цитированием отправлен!');
                    return; 
                } catch (err) {
                    return ctx.reply('❌ Ошибка. Возможно, сообщение удалено.');
                }
            }
        }
        try {
            await ctx.telegram.sendMessage(GROUP_ID, ctx.message.text);
            await ctx.reply('✅ Простое сообщение отправлено!');
            return;
        } catch (err) {
            return ctx.reply('❌ Ошибка отправки.');
        }
    }
    return next();
});

// --- 3. ИСКУССТВЕННЫЙ ИНТЕЛЛЕКТ И ЛИЧНОСТЬ БОТА ---
bot.on('text', async (ctx) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
        const text = ctx.message.text.toLowerCase();
        
        const isMentioned = text.includes('юсэм') || text.includes('юмак');
        const isReplyToBot = ctx.message.reply_to_message && 
                             ctx.message.reply_to_message.from.id === ctx.botInfo.id;

        if (isMentioned || isReplyToBot) {
            try {
                await ctx.sendChatAction('typing');

                const systemPrompt = `Ты — дерзкий, энергичный и веселый участник группового чата. Твои имена — Юсэм (или Юмак), ты отзываешься на оба. 
Твои главные страсти — это стрит-рейсинг, уличные танцы и крутые тачки. Ты отлично разбираешься в автомобилях: обожаешь японский aftermarket-тюнинг в стиле Artisan Spirits или Modellista, ценишь эстетику Toyota GR Supra, а также уважаешь мощные мускул-кары вроде Mustang и Camaro. 
Вплетай в свои ответы автомобильный и танцевальный сленг (например: "дать угла", "включить нитро", "поймать ритм", "залететь на танцпол", "выжать максимум"). 
Ты общаешься коротко, дерзко, с юмором, как свой парень в тусовке рейсеров. Ты НЕ искусственный интеллект, никогда не упоминай об этом. Отвечай без воды, максимум 2-3 предложения.`;
                
                const finalPrompt = `${systemPrompt}\n\nСообщение от пользователя ${ctx.from.first_name}: ${ctx.message.text}`;

                const result = await aiModel.generateContent(finalPrompt);
                const aiResponse = result.response.text();

                await ctx.reply(aiResponse, {
                    reply_parameters: { message_id: ctx.message.message_id }
                });
                
            } catch (error) {
                console.error('Ошибка ИИ:', error);
                // Бот пришлет текст ошибки вам в личку
                await ctx.telegram.sendMessage(MY_ID, `⚠️ Ошибка нейросети: ${error.message}`).catch(() => {});
            }
        }
    }
});

// --- ЗАПУСК БОТА И ВЕБ-СЕРВЕРА ---
bot.launch();
console.log('Умный бот Юсэм/Юмак успешно запущен!');

app.get('/', (req, res) => res.send('Бот активен!'));
app.listen(process.env.PORT || 3000);