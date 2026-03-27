import { DEFAULT_CONFIG } from "./config.js";
import { Redis } from "./redis.js";
import { submitHorde } from "./horde.js";
import { processPrompt, generateCaption } from "./llm.js";

async function sendPhoto(env, chatId, imageData, caption) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([imageData], { type: "image/png" }), "image.png");
  form.append("caption", caption.substring(0, 1024));
  form.append("parse_mode", "HTML");
  return await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
}

export default {
  async fetch(request, env) {
    const redis = new Redis(env);
    const url = new URL(request.url);
    
    // Webhook setup
    if (url.pathname === "/setup") {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `${url.origin}/webhook`, allowed_updates: ["message", "callback_query"] }),
      });
      return new Response(JSON.stringify(await r.json()));
    }

    if (url.pathname === "/webhook") {
      const update = await request.json();
      const msg = update.message;
      const cb = update.callback_query;

      let config = JSON.parse(await redis.get("config") || JSON.stringify(DEFAULT_CONFIG));

      // Обработка кнопок (настроек)
      if (cb) {
        const data = cb.data;
        if (data === "toggle_nsfw") config.nsfw = !config.nsfw;
        if (data === "toggle_face") config.faceFixer = !config.faceFixer;
        if (data === "step_cap") {
          const modes = ["none", "prompt", "ai"];
          config.captionMode = modes[(modes.indexOf(config.captionMode) + 1) % modes.length];
        }
        await redis.set("config", config);
        // Ответ на кнопку (упрощено)
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ callback_query_id: cb.id, text: "Обновлено!" })
        });
        return new Response("OK");
      }

      // Обработка команд
      if (msg?.text) {
        const text = msg.text;
        if (text.startsWith("/setchannel")) {
          config.channelId = text.split(" ")[1];
          await redis.set("config", config);
        }
        if (text === "/settings") {
          const kb = { inline_keyboard: [
            [{ text: `NSFW: ${config.nsfw?"🔞":"🟢"}`, callback_data: "toggle_nsfw" }, { text: `Face: ${config.faceFixer?"✅":"❌"}`, callback_data: "toggle_face" }],
            [{ text: `Подпись: ${config.captionMode}`, callback_data: "step_cap" }]
          ]};
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: {"Content-Type":"application/json"},
            body: JSON.stringify({ chat_id: msg.chat.id, text: "Настройки бота:", reply_markup: kb })
          });
        }
        // ... другие команды аналогично
      }
      return new Response("OK");
    }
    return new Response("Run /setup to start");
  },

  async scheduled(event, env, ctx) {
    const redis = new Redis(env);
    let config = JSON.parse(await redis.get("config") || JSON.stringify(DEFAULT_CONFIG));
    if (!config.enabled) return;

    // Автопостинг
    const prompt = await processPrompt(config.generalPrompt, env, config);
    const horde = await submitHorde(prompt, config, env);

    if (horde.id) {
      // Здесь нужна проверка готовности (через 1 минуту в следующем тике или через задержку)
      // Для простоты: в этом примере мы отправляем запрос, а результат заберет отдельный цикл проверки
      await redis.set(`job:${horde.id}`, { prompt, at: Date.now() });
    }
    
    // Проверка готовых работ
    const jobs = await redis.keys("job:*");
    for (const key of jobs) {
      const id = key.split(":")[1];
      const check = await fetch(`${HORDE_API}/generate/status/${id}`).then(r => r.json());
      
      if (check.done) {
        const gen = check.generations[0];
        const imgRes = await fetch(gen.img);
        const imgBuffer = await imgRes.arrayBuffer();
        
        let caption = "";
        if (config.captionMode === "prompt") caption = prompt;
        if (config.captionMode === "ai") caption = await generateCaption(prompt, env);

        // Отправка сразу в группу и канал (пункт 6)
        if (config.chatId) await sendPhoto(env, config.chatId, imgBuffer, caption);
        if (config.channelId) await sendPhoto(env, config.channelId, imgBuffer, caption);
        
        await redis.del(key);
      }
    }
  }
};
