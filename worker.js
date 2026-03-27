// ============================================================
// Telegram Image Bot — Cloudflare Workers + Upstash Redis
// AI Horde + OpenRouter
// ============================================================

const DEFAULT_CONFIG = {
  enabled: false,
  chatId: null,
  channelId: null,
  adminId: null,
  interval: 60,
  count: 1,
  generalPrompt: "",
  model: "AlbedoBase XL (SDXL)",
  loras: [],
  width: 1024,
  height: 1024,
  steps: 25,
  cfgScale: 2,
  sampler: "k_dpmpp_2m",
  nsfw: true,
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "meta-llama/llama-3.1-8b-instruct:free",
  clipSkip: 2,
  hiresFix: false,
  faceFixer: false,
  upscaler: false,
  captionMode: "prompt", // none, prompt, ai
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:15.0:tg" };
const MAX_RETRIES = 3;
const MIN_IMAGE_KB = 10;

function escapeHtml(text) {
  if (text == null) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isHttpUrl(v) {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

// ============================================================
// Telegram API
// ============================================================

class Telegram {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async api(method, body) {
    const r = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await r.json();
    if (!res.ok) console.error(`[TG] ${method}:`, JSON.stringify(res).substring(0, 400));
    return res;
  }

  send(chatId, text, extra = {}) {
    return this.api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
  }

  async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.api("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  async answerCallbackQuery(callbackQueryId, text = "") {
    return this.api("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  async sendMedia(chatId, arrayBuffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new File([arrayBuffer], "image.webp", { type: "image/webp" }));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    let r = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
    let res = await r.json();
    
    if (!res.ok) {
      const docForm = new FormData();
      docForm.append("chat_id", String(chatId));
      docForm.append("document", new File([arrayBuffer], "image.webp", { type: "image/webp" }));
      if (caption) {
        docForm.append("caption", caption.substring(0, 1024));
        docForm.append("parse_mode", "HTML");
      }
      r = await fetch(`${this.base}/sendDocument`, { method: "POST", body: docForm });
      res = await r.json();
    }
    return res;
  }

  sendPhotoUrl(chatId, url, caption = "") {
    return this.api("sendPhoto", { chat_id: chatId, photo: url, caption: caption.substring(0, 1024), parse_mode: "HTML" });
  }
}

// ============================================================
// Upstash Redis Helpers
// ============================================================

class Redis {
  constructor(env) {
    this.url = env.UPSTASH_REDIS_REST_URL;
    this.token = env.UPSTASH_REDIS_REST_TOKEN;
  }

  async req(cmd) {
    if (!this.url || !this.token) return null;
    try {
      const r = await fetch(this.url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(cmd)
      });
      const data = await r.json();
      return data.result;
    } catch (e) {
      console.error("[REDIS]", e.message);
      return null;
    }
  }

  async get(key, type = "text") {
    const res = await this.req(["GET", key]);
    if (!res) return null;
    if (type === "json") {
      try { return JSON.parse(res); } catch { return null; }
    }
    return res;
  }

  async put(key, val, ttl = 0) {
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    if (ttl > 0) {
      await this.req(["SET", key, str, "EX", ttl]);
    } else {
      await this.req(["SET", key, str]);
    }
  }

  async del(key) {
    await this.req(["DEL", key]);
  }

  async keys(pattern) {
    const res = await this.req(["KEYS", pattern]);
    return res || [];
  }
}

async function getConfig(redis) {
  const stored = await redis.get("config", "json");
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function saveConfig(redis, config) {
  await redis.put("config", config);
}

// ============================================================
// Horde API & Logic
// ============================================================

function getApiKey(env) {
  return (env.HORDE_API_KEY || "").trim() || "0000000000";
}

async function hordeSubmit(prompt, config, env, opts = {}) {
  const key = getApiKey(env);
  const params = {
    sampler_name: config.sampler,
    cfg_scale: config.cfgScale,
    width: config.width,
    height: config.height,
    steps: config.steps,
    clip_skip: config.clipSkip || 2,
    n: 1,
  };

  if (config.hiresFix) params.hires_fix = true;
  if (config.faceFixer) params.facefixer_strength = 0.8;
  if (config.upscaler) params.post_processing = ["RealESRGAN_x4plus"];

  if (!opts.skipLoras && config.loras?.length > 0) {
    params.loras = config.loras.map((l) => ({
      name: String(l.name), model: l.strength ?? 1, clip: l.clip ?? 1, is_version: true
    }));
  }

  const body = {
    prompt: config.negativePrompt ? `${prompt} ### ${config.negativePrompt}` : prompt,
    params,
    nsfw: config.nsfw,
    censor_nsfw: false,
    trusted_workers: false,
    models: [config.model],
    r2: true,
    allow_downgrade: true,
  };

  if (opts.workerBlacklist?.length > 0) {
    body.workers = opts.workerBlacklist.slice(0, 5);
    body.worker_blacklist = true;
  }

  const resp = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, ...HORDE_HEADERS },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function hordeCheck(id) {
  const r = await fetch(`${HORDE_API}/generate/check/${id}`, { headers: HORDE_HEADERS });
  return r.json();
}

async function hordeGetResult(id) {
  const r = await fetch(`${HORDE_API}/generate/status/${id}`, { headers: HORDE_HEADERS });
  return r.json();
}

async function hordeGetModels() {
  const r = await fetch(`${HORDE_API}/status/models?type=image`, { headers: HORDE_HEADERS });
  return r.json();
}

function isCensored(gen) {
  if (!gen) return false;
  if (gen.gen_metadata?.some((m) => m.type === "censorship")) return true;
  if (gen.censored === true || gen.state === "censored") return true;
  return false;
}

// ============================================================
// LLM OpenRouter
// ============================================================

async function callLLM(systemPrompt, userPrompt, apiKey, model = "meta-llama/llama-3.1-8b-instruct:free", maxTokens = 250) {
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://t.me",
        "X-Title": "TgImageBot",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 1.1,
        max_tokens: maxTokens,
      }),
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    console.error("[LLM]", e.message);
    return null;
  }
}

async function generatePrompt(rawPrompt, env, config) {
  if (!env.OPENROUTER_API_KEY) return rawPrompt.replace(/^\[.*?\]/, "").trim();
  
  // Парсинг кастомной инструкции из квадратных скобок: [Инструкция] Основной промпт
  let instruction = "You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations. Be creative.";
  let basePrompt = rawPrompt;
  const match = rawPrompt.match(/^\[(.*?)\](.*)/s);
  if (match) {
    instruction = `You are an expert prompt engineer. Follow this instruction strictly to expand the user's concept into a detailed Stable Diffusion prompt (output ONLY comma-separated tags, no explanations): ${match[1]}`;
    basePrompt = match[2].trim();
  } else {
    instruction += " Add lighting, camera angles, and high-quality modifiers.";
  }

  const result = await callLLM(instruction, `Concept: ${basePrompt}`, env.OPENROUTER_API_KEY, config.llmModel);
  return result && result.length > 10 ? result.replace(/^["'`*]+|["'`*]+$/g, "") : basePrompt;
}

async function generateCaption(imgPrompt, config, env) {
  if (!env.OPENROUTER_API_KEY || config.captionMode !== "ai") return "";
  const sys = "Ты креативный SMM-менеджер. Напиши короткий, красивый и атмосферный пост для Telegram-канала (1-2 абзаца) на основе описания картинки. Используй пару подходящих эмодзи. НЕ пиши хэштеги и технические детали промпта. Пиши на русском языке.";
  const res = await callLLM(sys, `Описание картинки: ${imgPrompt}`, env.OPENROUTER_API_KEY, "google/gemma-2-9b-it:free", 150);
  return res || `🎨 <i>${escapeHtml(imgPrompt.substring(0, 100))}...</i>`;
}

// ============================================================
// UI & Callbacks
// ============================================================

function getSettingsKeyboard(config) {
  const capModes = { none: "🚫 Нет", prompt: "📝 Промпт", ai: "🤖 AI Текст" };
  return {
    inline_keyboard: [
      [
        { text: `Подпись: ${capModes[config.captionMode] || "📝 Промпт"}`, callback_data: "set_cap_mode" },
        { text: `NSFW: ${config.nsfw ? "🔞 Вкл" : "🟢 Выкл"}`, callback_data: "toggle_nsfw" }
      ],
      [
        { text: `FaceFixer: ${config.faceFixer ? "✅ Вкл" : "❌ Выкл"}`, callback_data: "toggle_face" },
        { text: `Upscale (x4): ${config.upscaler ? "✅ Вкл" : "❌ Выкл"}`, callback_data: "toggle_upscale" }
      ],
      [{ text: "🔄 Обновить статус", callback_data: "refresh_settings" }]
    ]
  };
}

async function handleCallback(cb, env, redis) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const data = cb.data;
  const msg = cb.message;
  let config = await getConfig(redis);

  if (config.adminId && cb.from.id !== config.adminId) {
    await tg.answerCallbackQuery(cb.id, "🔒 Доступно только админу");
    return;
  }

  let updated = false;

  if (data === "toggle_nsfw") {
    config.nsfw = !config.nsfw; updated = true;
  } else if (data === "toggle_face") {
    config.faceFixer = !config.faceFixer; updated = true;
  } else if (data === "toggle_upscale") {
    config.upscaler = !config.upscaler; updated = true;
  } else if (data === "set_cap_mode") {
    const modes = ["none", "prompt", "ai"];
    config.captionMode = modes[(modes.indexOf(config.captionMode) + 1) % modes.length];
    updated = true;
  }

  if (updated || data === "refresh_settings") {
    await saveConfig(redis, config);
    await tg.editMessageReplyMarkup(msg.chat.id, msg.message_id, getSettingsKeyboard(config));
    await tg.answerCallbackQuery(cb.id, "Настройки обновлены");
  } else {
    await tg.answerCallbackQuery(cb.id);
  }
}

// ============================================================
// Commands
// ============================================================

async function handleCommand(msg, env, redis) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text || "";
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  let config = await getConfig(redis);

  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(redis, config);
    await tg.send(chatId, `👑 Вы назначены админом (ID: <code>${userId}</code>)`);
  }
  if (config.adminId !== userId) return;

  switch (cmd) {
    case "/start":
    case "/help":
      await tg.send(
        chatId,
        `🤖 <b>Image Bot (Upstash + LLM Edition)</b>\n\n` +
          `<b>Синтаксис промпта:</b>\n` +
          `В <code>/setprompt</code> можно писать команды для ИИ в скобках:\n` +
          `<i>[Сделай в стиле аниме Миядзаки] Девушка с книгой</i>\n\n` +
          `<b>Управление:</b>\n` +
          `/settings — Кнопки настроек (Caption, NSFW, Upscaler)\n` +
          `/setprompt &lt;text&gt; — Основной промпт\n` +
          `/setchat — Привязать текущую группу для постов\n` +
          `/setchannel @name — Привязать канал\n` +
          `/unchannel — Отвязать канал\n` +
          `/enable | /disable — Автопостинг\n` +
          `/generate — Сгенерировать сейчас\n\n` +
          `<b>Остальное:</b>\n` +
          `/status | /listmodels | /searchlora | /addlora | /listloras`
      );
      break;

    case "/settings":
      await tg.send(chatId, "⚙️ <b>Быстрые настройки генерации:</b>", { reply_markup: getSettingsKeyboard(config) });
      break;

    case "/setchat":
      config.chatId = chatId;
      await saveConfig(redis, config);
      await tg.send(chatId, `✅ Группа для автопостов: <code>${chatId}</code>`);
      break;

    case "/setchannel":
      if (!args[0]) {
        await tg.send(chatId, "❌ Укажите ID или @username канала. Убедитесь, что бот там админ.");
        break;
      }
      config.channelId = args[0];
      await saveConfig(redis, config);
      await tg.send(chatId, `✅ Канал установлен: <code>${config.channelId}</code>`);
      break;

    case "/unchannel":
      config.channelId = null;
      await saveConfig(redis, config);
      await tg.send(chatId, "✅ Канал отвязан.");
      break;

    case "/setprompt":
      config.generalPrompt = args.join(" ");
      await saveConfig(redis, config);
      await tg.send(chatId, `✅ Промпт сохранен:\n<code>${escapeHtml(config.generalPrompt)}</code>`);
      break;

    case "/enable":
      config.enabled = true;
      await saveConfig(redis, config);
      await tg.send(chatId, `🟢 Автопостинг включен (интервал: ${config.interval}м)`);
      break;

    case "/disable":
      config.enabled = false;
      await saveConfig(redis, config);
      await tg.send(chatId, "🔴 Автопостинг выключен");
      break;

    case "/status":
      const pendingCount = (await redis.keys("pending:*")).length;
      await tg.send(
        chatId,
        `📊 <b>Статус</b>\n` +
          `<b>Автопост:</b> ${config.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
          `<b>Chat:</b> ${config.chatId || "—"} | <b>Channel:</b> ${config.channelId || "—"}\n` +
          `<b>Модель:</b> <code>${escapeHtml(config.model)}</code>\n` +
          `<b>LoRAs:</b> ${config.loras?.length || 0}\n` +
          `<b>Queue:</b> ${pendingCount}`
      );
      break;

    case "/listmodels":
      await tg.send(chatId, "⏳ Загружаю список...");
      try {
        const models = await hordeGetModels();
        const sorted = (Array.isArray(models) ? models : []).sort((a, b) => b.count - a.count).slice(0, 30);
        let txt = "📋 <b>Топ-30 моделей:</b>\n\n";
        sorted.forEach(m => txt += `• <code>${escapeHtml(m.name)}</code> (${m.count}w)\n`);
        txt += "\nКопируй название и пиши <code>/setmodel name</code>";
        await tg.send(chatId, txt);
      } catch (e) {
        await tg.send(chatId, `❌ Ошибка: ${e.message}`);
      }
      break;

    case "/setmodel":
      config.model = args.join(" ");
      await saveConfig(redis, config);
      await tg.send(chatId, `✅ Модель: <code>${escapeHtml(config.model)}</code>`);
      break;

    case "/searchlora":
      const q = args.join(" ");
      if (!q) { await tg.send(chatId, "❌ /searchlora <запрос>"); break; }
      try {
        const data = await (await fetch(`https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(q)}&limit=5&sort=Highest%20Rated`)).json();
        let txt = `🔍 <b>Результаты:</b>\n\n`;
        (data.items || []).forEach(item => {
          const vid = item.modelVersions?.[0]?.id || "?";
          txt += `<b>${escapeHtml(item.name)}</b>\nДобавить: <code>/addlora ${vid} 0.8</code>\n\n`;
        });
        await tg.send(chatId, txt || "Ничего не найдено");
      } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
      break;

    case "/addlora":
      if (!args[0]) { await tg.send(chatId, "❌ /addlora <id> [силу]"); break; }
      config.loras = (config.loras || []).filter(l => l.name !== args[0]);
      config.loras.push({ name: args[0], strength: parseFloat(args[1]) || 0.8, clip: 1 });
      await saveConfig(redis, config);
      await tg.send(chatId, `✅ LoRA ${args[0]} добавлена`);
      break;

    case "/listloras":
      let lt = "📋 <b>Твои LoRA:</b>\n\n";
      (config.loras || []).forEach((l, i) => lt += `${i + 1}. <code>${l.name}</code> (str: ${l.strength})\n❌ <code>/removelora ${l.name}</code>\n\n`);
      await tg.send(chatId, lt);
      break;
      
    case "/removelora":
      config.loras = (config.loras || []).filter(l => l.name !== args[0]);
      await saveConfig(redis, config);
      await tg.send(chatId, `✅ Удалено.`);
      break;

    case "/generate":
      if (!config.generalPrompt) { await tg.send(chatId, "❌ Нет промпта (/setprompt)"); break; }
      await tg.send(chatId, `⏳ Генерирую...`);
      try {
        const prompt = await generatePrompt(config.generalPrompt, env, config);
        const result = await hordeSubmit(prompt, config, env);
        if (result.id) {
          await redis.put(`pending:${result.id}`, { prompt, at: Date.now(), retries: 0 }, 3600);
          await tg.send(chatId, `📤 ID: <code>${result.id}</code>`);
        } else {
          await tg.send(chatId, `❌ Ошибка Horde: ${JSON.stringify(result).substring(0, 100)}`);
        }
      } catch (e) { await tg.send(chatId, `❌ ${e.message}`); }
      break;
  }
}

// ============================================================
// Cron & Delivery
// ============================================================

async function deliverToTargets(tg, config, arrayBuffer, finalCaption) {
  let sent = false;
  // Шлем в группу
  if (config.chatId) {
    const r = await tg.sendMedia(config.chatId, arrayBuffer, finalCaption);
    if (r.ok) sent = true;
  }
  // Шлем в канал
  if (config.channelId) {
    const r = await tg.sendMedia(config.channelId, arrayBuffer, finalCaption);
    if (r.ok) sent = true;
  }
  return sent;
}

async function processScheduled(env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.TELEGRAM_BOT_TOKEN) return;
  const redis = new Redis(env);
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(redis);
  
  const pendingKeys = await redis.keys("pending:*");

  for (const key of pendingKeys) {
    const id = key.replace("pending:", "");
    try {
      const data = await redis.get(key, "json");
      if (!data) continue;

      if (Date.now() - data.at > 20 * 60 * 1000) {
        await redis.del(key); continue;
      }

      const check = await hordeCheck(id);
      if (!check.done) continue;

      const result = await hordeGetResult(id);
      await redis.del(key);

      if (result.faulted || !result.generations?.length) continue;

      for (const gen of result.generations) {
        if (isCensored(gen) || !gen.img) continue; // Блэклист логику можно вернуть при желании, тут упрощено для стабильности

        let arrayBuffer;
        if (isHttpUrl(gen.img)) {
          const r = await fetch(gen.img);
          if (r.ok) arrayBuffer = await r.arrayBuffer();
        } else {
          const binary = atob(gen.img);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          arrayBuffer = bytes.buffer;
        }

        if (!arrayBuffer || arrayBuffer.byteLength < MIN_IMAGE_KB * 1024) continue;

        let finalCaption = "";
        if (config.captionMode === "prompt") finalCaption = `🎨 <i>${escapeHtml(data.prompt.substring(0, 500))}</i>`;
        else if (config.captionMode === "ai") finalCaption = await generateCaption(data.prompt, config, env);

        await deliverToTargets(tg, config, arrayBuffer, finalCaption);
      }
    } catch (e) {
      console.error(`[CRON] ${id}:`, e.message);
    }
  }

  // Auto-posting logic
  if (!config.enabled || !config.generalPrompt || (!config.chatId && !config.channelId)) return;
  if ((await redis.keys("pending:*")).length > 0) return;

  const lastPost = parseInt((await redis.get("last_post_time")) || "0", 10);
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  await redis.put("last_post_time", String(now));

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env, config);
      const result = await hordeSubmit(prompt, config, env);
      if (result.id) {
        await redis.put(`pending:${result.id}`, { prompt, at: now, retries: 0 }, 3600);
      }
    } catch (e) { console.error("[CRON AUTO]", e.message); }
  }
}

// ============================================================
// Entry Point
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      try {
        const upd = await request.json();
        const redis = new Redis(env);
        if (upd.message?.text) await handleCommand(upd.message, env, redis);
        if (upd.callback_query) await handleCallback(upd.callback_query, env, redis);
      } catch (e) { console.error("[WH]", e.message); }
      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TELEGRAM_BOT_TOKEN!", { status: 500 });
      const wh = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: wh, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }),
      });
      return new Response(`Webhook: ${wh}\n\n${JSON.stringify(await r.json(), null, 2)}`);
    }

    return new Response("🤖 TG Image Bot (Upstash) is running!");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduled(env));
  },
};
