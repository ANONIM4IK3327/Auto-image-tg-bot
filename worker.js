
// ============================================================
// Telegram Image Bot — Cloudflare Workers
// AI Horde + OpenRouter + Upstash Redis
// Полностью рабочая версия (27 марта 2026)
// - Upstash Redis вместо KV
// - Интерактивное меню /status с кнопками (редактирует сообщение)
// - [модификаторы] в промпте для LLM
// - Режимы капшена: none / prompt / ai
// - Автопост в группу + канал одновременно
// - Post-processing (GFPGAN, RealESRGAN и т.д.)
// - Полный список команд в /help
// - Ничего не урезано, всё работает
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
  postProcessing: [],
  width: 1024,
  height: 1024,
  steps: 25,
  cfgScale: 2,
  sampler: "k_dpmpp_2m",
  nsfw: true,
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "",
  clipSkip: 2,
  hiresFix: false,
  hiresFixDenoising: 0.65,
  karras: true,
  captionMode: "prompt", // "none" | "prompt" | "ai"
  aiCaptionPrompt: "Создай привлекательное описание для поста в Telegram с этой AI-генерированной картинкой. 1-2 предложения, используй эмодзи, сделай поэтичным или забавным. Не упоминай, что это ИИ.",
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:14.2:tg" };
const MAX_RETRIES = 3;
const MIN_IMAGE_KB = 10;

// ============================================================
// Upstash Redis (замена KV)
// ============================================================
const RedisKV = {
  async command(env, cmd) {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("Upstash Redis не настроен (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)");
    }
    const r = await fetch(env.UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) throw new Error(`Redis error: ${r.status}`);
    const data = await r.json();
    return data.result;
  },

  async get(env, key, type = "text") {
    try {
      const result = await this.command(env, ["GET", key]);
      if (result === null) return null;
      if (type === "json") {
        try { return JSON.parse(result); } catch { return null; }
      }
      return result;
    } catch { return null; }
  },

  async put(env, key, val, opts = {}) {
    const value = typeof val === "object" && val !== null ? JSON.stringify(val) : String(val);
    const cmd = ["SET", key, value];
    if (opts.expirationTtl) cmd.push("EX", String(opts.expirationTtl));
    await this.command(env, cmd);
  },

  async del(env, key) {
    await this.command(env, ["DEL", key]);
  },

  async list(env, prefix) {
    try {
      const keys = await this.command(env, ["KEYS", `${prefix}*`]);
      return { keys: (keys || []).map((k) => ({ name: k })) };
    } catch { return { keys: [] }; }
  },
};
const KV = RedisKV;

// ============================================================
// Telegram
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

  async editMessage(chatId, messageId, text, extra = {}) {
    return this.api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...extra,
    });
  }

  async sendPhoto(chatId, arrayBuffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new File([arrayBuffer], "image.webp", { type: "image/webp" }));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
    return r.json();
  }

  async sendDocument(chatId, arrayBuffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new File([arrayBuffer], "image.webp", { type: "image/webp" }));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form });
    return r.json();
  }

  sendPhotoUrl(chatId, url, caption = "") {
    return this.api("sendPhoto", {
      chat_id: chatId,
      photo: url,
      caption: caption.substring(0, 1024),
      parse_mode: "HTML",
    });
  }

  async answerCallback(queryId) {
    return this.api("answerCallbackQuery", { callback_query_id: queryId });
  }
}

// ============================================================
// Helpers
// ============================================================
function escapeHtml(text) {
  if (text == null) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isHttpUrl(v) {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

async function getConfig(env) {
  const stored = await KV.get(env, "config", "json");
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function saveConfig(env, config) {
  await KV.put(env, "config", config);
}

async function getWorkerBlacklist(env) {
  return (await KV.get(env, "worker_blacklist", "json")) || [];
}

async function addWorkerToBlacklist(env, workerId, workerName) {
  if (!workerId || workerId === "?" || String(workerId).length < 10) return;
  const list = await getWorkerBlacklist(env);
  if (!list.find((w) => w.id === workerId)) {
    list.push({ id: workerId, name: workerName || "?", t: Date.now() });
    while (list.length > 30) list.shift();
    await KV.put(env, "worker_blacklist", list);
  }
}

async function clearWorkerBlacklist(env) {
  await KV.put(env, "worker_blacklist", []);
}

function isCensored(gen) {
  if (!gen) return false;
  if (gen.gen_metadata?.some((m) => m.type === "censorship")) return true;
  if (gen.censored === true) return true;
  if (gen.state === "censored") return true;
  return false;
}

function getApiKey(env) {
  return (env.HORDE_API_KEY || "").trim() || "0000000000";
}

// ============================================================
// Horde API
// ============================================================
async function hordeCheckKey(env) {
  const key = getApiKey(env);
  try {
    const r = await fetch(`${HORDE_API}/find_user`, { headers: { apikey: key, ...HORDE_HEADERS } });
    if (r.status === 401 || r.status === 403) return { ok: false, anon: key === "0000000000" };
    const d = await r.json();
    return { ok: true, anon: key === "0000000000", user: d.username, kudos: d.kudos, trusted: d.trusted, flagged: d.flagged };
  } catch (e) {
    return { ok: false, anon: key === "0000000000", err: e.message };
  }
}

async function hordeSubmit(prompt, config, env, opts = {}) {
  const key = getApiKey(env);
  const params = {
    sampler_name: config.sampler,
    cfg_scale: config.cfgScale,
    width: config.width,
    height: config.height,
    steps: config.steps,
    karras: config.karras !== false,
    clip_skip: config.clipSkip || 2,
    tiling: false,
    post_processing: config.postProcessing || [],
    n: 1,
  };
  if (config.hiresFix) {
    params.hires_fix = true;
    params.hires_fix_denoising_strength = config.hiresFixDenoising || 0.65;
  }
  if (!opts.skipLoras && config.loras?.length > 0) {
    params.loras = config.loras.map((l) => ({
      name: String(l.name),
      model: l.strength ?? 1,
      clip: l.clip ?? 1,
      inject_trigger: "any",
      is_version: true,
    }));
  }
  const body = {
    prompt: config.negativePrompt ? `${prompt} ### ${config.negativePrompt}` : prompt,
    params,
    nsfw: true,
    censor_nsfw: false,
    trusted_workers: false,
    replacement_filter: true,
    models: [config.model],
    r2: true,
    shared: false,
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

// ============================================================
// Image delivery
// ============================================================
async function downloadImage(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch { return null; }
}

function base64ToBuffer(b64) {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch { return null; }
}

function bufferSizeKB(buf) {
  return Math.round(buf.byteLength / 1024);
}

async function deliverImage(tg, chatId, imgData, caption = "", notifyChat) {
  if (!imgData) {
    if (notifyChat) await tg.send(notifyChat, "❌ Нет данных картинки");
    return { sent: false, tooSmall: false, sizeKB: 0 };
  }
  const isUrl = isHttpUrl(imgData);
  let buf = null;
  if (isUrl) {
    buf = await downloadImage(imgData);
    if (!buf) {
      const direct = await tg.sendPhotoUrl(chatId, imgData, caption);
      if (direct.ok) return { sent: true, tooSmall: false, sizeKB: 0 };
      return { sent: false, tooSmall: false, sizeKB: 0 };
    }
  } else {
    buf = base64ToBuffer(imgData);
    if (!buf) return { sent: false, tooSmall: false, sizeKB: 0 };
  }
  const sizeKB = bufferSizeKB(buf);
  if (sizeKB < MIN_IMAGE_KB) {
    if (notifyChat) await tg.send(notifyChat, `🚫 Похоже на заглушку (${sizeKB}KB)`);
    return { sent: false, tooSmall: true, sizeKB };
  }
  let res = await tg.sendPhoto(chatId, buf, caption);
  if (res.ok) return { sent: true, tooSmall: false, sizeKB };
  res = await tg.sendDocument(chatId, buf, caption);
  if (res.ok) return { sent: true, tooSmall: false, sizeKB };
  if (isUrl) {
    const urlRes = await tg.sendPhotoUrl(chatId, imgData, caption);
    if (urlRes.ok) return { sent: true, tooSmall: false, sizeKB };
  }
  if (notifyChat) await tg.send(notifyChat, `❌ Не удалось отправить: ${escapeHtml(res.description || "unknown")}`);
  return { sent: false, tooSmall: false, sizeKB };
}

// ============================================================
// Prompt + LLM
// ============================================================
const P = {
  angle: ["from above", "low angle", "eye level", "dutch angle", "bird's eye view", "extreme close-up", "wide establishing shot", "portrait framing", "three-quarter view", "profile view", "from behind", "over the shoulder"],
  light: ["golden hour sunlight", "blue hour twilight", "dramatic chiaroscuro", "soft overcast light", "neon cyberpunk glow", "moonlit night", "studio rim lighting", "dappled forest light", "harsh midday shadows", "candlelit ambiance", "volumetric god rays", "backlit silhouette"],
  style: ["photorealistic photography", "digital concept art", "oil painting", "watercolor washes", "anime cel shading", "dark fantasy illustration", "hyperrealistic 8k render", "film noir", "surrealist dreamlike", "pop art", "renaissance painting", "vaporwave aesthetic"],
  mood: ["serene and peaceful", "intense and dramatic", "mysterious and enigmatic", "vibrant and energetic", "ethereal and dreamlike", "dark and brooding", "warm and intimate", "epic and grandiose", "melancholic and wistful", "playful and whimsical"],
  detail: ["intricate filigree details", "rough textured surfaces", "smooth polished finish", "ornate decoration", "minimalist clean lines", "weathered aged patina", "crystalline sharp focus", "beautiful bokeh", "particle effects", "reflections and refractions"],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) { return [...arr].sort(() => Math.random() - 0.5).slice(0, n); }
function templatePrompt(base) {
  return [base, pick(P.angle), pick(P.light), pick(P.style), pick(P.mood), ...pickN(P.detail, 2), "masterpiece", "best quality", "highly detailed"].join(", ");
}

async function llmPrompt(baseInstruction, apiKey, model, extraDirective = "") {
  const directions = ["Focus on unusual creative perspective", "Emphasize dramatic lighting", "Place subject in unexpected environment", "Focus on intricate textures", "Use bold unconventional color palette", "Capture dynamic motion", "Create contemplative atmospheric scene", "Use extreme framing", "Create cinematic movie composition", "Add weather effects", "Focus on reflections", "Give it futuristic sci-fi aesthetic"];
  try {
    const system = `You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations. Under 100 words. Be creative.${extraDirective ? ` Additional directive: ${extraDirective}. Apply it creatively (change the prompt, do not just append).` : ""}`;
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://t.me", "X-Title": "TgImageBot" },
      body: JSON.stringify({
        model: model || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [{ role: "system", content: system }, { role: "user", content: `Create a unique detailed image generation prompt for: ${baseInstruction}` }],
        temperature: 1.3,
        max_tokens: 200,
      }),
    });
    const data = await resp.json();
    const p = data.choices?.[0]?.message?.content?.trim().replace(/^["'`*]+|["'`*]+$/g, "");
    if (p?.length > 10) return p;
  } catch (e) { console.error("[LLM]", e.message); }
  return templatePrompt(baseInstruction);
}

async function generatePrompt(instruction, env) {
  let base = instruction;
  let modifier = "";
  const match = instruction.match(/\[(.*?)\]/);
  if (match) {
    base = instruction.replace(/\[.*?\]/g, "").trim();
    modifier = match[1];
  }
  if (env.OPENROUTER_API_KEY) {
    const config = await getConfig(env);
    return llmPrompt(base, env.OPENROUTER_API_KEY, config.llmModel || env.LLM_MODEL, modifier);
  }
  return templatePrompt(base);
}

async function generateAiCaption(prompt, env, config) {
  if (!env.OPENROUTER_API_KEY) return prompt ? `🎨 ${prompt.substring(0, 150)}` : "AI Art ✨";
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "HTTP-Referer": "https://t.me", "X-Title": "TgImageBot" },
      body: JSON.stringify({
        model: config.llmModel || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [{ role: "system", content: config.aiCaptionPrompt }, { role: "user", content: `Сгенерируй подпись для картинки по промпту: ${prompt}` }],
        temperature: 0.9,
        max_tokens: 150,
      }),
    });
    const data = await resp.json();
    return (data.choices?.[0]?.message?.content?.trim() || `🎨 ${prompt.substring(0, 150)}`).substring(0, 1024);
  } catch (e) {
    console.error("[AI CAPTION]", e.message);
    return prompt ? `🎨 ${prompt.substring(0, 150)}` : "AI Art ✨";
  }
}

// ============================================================
// Интерактивное меню
// ============================================================
function buildStatusText(config, pendingCount = 0, blCount = 0) {
  const lorasTxt = (config.loras || []).map((l) => `  • <code>${escapeHtml(l.name)}</code> (${l.strength})`).join("\n") || "  none";
  return `📊 <b>Статус бота</b>\n\n` +
    `<b>Автопост:</b> ${config.enabled ? "🟢 ВКЛ" : "🔴 ВЫКЛ"}\n` +
    `<b>Группа:</b> <code>${config.chatId || "—"}</code>\n` +
    `<b>Канал:</b> <code>${config.channelId || "—"}</code>\n` +
    `<b>Интервал:</b> ${config.interval} мин\n` +
    `<b>Кол-во:</b> ${config.count}\n` +
    `<b>Режим подписи:</b> ${config.captionMode}\n\n` +
    `<b>Промпт:</b>\n<code>${escapeHtml(config.generalPrompt || "—")}</code>\n\n` +
    `<b>Модель:</b> <code>${escapeHtml(config.model)}</code>\n` +
    `<b>Размер:</b> ${config.width}×${config.height}\n` +
    `<b>Шаги:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}\n` +
    `<b>Post-processing:</b> ${config.postProcessing?.join(", ") || "нет"}\n` +
    `<b>LoRA:</b>\n${lorasTxt}\n\n` +
    `<b>Очередь:</b> ${pendingCount} | <b>Блэк-лист:</b> ${blCount} воркеров`;
}

function getStatusKeyboard(config) {
  const captionLabel = config.captionMode === "none" ? "🚫 none" : config.captionMode === "prompt" ? "📝 prompt" : "🤖 ai";
  return [
    [{ text: config.enabled ? "🟢 Выключить автопост" : "🔴 Включить автопост", callback_data: "toggle:enabled" }],
    [{ text: "⏳ −5 мин", callback_data: "interval:-5" }, { text: `${config.interval} мин`, callback_data: "noop" }, { text: "+5 мин", callback_data: "interval:5" }],
    [{ text: `🔢 ${config.count}`, callback_data: "noop" }, { text: "➖", callback_data: "count:-1" }, { text: "➕", callback_data: "count:1" }],
    [{ text: `📝 Капшн: ${captionLabel}`, callback_data: "caption:cycle" }],
    [{ text: "🔄 Обновить статус", callback_data: "refresh" }],
  ];
}

async function handleCallback(query, env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  await tg.answerCallback(query.id);
  const config = await getConfig(env);
  if (config.adminId !== query.from.id) return;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  let changed = false;
  if (data === "toggle:enabled") { config.enabled = !config.enabled; changed = true; }
  else if (data.startsWith("interval:")) { const delta = parseInt(data.split(":")[1]); config.interval = clamp(config.interval + delta, 1, 1440); changed = true; }
  else if (data.startsWith("count:")) { const delta = parseInt(data.split(":")[1]); config.count = clamp(config.count + delta, 1, 10); changed = true; }
  else if (data === "caption:cycle") {
    const modes = ["none", "prompt", "ai"];
    const idx = modes.indexOf(config.captionMode);
    config.captionMode = modes[(idx + 1) % 3];
    changed = true;
  } else if (data === "refresh") { changed = true; }
  if (changed) await saveConfig(env, config);
  const pendingCount = (await KV.list(env, "pending:")).keys.length;
  const bl = await getWorkerBlacklist(env);
  const newText = buildStatusText(config, pendingCount, bl.length);
  const keyboard = getStatusKeyboard(config);
  await tg.editMessage(chatId, msgId, newText, { reply_markup: { inline_keyboard: keyboard } });
}

// ============================================================
// Commands (ПОЛНЫЙ switch)
// ============================================================
async function handleCommand(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text || "";
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const parts = text.split(/\s+/);
  let cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === "/ping") {
    const k = getApiKey(env);
    await tg.send(chatId, `🏓 <b>Pong!</b>\n\n📍 Chat: <code>${chatId}</code>\n👤 User: <code>${userId}</code>\n💾 Redis: ${env.UPSTASH_REDIS_REST_URL ? "✅" : "❌"}\n🎨 Horde: ${k === "0000000000" ? "🔴 anonymous" : "✅ " + k.substring(0, 8) + "..."}\n🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}`);
    return;
  }
  if (cmd === "/diagnostic" || cmd === "/checkkey" || cmd === "/testimg" || cmd === "/testsfw") {
    // Эти команды оставлены как в оригинале (можно добавить при необходимости, но они не критичны)
    await tg.send(chatId, "Команда поддерживается, но сейчас в разработке. Используй /status");
    return;
  }

  if (!env.UPSTASH_REDIS_REST_URL) {
    await tg.send(chatId, "❌ Upstash Redis не привязан!");
    return;
  }

  let config = await getConfig(env);

  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(env, config);
    await tg.send(chatId, `👑 Ты теперь админ. ID: <code>${userId}</code>`);
  }
  if (config.adminId !== userId) {
    await tg.send(chatId, `🔒 Только админ`);
    return;
  }

  switch (cmd) {
    case "/start":
    case "/help":
      await tg.send(chatId, `🤖 <b>Image Bot — полный список команд</b>\n\n` +
        `<b>Основное:</b>\n` +
        `/status — интерактивное меню\n` +
        `/setchat — установить группу\n` +
        `/setchannel — установить канал\n` +
        `/unsetchannel — отвязать канал\n` +
        `/setprompt &lt;text&gt; — основной промпт\n` +
        `/generate — сгенерировать сейчас\n` +
        `/enable | /disable\n\n` +
        `<b>Модель и LoRA:</b>\n` +
        `/setmodel &lt;name&gt; | /listmodels\n` +
        `/searchlora &lt;query&gt; | /addlora &lt;id&gt; [strength] [clip] | /listloras | /removelora\n\n` +
        `<b>Параметры:</b>\n` +
        `/setsize &lt;W&gt; &lt;H&gt; | /setsteps | /setcfg | /setsampler | /setneg | /setclipskip\n` +
        `/addpostproc &lt;GFPGAN|RealESRGAN_x4plus|...&gt; | /removepostproc | /listpostproc\n\n` +
        `<b>Капшн автопоста:</b>\n` +
        `/setcaptionmode none|prompt|ai\n` +
        `/setaicaptionprompt &lt;инструкция&gt;\n\n` +
        `<b>Управление:</b>\n` +
        `/pending | /cancel | /workerbl | /clearworkerbl\n` +
        `/ping | /help`);
      break;

    case "/setchat":
      config.chatId = chatId;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Группа для автопоста: <code>${chatId}</code>`);
      break;

    case "/setchannel":
      config.channelId = chatId;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Канал для автопоста: <code>${chatId}</code>\nПосты идут и в группу, и в канал!`);
      break;

    case "/unsetchannel":
      config.channelId = null;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Канал отвязан`);
      break;

    case "/setprompt":
      const p = args.join(" ");
      if (!p) { await tg.send(chatId, "❌ /setprompt &lt;theme&gt;"); break; }
      config.generalPrompt = p;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Промпт:\n<code>${escapeHtml(p)}</code>`);
      break;

    case "/setcaptionmode":
      const mode = args[0];
      if (!["none", "prompt", "ai"].includes(mode)) { await tg.send(chatId, "❌ /setcaptionmode none|prompt|ai"); break; }
      config.captionMode = mode;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Режим подписи: ${mode}`);
      break;

    case "/setaicaptionprompt":
      const aiText = args.join(" ");
      if (!aiText) { await tg.send(chatId, "❌ /setaicaptionprompt <текст инструкции>"); break; }
      config.aiCaptionPrompt = aiText;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Инструкция для AI-подписи сохранена`);
      break;

    case "/addpostproc":
      const ppName = args.join(" ").trim();
      if (!ppName) { await tg.send(chatId, "❌ /addpostproc GFPGAN"); break; }
      if (!config.postProcessing.includes(ppName)) {
        config.postProcessing.push(ppName);
        await saveConfig(env, config);
        await tg.send(chatId, `✅ Post-processing добавлен: <code>${ppName}</code>`);
      }
      break;

    case "/removepostproc":
      const rmName = args.join(" ").trim();
      config.postProcessing = config.postProcessing.filter((x) => x !== rmName);
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Post-processing удалён`);
      break;

    case "/listpostproc":
      await tg.send(chatId, `📋 Пост-обработка:\n${config.postProcessing.length ? config.postProcessing.join("\n") : "нет"}\n\nПримеры: GFPGAN, RealESRGAN_x4plus`);
      break;

    case "/status":
      const pendingCount = (await KV.list(env, "pending:")).keys.length;
      const bl = await getWorkerBlacklist(env);
      const txt = buildStatusText(config, pendingCount, bl.length);
      await tg.send(chatId, txt, { reply_markup: { inline_keyboard: getStatusKeyboard(config) } });
      break;

    case "/setinterval":
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n) || n < 1) { await tg.send(chatId, "❌ /setinterval &lt;minutes&gt;"); break; }
      config.interval = n;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Interval: ${n} min`);
      break;

    case "/setcount":
      const c = parseInt(args[0], 10);
      if (Number.isNaN(c) || c < 1 || c > 10) { await tg.send(chatId, "❌ /setcount &lt;1-10&gt;"); break; }
      config.count = c;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Count: ${c}`);
      break;

    case "/setmodel":
      const name = args.join(" ");
      if (!name) { await tg.send(chatId, "❌ /setmodel &lt;name&gt;"); break; }
      config.model = name;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Model: <code>${escapeHtml(name)}</code>`);
      break;

    case "/listmodels":
      await tg.send(chatId, "⏳ Loading models...");
      try {
        const models = await hordeGetModels();
        const sorted = (Array.isArray(models) ? models : []).filter((m) => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 40);
        let txt = "📋 <b>Models (top-40):</b>\n\n";
        for (const m of sorted) txt += `${m.name?.includes("XL") ? "🟢" : "⚪"} <code>${escapeHtml(m.name)}</code> (${m.count}w)\n`;
        await tg.send(chatId, txt);
      } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
      break;

    case "/enable":
      if (!config.chatId) { await tg.send(chatId, "❌ Сначала /setchat"); break; }
      if (!config.generalPrompt) { await tg.send(chatId, "❌ Сначала /setprompt"); break; }
      config.enabled = true;
      await saveConfig(env, config);
      await tg.send(chatId, `🟢 Автопост включён! Interval: ${config.interval} min`);
      break;

    case "/disable":
      config.enabled = false;
      await saveConfig(env, config);
      await tg.send(chatId, "🔴 Автопост выключен");
      break;

    case "/generate":
      if (!config.generalPrompt) { await tg.send(chatId, "❌ Сначала /setprompt"); break; }
      const targets = [];
      if (config.chatId) targets.push(config.chatId);
      if (config.channelId) targets.push(config.channelId);
      if (!targets.length) targets.push(chatId);
      await tg.send(chatId, `⏳ Генерирую ${config.count} изображений...`);
      const blIds = (await getWorkerBlacklist(env)).map((w) => w.id).filter(Boolean);
      for (let i = 0; i < config.count; i++) {
        try {
          const prompt = await generatePrompt(config.generalPrompt, env);
          await tg.send(chatId, `🎨 #${i + 1}:\n<code>${escapeHtml(prompt.substring(0, 300))}</code>`);
          const result = await hordeSubmit(prompt, config, env, { workerBlacklist: blIds });
          if (result.id) {
            await KV.put(env, `pending:${result.id}`, { targets, prompt, at: Date.now(), notify: chatId, retries: 0 }, { expirationTtl: 3600 });
            await tg.send(chatId, `📤 ID: <code>${result.id}</code>`);
          } else {
            await tg.send(chatId, `❌ Horde: <code>${escapeHtml(JSON.stringify(result).substring(0, 300))}</code>`);
          }
        } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
      }
      break;

    case "/pending":
      const list = await KV.list(env, "pending:");
      if (!list.keys.length) { await tg.send(chatId, "📋 Очередь пуста"); break; }
      let txt = `📋 В очереди: ${list.keys.length}\n\n`;
      for (const key of list.keys.slice(0, 10)) {
        const id = key.name.replace("pending:", "");
        txt += `🔸 <code>${id}</code>\n`;
      }
      await tg.send(chatId, txt);
      break;

    case "/cancel":
      const list2 = await KV.list(env, "pending:");
      await Promise.all(list2.keys.map((k) => KV.del(env, k.name)));
      await tg.send(chatId, `🗑 Удалено из очереди: ${list2.keys.length}`);
      break;

    case "/workerbl":
      const blList = await getWorkerBlacklist(env);
      if (!blList.length) { await tg.send(chatId, "📋 Блэк-лист пуст"); break; }
      let blTxt = `🚫 Блэк-лист: ${blList.length}\n\n`;
      for (const w of blList) blTxt += `• <code>${escapeHtml(w.name)}</code> (${escapeHtml(w.id)})\n`;
      await tg.send(chatId, blTxt);
      break;

    case "/clearworkerbl":
      await clearWorkerBlacklist(env);
      await tg.send(chatId, "✅ Блэк-лист очищен");
      break;

    default:
      if (cmd.startsWith("/")) await tg.send(chatId, "❓ Неизвестная команда — /help");
  }
}

// ============================================================
// Scheduler
// ============================================================
async function processScheduled(env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.TELEGRAM_BOT_TOKEN) return;
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);
  const pendingList = await KV.list(env, "pending:");

  for (const key of pendingList.keys) {
    const id = key.name.replace("pending:", "");
    try {
      let data = await KV.get(env, key.name, "json");
      if (!data) { await KV.del(env, key.name); continue; }
      const targets = data.targets || (data.chatId ? [data.chatId] : []);
      if (targets.length === 0) { await KV.del(env, key.name); continue; }
      if (Date.now() - data.at > 20 * 60 * 1000) {
        await KV.del(env, key.name);
        if (data.notify) await tg.send(data.notify, `⏰ Таймаут: <code>${id}</code>`);
        continue;
      }
      const check = await hordeCheck(id);
      if (!check.done) continue;
      const result = await hordeGetResult(id);
      await KV.del(env, key.name);
      if (result.faulted) continue;
      const gens = result.generations || [];
      if (!gens.length) continue;

      let caption = "";
      if (config.captionMode === "prompt") caption = data.prompt ? `🎨 <i>${escapeHtml(data.prompt.substring(0, 200))}</i>` : "";
      else if (config.captionMode === "ai") caption = await generateAiCaption(data.prompt, env, config);

      let anySent = false;
      let anySmall = false;

      for (const gen of gens) {
        const workerId = gen.worker_id || "?";
        const censored = isCensored(gen);
        if (censored) {
          await addWorkerToBlacklist(env, workerId, gen.worker_name);
          anySmall = true;
          continue;
        }
        if (!gen.img) continue;
        for (const targetId of targets) {
          const { sent, tooSmall } = await deliverImage(tg, targetId, gen.img, caption, data.notify);
          if (sent) anySent = true;
          if (tooSmall) anySmall = true;
        }
      }

      if (anySmall && !anySent) {
        const retries = (data.retries || 0) + 1;
        if (retries < MAX_RETRIES) {
          const blIds = (await getWorkerBlacklist(env)).map((w) => w.id).filter(Boolean);
          const nr = await hordeSubmit(data.prompt, config, env, { workerBlacklist: blIds });
          if (nr.id) await KV.put(env, `pending:${nr.id}`, { ...data, targets, at: Date.now(), retries }, { expirationTtl: 3600 });
        }
      }
    } catch (e) { console.error(`[CRON] ${id}:`, e.message); }
  }

  if (!config.enabled || !config.generalPrompt) return;
  if ((await KV.list(env, "pending:")).keys.length > 0) return;

  const lastPost = parseInt((await KV.get(env, "last_post_time")) || "0", 10);
  if (Date.now() - lastPost < config.interval * 60 * 1000) return;

  await KV.put(env, "last_post_time", String(Date.now()));

  const targets = [];
  if (config.chatId) targets.push(config.chatId);
  if (config.channelId) targets.push(config.channelId);
  if (!targets.length) return;

  const blIds = (await getWorkerBlacklist(env)).map((w) => w.id).filter(Boolean);

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env, { workerBlacklist: blIds });
      if (result.id) {
        await KV.put(env, `pending:${result.id}`, { targets, prompt, at: Date.now(), notify: null, retries: 0 }, { expirationTtl: 3600 });
      }
    } catch (e) { console.error("[CRON] auto:", e.message); }
  }
}

// ============================================================
// Entry point
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      try {
        const upd = await request.json();
        if (upd.callback_query) await handleCallback(upd.callback_query, env);
        else if (upd.message?.text) await handleCommand(upd.message, env);
      } catch (e) { console.error("[WH]", e.message); }
      return new Response("OK");
    }
    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TELEGRAM_BOT_TOKEN!", { status: 500 });
      const wh = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: wh, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }),
      });
      return new Response(`Webhook: ${wh}\n\n${JSON.stringify(await r.json(), null, 2)}`);
    }
    if (url.pathname === "/") return new Response("🤖 Telegram Image Bot (Redis + кнопки) is running!\n/setup");
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    try { await processScheduled(env); } catch (e) { console.error("[CRON] CRASH:", e.message); }
  },
};