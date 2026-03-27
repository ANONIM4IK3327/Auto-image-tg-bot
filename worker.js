// ============================================================
// 🤖 ART-BOT MEGA EDITION (Upstash + Horde + OpenRouter)
// ============================================================

const DEFAULT_CONFIG = {
  enabled: false,
  chatId: null,
  channelId: null,
  adminId: null,
  interval: 60,
  count: 1,
  generalPrompt: "masterpiece, 8k, detailed",
  model: "AlbedoBase XL (SDXL)",
  loras: [],
  width: 1024,
  height: 1024,
  steps: 25,
  cfgScale: 7,
  sampler: "k_dpmpp_2m",
  nsfw: true,
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "meta-llama/llama-3.1-8b-instruct:free",
  clipSkip: 2,
  hiresFix: false,
  hiresFixDenoising: 0.65, // Вернул из оригинала
  karras: true, // Вернул из оригинала
  faceFixer: false,
  upscaler: false,
  captionMode: "prompt", // none, prompt, ai
};

const HORDE_API = "https://stablehorde.net/api/v2";

// --- Вспомогательные функции ---
const escapeHtml = (t) => t ? String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "";

// ==========================================
// КЛАСС БАЗЫ ДАННЫХ (UPSTASH REDIS)
// ==========================================
class RedisDB {
  constructor(env) {
    this.url = env.UPSTASH_REDIS_REST_URL;
    this.token = env.UPSTASH_REDIS_REST_TOKEN;
  }

  async req(cmd) {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd)
    });
    return (await r.json()).result;
  }

  async getConf() {
    const data = await this.req(["GET", "bot_config"]);
    return data ? { ...DEFAULT_CONFIG, ...JSON.parse(data) } : DEFAULT_CONFIG;
  }

  async saveConf(conf) { await this.req(["SET", "bot_config", JSON.stringify(conf)]); }
  async setJob(id, data) { await this.req(["SET", `job:${id}`, JSON.stringify(data), "EX", 3600]); }
  async getJobs() { return await this.req(["KEYS", "job:*"]) || []; }
  async delJob(key) { await this.req(["DEL", key]); }
}

// ==========================================
// ЛОГИКА ИИ (LLM & CAPTION)
// ==========================================
async function processPromptWithLLM(raw, env, config) {
  if (!env.OPENROUTER_API_KEY) return raw.replace(/^\[.*?\]/, "").trim();

  const match = raw.match(/^\[(.*?)\](.*)/s);
  let systemMsg = "You are a prompt engineer. Transform the concept into detailed Stable Diffusion tags.";
  let userConcept = raw;

  if (match) {
    systemMsg = match[1]; // Инструкция из [скобок]
    userConcept = match[2].trim();
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.llmModel || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [{ role: "system", content: systemMsg }, { role: "user", content: userConcept }]
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || userConcept;
  } catch (e) { return userConcept; }
}

async function generateAICaption(prompt, env) {
  if (!env.OPENROUTER_API_KEY) return "";
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemma-2-9b-it:free",
        messages: [
          { role: "system", content: "Напиши короткий, красивый пост на русском по описанию картинки. Используй эмодзи. Без хештегов." },
          { role: "user", content: prompt }
        ]
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) { return ""; }
}

// ==========================================
// ЛОГИКА HORDE (ГЕНЕРАЦИЯ)
// ==========================================
async function submitHorde(prompt, config, env) {
  const payload = {
    prompt: `${prompt} ### ${config.negativePrompt}`,
    params: {
      sampler_name: config.sampler,
      cfg_scale: config.cfgScale,
      width: config.width,
      height: config.height,
      steps: config.steps,
      clip_skip: config.clipSkip,
      karras: config.karras,
      hires_fix: config.hiresFix,
      denoising: config.hiresFixDenoising,
      n: 1
    },
    nsfw: config.nsfw,
    models: [config.model],
    r2: true,
    replacement_filter: true
  };

  if (config.loras?.length > 0) {
    payload.params.loras = config.loras.map(l => ({
      name: String(l.name),
      model: parseFloat(l.strength) || 0.8,
      clip: 1,
      is_version: true
    }));
  }

  const postProc = [];
  if (config.faceFixer) postProc.push("GFPGAN");
  if (config.upscaler) postProc.push("RealESRGAN_x4plus");
  if (postProc.length > 0) payload.params.post_processing = postProc;

  const res = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: { apikey: env.HORDE_API_KEY || "0000000000", "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await res.json();
}

// ==========================================
// ТЕЛЕГРАМ ИНТЕРФЕЙС
// ==========================================
async function tgApi(env, method, body) {
  return await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}

async function sendResult(env, chatId, imgData, caption) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([imgData], { type: 'image/png' }), "art.png");
  if (caption) {
    form.append("caption", caption.substring(0, 1024));
    form.append("parse_mode", "HTML");
  }
  return await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
}

// ==========================================
// ОСНОВНОЙ WORKER
// ==========================================
export default {
  async fetch(request, env) {
    const db = new RedisDB(env);
    const url = new URL(request.url);

    if (url.pathname === "/setup") {
      await tgApi(env, "setWebhook", { url: `${url.origin}/webhook`, allowed_updates: ["message", "callback_query"] });
      return new Response("Бот готов!");
    }

    if (url.pathname === "/webhook") {
      const upd = await request.json();
      let conf = await db.getConf();

      // --- Кнопки настроек ---
      if (upd.callback_query) {
        const cb = upd.callback_query;
        if (conf.adminId && cb.from.id !== conf.adminId) return new Response("OK");

        if (cb.data === "t_nsfw") conf.nsfw = !conf.nsfw;
        if (cb.data === "t_face") conf.faceFixer = !conf.faceFixer;
        if (cb.data === "t_hi") conf.hiresFix = !conf.hiresFix;
        if (cb.data === "cycle_cap") {
          const m = ["none", "prompt", "ai"];
          conf.captionMode = m[(m.indexOf(conf.captionMode) + 1) % m.length];
        }
        
        await db.saveConf(conf);
        const kb = { inline_keyboard: [
          [{ text: `🔞 NSFW: ${conf.nsfw?"Вкл":"Выкл"}`, callback_data: "t_nsfw" }, { text: `👤 Face: ${conf.faceFixer?"Вкл":"Выкл"}`, callback_data: "t_face" }],
          [{ text: `✨ Hires: ${conf.hiresFix?"Вкл":"Выкл"}`, callback_data: "t_hi" }, { text: `📝 Текст: ${conf.captionMode}`, callback_data: "cycle_cap" }]
        ]};
        await tgApi(env, "editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: kb });
        return new Response("OK");
      }

      // --- Команды ---
      const msg = upd.message;
      if (msg?.text) {
        if (!conf.adminId) { conf.adminId = msg.from.id; await db.saveConf(conf); }
        if (msg.from.id !== conf.adminId) return new Response("OK");

        const text = msg.text;
        if (text === "/settings") {
          const kb = { inline_keyboard: [
            [{ text: `🔞 NSFW: ${conf.nsfw?"Вкл":"Выкл"}`, callback_data: "t_nsfw" }, { text: `👤 Face: ${conf.faceFixer?"Вкл":"Выкл"}`, callback_data: "t_face" }],
            [{ text: `✨ Hires: ${conf.hiresFix?"Вкл":"Выкл"}`, callback_data: "t_hi" }, { text: `📝 Текст: ${conf.captionMode}`, callback_data: "cycle_cap" }]
          ]};
          await tgApi(env, "sendMessage", { chat_id: msg.chat.id, text: "⚙️ <b>Настройки генерации:</b>", parse_mode: "HTML", reply_markup: kb });
        }
        
        if (text.startsWith("/setprompt")) {
          conf.generalPrompt = text.replace("/setprompt ", "");
          await db.saveConf(conf);
          await tgApi(env, "sendMessage", { chat_id: msg.chat.id, text: "✅ Основной промпт сохранен." });
        }

        if (text.startsWith("/setchannel")) {
          conf.channelId = text.split(" ")[1];
          await db.saveConf(conf);
          await tgApi(env, "sendMessage", { chat_id: msg.chat.id, text: `✅ Канал привязан: ${conf.channelId}` });
        }

        if (text === "/setchat") {
          conf.chatId = msg.chat.id;
          await db.saveConf(conf);
          await tgApi(env, "sendMessage", { chat_id: msg.chat.id, text: "✅ Группа для автопостов установлена." });
        }

        if (text === "/enable") { conf.enabled = true; await db.saveConf(conf); await tgApi(env, "sendMessage", { chat_id: msg.chat.id, text: "🟢 Автопостинг включен." }); }
        if (text === "/disable") { conf.enabled = false; await db.saveConf(conf); await tgApi(env, "sendMessage", { chat_id: msg.chat.id, text: "🔴 Автопостинг выключен." }); }

        // Поиск моделей и LoRA
        if (text === "/listmodels") {
          const ms = await fetch(`${HORDE_API}/status/models?type=image`).then(r => r.json());
          let list = "📋 <b>Топ моделей:</b>\n";
          ms.sort((a,b) => b.count - a.count).slice(0, 15).forEach(m => list += `• <code>${m.name}</code>\n`);
          await tgApi(env, "sendMessage", { chat_id: msg.chat.id, text: list, parse_mode: "HTML" });
        }
      }
      return new Response("OK");
    }
    return new Response("Worker is active.");
  },

  // ==========================================
  // ПРОВЕРКА ЗАДАНИЙ И АВТОПОСТ (CRON)
  // ==========================================
  async scheduled(event, env, ctx) {
    const db = new RedisDB(env);
    const conf = await db.getConf();

    // 1. Проверяем очередь
    const keys = await db.getJobs();
    for (const key of keys) {
      const id = key.split(":")[1];
      const jobData = JSON.parse(await db.req(["GET", key]));
      
      const res = await fetch(`${HORDE_API}/generate/status/${id}`).then(r => r.json());
      if (res.done && res.generations?.[0]) {
        const gen = res.generations[0];
        // Логика цензуры из оригинала
        if (gen.censored || gen.state === "censored") { await db.delJob(key); continue; }

        const imgRes = await fetch(gen.img);
        if (imgRes.ok) {
          const imgArrayBuffer = await imgRes.arrayBuffer();
          let caption = "";
          if (conf.captionMode === "prompt") caption = `🎨 <b>Prompt:</b> <code>${escapeHtml(jobData.prompt)}</code>`;
          if (conf.captionMode === "ai") caption = await generateAICaption(jobData.prompt, env);

          // Постинг в группу и канал
          if (conf.chatId) await sendResult(env, conf.chatId, imgArrayBuffer, caption);
          if (conf.channelId) await sendResult(env, conf.channelId, imgArrayBuffer, caption);
        }
        await db.delJob(key);
      }
    }

    // 2. Логика запуска автопостинга
    if (!conf.enabled || !conf.generalPrompt) return;
    const lastRun = parseInt(await db.req(["GET", "last_run_time"]) || "0");
    if (Date.now() - lastRun < conf.interval * 60000) return;

    await db.req(["SET", "last_run_time", Date.now()]);

    const finalPrompt = await processPromptWithLLM(conf.generalPrompt, env, conf);
    const hordeRes = await submitHorde(finalPrompt, conf, env);
    
    if (hordeRes.id) {
      await db.setJob(hordeRes.id, { prompt: finalPrompt });
    }
  }
};
