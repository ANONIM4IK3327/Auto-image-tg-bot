// ============================================================
// Telegram Image Bot — Cloudflare Workers (v2.0 Improved)
// AI Horde + OpenRouter + Upstash Redis
// ============================================================

const DEFAULT_CONFIG = {
  enabled: false,
  chatId: null,
  channelId: null,
  adminId: null,
  interval: 60,
  count: 1,
  generalPrompt: "",
  llmInstruction: "",
  captionMode: "prompt", // "none" | "prompt" | "ai"
  model: "AlbedoBase XL (SDXL)",
  loras: [],
  width: 1024,
  height: 1024,
  steps: 25,
  cfgScale: 7,
  sampler: "k_dpmpp_2m",
  nsfw: true,
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "google/gemma-2-9b-it:free",
  clipSkip: 2,
  hiresFix: false,
  hiresFixDenoising: 0.65,
  karras: true,
  tiling: false,
  faceFixer: "CodeFormers",
  faceFixerStrength: 0.75,
  postProcessors: [],
  allowDowngrade: true,
  trustedWorkers: false,
  slowWorkers: true,
  extraSlowWorkers: false,
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:14.0:tg" };
const MAX_RETRIES = 3;
const MIN_IMAGE_KB = 10;

// ============================================================
// Upstash Redis Client
// ============================================================
class Redis {
  constructor(url, token) {
    this.url = url;
    this.token = token;
  }

  async request(command, ...args) {
    const body = JSON.stringify([command, ...args]);
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    const data = await res.json();
    return data.result;
  }

  async get(key) {
    const result = await this.request("GET", key);
    if (result === null) return null;
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }

  async set(key, value, opts = {}) {
    const str = typeof value === "object" ? JSON.stringify(value) : String(value);
    const args = [key, str];
    if (opts.ex) args.push("EX", opts.ex);
    await this.request("SET", ...args);
  }

  async del(key) {
    await this.request("DEL", key);
  }

  async keys(pattern) {
    return (await this.request("KEYS", pattern)) || [];
  }

  async ttl(key) {
    return await this.request("TTL", key);
  }
}

function getRedis(env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Upstash Redis не настроен!");
  }
  return new Redis(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
}

// ============================================================
// HTML Escape & Utilities
// ============================================================
function escapeHtml(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isHttpUrl(v) {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

function truncate(str, len = 200) {
  if (!str) return "";
  return str.length > len ? str.substring(0, len) + "..." : str;
}

// ============================================================
// Telegram Client with Edit Support
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
    return r.json();
  }

  async send(chatId, text, extra = {}) {
    return this.api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async edit(chatId, messageId, text, extra = {}) {
    return this.api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async sendPhoto(chatId, arrayBuffer, caption = "", extra = {}) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new File([arrayBuffer], "image.webp", { type: "image/webp" }));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    Object.entries(extra).forEach(([k, v]) => form.append(k, v));
    const r = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
    return r.json();
  }

  async sendDocument(chatId, arrayBuffer, caption = "", extra = {}) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new File([arrayBuffer], "image.webp", { type: "image/webp" }));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    Object.entries(extra).forEach(([k, v]) => form.append(k, v));
    const r = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form });
    return r.json();
  }

  async sendPhotoUrl(chatId, url, caption = "", extra = {}) {
    return this.api("sendPhoto", {
      chat_id: chatId,
      photo: url,
      caption: caption?.substring(0, 1024) || "",
      parse_mode: "HTML",
      ...extra,
    });
  }

  async answerCallback(callbackQueryId, text, showAlert = false) {
    return this.api("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }
}

// ============================================================
// Inline Keyboards Builder
// ============================================================
const KB = {
  inline(rows) {
    return { inline_keyboard: rows };
  },

  row(...buttons) {
    return buttons;
  },

  btn(text, callbackData) {
    return { text, callback_data: callbackData };
  },

  url(text, url) {
    return { text, url };
  },
};

// ============================================================
// Config Management (Redis)
// ============================================================
async function getConfig(env) {
  const redis = getRedis(env);
  const stored = await redis.get("bot:config");
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function saveConfig(env, config) {
  const redis = getRedis(env);
  await redis.set("bot:config", config, { ex: 86400 * 30 });
}

async function getWorkerBlacklist(env) {
  const redis = getRedis(env);
  return (await redis.get("bot:blacklist")) || [];
}

async function addWorkerToBlacklist(env, workerId, workerName) {
  if (!workerId || workerId === "?" || String(workerId).length < 10) return;
  const redis = getRedis(env);
  const list = (await redis.get("bot:blacklist")) || [];
  if (!list.find((w) => w.id === workerId)) {
    list.push({ id: workerId, name: workerName || "?", t: Date.now() });
    while (list.length > 30) list.shift();
    await redis.set("bot:blacklist", list, { ex: 86400 * 7 });
    console.log(`[BL] Added worker: ${workerName} (${workerId})`);
  }
}

async function clearWorkerBlacklist(env) {
  const redis = getRedis(env);
  await redis.set("bot:blacklist", []);
}

// ============================================================
// Horde Censorship Detection
// ============================================================
function isCensored(gen) {
  if (!gen) return false;
  if (gen.gen_metadata?.some((m) => m.type === "censorship")) return true;
  if (gen.censored === true) return true;
  if (gen.state === "censored") return true;
  return false;
}

// ============================================================
// Horde API
// ============================================================
function getApiKey(env) {
  return (env.HORDE_API_KEY || "").trim() || "0000000000";
}

async function hordeCheckKey(env) {
  const key = getApiKey(env);
  try {
    const r = await fetch(`${HORDE_API}/find_user`, {
      headers: { apikey: key, ...HORDE_HEADERS },
    });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, anon: key === "0000000000" };
    }
    const d = await r.json();
    return {
      ok: true,
      anon: key === "0000000000",
      user: d.username,
      kudos: d.kudos,
      trusted: d.trusted,
      flagged: d.flagged,
    };
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
    tiling: config.tiling || false,
    post_processing: config.postProcessors || [],
    n: 1,
  };

  if (config.hiresFix) {
    params.hires_fix = true;
    params.hires_fix_denoising_strength = config.hiresFixDenoising || 0.65;
  }

  if (config.faceFixer && config.postProcessors?.includes("CodeFormers")) {
    params.facefixer_strength = config.faceFixerStrength || 0.75;
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
    nsfw: config.nsfw ?? true,
    censor_nsfw: false,
    trusted_workers: config.trustedWorkers ?? false,
    replacement_filter: true,
    models: [config.model],
    r2: true,
    shared: false,
    allow_downgrade: config.allowDowngrade ?? true,
    slow_workers: config.slowWorkers ?? true,
    extra_slow_workers: config.extraSlowWorkers ?? false,
  };

  if (opts.workerBlacklist?.length > 0) {
    body.workers = opts.workerBlacklist.slice(0, 5);
    body.worker_blacklist = true;
  }

  const resp = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      ...HORDE_HEADERS,
    },
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

async function hordeGetModels(type = "image") {
  const r = await fetch(`${HORDE_API}/status/models?type=${type}`, { headers: HORDE_HEADERS });
  return r.json();
}

// ============================================================
// Image Delivery
// ============================================================
async function downloadImage(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch (e) {
    console.error("[IMG] Fetch error:", e.message);
    return null;
  }
}

function base64ToBuffer(b64) {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch (e) {
    console.error("[IMG] Base64 decode error:", e.message);
    return null;
  }
}

function bufferSizeKB(buf) {
  return Math.round(buf.byteLength / 1024);
}

async function deliverImage(tg, chatId, imgData, caption, notifyChat) {
  if (!imgData) {
    if (notifyChat) await tg.send(notifyChat, "❌ Нет данных картинки от воркера");
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
    if (notifyChat) {
      await tg.send(
        notifyChat,
        `🚫 <b>Похоже на заглушку/цензуру</b>\nРазмер: ${sizeKB}KB (норма > ${MIN_IMAGE_KB}KB)`
      );
    }
    return { sent: false, tooSmall: true, sizeKB };
  }

  let res = await tg.sendPhoto(chatId, buf, caption);
  if (res.ok) return { sent: true, tooSmall: false, sizeKB };

  console.log("[IMG] sendPhoto failed, trying sendDocument:", res.description);
  res = await tg.sendDocument(chatId, buf, caption);
  if (res.ok) return { sent: true, tooSmall: false, sizeKB };

  if (isUrl) {
    const urlRes = await tg.sendPhotoUrl(chatId, imgData, caption);
    if (urlRes.ok) return { sent: true, tooSmall: false, sizeKB };
  }

  if (notifyChat) {
    await tg.send(notifyChat, `❌ Не удалось отправить изображение: ${escapeHtml(res.description || "unknown error")}`);
  }
  return { sent: false, tooSmall: false, sizeKB };
}

// ============================================================
// Prompt Generation with LLM Instructions
// ============================================================
const P = {
  angle: ["from above", "low angle", "eye level", "dutch angle", "bird's eye view", "extreme close-up", "wide establishing shot", "portrait framing"],
  light: ["golden hour sunlight", "blue hour twilight", "dramatic chiaroscuro", "soft overcast light", "neon cyberpunk glow", "moonlit night", "studio rim lighting"],
  style: ["photorealistic photography", "digital concept art", "oil painting", "watercolor washes", "anime cel shading", "dark fantasy illustration", "hyperrealistic 8k render"],
  mood: ["serene and peaceful", "intense and dramatic", "mysterious and enigmatic", "vibrant and energetic", "ethereal and dreamlike", "dark and brooding"],
  detail: ["intricate filigree details", "rough textured surfaces", "smooth polished finish", "ornate decoration", "minimalist clean lines", "weathered aged patina"],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}

function templatePrompt(base) {
  return [base, pick(P.angle), pick(P.light), pick(P.style), pick(P.mood), ...pickN(P.detail, 2), "masterpiece", "best quality", "highly detailed"].join(", ");
}

// Parse [instructions] from prompt for LLM
function parsePromptInstructions(prompt) {
  const matches = prompt.match(/\[(.*?)\]/g);
  const instructions = matches ? matches.map((m) => m.slice(1, -1)) : [];
  const cleanPrompt = prompt.replace(/\[.*?\]/g, "").trim();
  return { instructions, cleanPrompt };
}

async function llmPrompt(instruction, apiKey, model, llmInstructions = "") {
  const directions = [
    "Focus on unusual creative perspective",
    "Emphasize dramatic lighting and deep shadows",
    "Place subject in unexpected environment",
    "Focus on intricate textures and micro-details",
    "Use bold unconventional color palette",
    "Create cinematic movie composition",
    "Add weather effects — rain, snow, fog",
    "Give it futuristic sci-fi aesthetic",
  ];

  const systemPrompt = `You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations, no quotes, no markdown. Under 100 words. Be creative and unique. Direction: ${pick(directions)}${llmInstructions ? "\nAdditional instructions: " + llmInstructions : ""}`;

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
        model: model || "google/gemma-2-9b-it:free",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Create a unique detailed image generation prompt for: ${instruction}` },
        ],
        temperature: 1.3,
        max_tokens: 200,
      }),
    });
    const data = await resp.json();
    const p = data.choices?.[0]?.message?.content?.trim().replace(/^["'`*]+|["'`*]+$/g, "");
    if (p?.length > 10) return p;
  } catch (e) {
    console.error("[LLM]", e.message);
  }
  return templatePrompt(instruction);
}

async function generatePrompt(instruction, env, llmInstructions = "") {
  if (env.OPENROUTER_API_KEY) {
    const config = await getConfig(env);
    return llmPrompt(
      instruction,
      env.OPENROUTER_API_KEY,
      config.llmModel || env.LLM_MODEL || "google/gemma-2-9b-it:free",
      llmInstructions
    );
  }
  return templatePrompt(instruction);
}

// Generate AI caption for posted image
async function generateCaption(prompt, env) {
  if (!env.OPENROUTER_API_KEY) return "";

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://t.me",
        "X-Title": "TgImageBot",
      },
      body: JSON.stringify({
        model: "google/gemma-2-9b-it:free",
        messages: [
          {
            role: "system",
            content: "You are a creative social media caption writer. Write a short, engaging caption (1-2 sentences) for an AI-generated image. Use emojis. Keep it under 150 characters. Don't mention it's AI-generated.",
          },
          { role: "user", content: `Write a caption for an image with this theme: ${prompt}` },
        ],
        temperature: 0.9,
        max_tokens: 80,
      }),
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.error("[CAPTION]", e.message);
    return "";
  }
}

// ============================================================
// Inline Keyboard Menus
// ============================================================
function buildMainMenu() {
  return KB.inline([
    KB.row(KB.btn("🎨 Генерация", "menu:generate"), KB.btn("⚙️ Настройки", "menu:settings")),
    KB.row(KB.btn("📊 Статус", "menu:status"), KB.btn("📚 Модели", "menu:models")),
    KB.row(KB.btn("🔧 LoRA", "menu:lora"), KB.btn("🤖 LLM", "menu:llm")),
    KB.row(KB.btn("📬 Автопост", "menu:autopost"), KB.btn("🔑 Ключ", "menu:key")),
    KB.row(KB.btn("🗑 Очистить очередь", "action:clearqueue")),
  ]);
}

function buildSettingsMenu(config) {
  return KB.inline([
    KB.row(
      KB.btn(`📝 Промпт: ${config.generalPrompt ? "✓" : "✗"}`, "settings:prompt"),
      KB.btn(`📐 Размер: ${config.width}×${config.height}`, "settings:size")
    ),
    KB.row(
      KB.btn(`🔢 Шаги: ${config.steps}`, "settings:steps"),
      KB.btn(`🎚 CFG: ${config.cfgScale}`, "settings:cfg")
    ),
    KB.row(
      KB.btn(`🎲 Sampler: ${config.sampler.substring(0, 12)}`, "settings:sampler"),
      KB.btn(`📎 CLIP: ${config.clipSkip}`, "settings:clipskip")
    ),
    KB.row(
      KB.btn(`👤 Face Fix: ${config.faceFixer ? "✓" : "✗"}`, "settings:facefixer"),
      KB.btn(`🖼 HiRes: ${config.hiresFix ? "✓" : "✗"}`, "settings:hires")
    ),
    KB.row(
      KB.btn(`🎨 Пост-проц: ${config.postProcessors.length}`, "settings:postproc"),
      KB.btn(`🔞 NSFW: ${config.nsfw ? "✓" : "✗"}`, "settings:nsfw")
    ),
    KB.row(KB.btn("◀️ Назад", "menu:main")),
  ]);
}

function buildAutopostMenu(config) {
  const captionLabels = { none: "❌ Нет", prompt: "📝 Промпт", ai: "🤖 AI" };
  return KB.inline([
    KB.row(
      KB.btn(`💬 Чат: ${config.chatId ? "✓" : "✗"}`, "autopost:chat"),
      KB.btn(`📢 Канал: ${config.channelId ? "✓" : "✗"}`, "autopost:channel")
    ),
    KB.row(
      KB.btn(`⏱ Интервал: ${config.interval}м`, "autopost:interval"),
      KB.btn(`🔢 Кол-во: ${config.count}`, "autopost:count")
    ),
    KB.row(
      KB.btn(`📝 Подпись: ${captionLabels[config.captionMode]}`, "autopost:caption")
    ),
    KB.row(
      KB.btn(`🟢 Вкл: ${config.enabled ? "ДА" : "НЕТ"}`, "autopost:toggle")
    ),
    KB.row(KB.btn("◀️ Назад", "menu:main")),
  ]);
}

function buildModelsMenu(page = 0) {
  return KB.inline([
    KB.row(KB.btn("🔍 Поиск модели", "models:search")),
    KB.row(KB.btn("◀️ Назад", "menu:main")),
  ]);
}

function buildLoraMenu(config) {
  const loraCount = config.loras?.length || 0;
  return KB.inline([
    KB.row(KB.btn("🔍 Поиск LoRA", "lora:search")),
    KB.row(KB.btn(`📋 Список (${loraCount})`, "lora:list")),
    KB.row(KB.btn("◀️ Назад", "menu:main")),
  ]);
}

function buildLlmMenu(config) {
  return KB.inline([
    KB.row(KB.btn(`🤖 Модель: ${config.llmModel?.substring(0, 15)}`, "llm:model")),
    KB.row(KB.btn(`📝 Инструкция`, "llm:instruction")),
    KB.row(KB.btn("◀️ Назад", "menu:main")),
  ]);
}

function buildCaptionModeMenu() {
  return KB.inline([
    KB.row(KB.btn("❌ Без подписи", "caption:none")),
    KB.row(KB.btn("📝 Показать промпт", "caption:prompt")),
    KB.row(KB.btn("🤖 AI генерация", "caption:ai")),
    KB.row(KB.btn("◀️ Назад", "menu:autopost")),
  ]);
}

function buildPostProcessorsMenu(config) {
  const processors = [
    { id: "GFPGAN", name: "GFPGAN (face)" },
    { id: "RealESRGAN_x4plus", name: "RealESRGAN 4x" },
    { id: "RealESRGAN_x2plus", name: "RealESRGAN 2x" },
    { id: "CodeFormers", name: "CodeFormers" },
    { id: "4x_AnimeSharp", name: "AnimeSharp 4x" },
    { id: "strip_background", name: "Remove BG" },
  ];

  const rows = [];
  for (let i = 0; i < processors.length; i += 2) {
    const p1 = processors[i];
    const p2 = processors[i + 1];
    const row = [
      KB.btn(`${config.postProcessors?.includes(p1.id) ? "✓" : "○"} ${p1.name}`, `postproc:toggle:${p1.id}`),
    ];
    if (p2) {
      row.push(KB.btn(`${config.postProcessors?.includes(p2.id) ? "✓" : "○"} ${p2.name}`, `postproc:toggle:${p2.id}`));
    }
    rows.push(row);
  }
  rows.push(KB.row(KB.btn("◀️ Назад", "menu:settings")));
  return KB.inline(rows);
}

// ============================================================
// Command Handler (Text Commands)
// ============================================================
async function handleCommand(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text || "";

  if (!env.TELEGRAM_BOT_TOKEN) return;
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);

  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    await tg.send(chatId, "🤖 <b>Telegram Image Bot v2.0</b>\n\nИспользуйте кнопки ниже для настройки.", buildMainMenu());
    return;
  }

  if (cmd === "/ping") {
    const k = getApiKey(env);
    const redisOk = env.UPSTASH_REDIS_REST_URL ? "✅" : "❌";
    await tg.send(
      chatId,
      `🏓 <b>Pong!</b>\n\n` +
        `💾 Redis: ${redisOk}\n` +
        `🎨 Horde: ${k === "0000000000" ? "🔴 anon" : "✅ " + k.substring(0, 8) + "..."}` +
        `\n🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}`
    );
    return;
  }

  if (cmd === "/checkkey") {
    await tg.send(chatId, "🔑 Checking Horde key...");
    const info = await hordeCheckKey(env);
    if (!info.ok) {
      await tg.send(chatId, `❌ <b>Invalid key</b>\n${escapeHtml(info.err || "")}`);
      return;
    }
    const status = info.anon
      ? "🔴 <b>Anonymous key</b>\nNSFW will not work."
      : info.flagged
      ? "⚠️ Account flagged"
      : "✅ Key looks fine";

    await tg.send(
      chatId,
      `${info.anon ? "🔴 " : "✅ "}<b>${escapeHtml(info.user || "anonymous")}</b>\n\n` +
        `💎 Kudos: ${info.kudos || 0}\n` +
        `🛡 Trusted: ${info.trusted ? "yes" : "no"}\n` +
        `🚩 Flagged: ${info.flagged ? "yes" : "no"}\n\n${status}`
    );
    return;
  }

  // Admin setup
  let config = await getConfig(env);
  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(env, config);
    await tg.send(chatId, `👑 You are admin. ID: <code>${userId}</code>`);
  }

  if (config.adminId !== userId && cmd !== "/ping" && cmd !== "/checkkey") {
    await tg.send(chatId, `🔒 Admin only (ID: ${config.adminId})`);
    return;
  }

  // Additional text commands for convenience
  if (cmd === "/generate") {
    if (!config.generalPrompt) {
      await tg.send(chatId, "❌ First set prompt via /setprompt or buttons");
      return;
    }
    await tg.send(chatId, "⏳ Generating...", buildMainMenu());
    // Trigger generation via callback simulation
    await handleCallback({ data: "action:generate", from: { id: userId }, message: { chat: { id: chatId }, message_id: null } }, env);
    return;
  }

  if (cmd === "/status") {
    const pendingCount = (await getRedis(env).keys("pending:*")).length;
    const bl = await getWorkerBlacklist(env);
    await tg.send(
      chatId,
      `📊 <b>Status</b>\n\n` +
        `<b>Autopost:</b> ${config.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
        `<b>Chat:</b> <code>${config.chatId || "—"}</code>\n` +
        `<b>Channel:</b> <code>${config.channelId || "—"}</code>\n` +
        `<b>Interval:</b> ${config.interval} min\n` +
        `<b>Count:</b> ${config.count}\n` +
        `<b>Queue:</b> ${pendingCount}\n` +
        `<b>Blacklist:</b> ${bl.length} workers`,
      buildMainMenu()
    );
    return;
  }

  if (cmd === "/setprompt") {
    const p = parts.slice(1).join(" ");
    if (!p) {
      await tg.send(chatId, "❌ /setprompt <theme>");
      return;
    }
    config.generalPrompt = p;
    await saveConfig(env, config);
    await tg.send(chatId, `✅ Prompt set:\n<code>${escapeHtml(p)}</code>`, buildMainMenu());
    return;
  }

  await tg.send(chatId, "❓ Use /start for menu or /help for commands", buildMainMenu());
}

// ============================================================
// Callback Query Handler (Inline Buttons)
// ============================================================
async function handleCallback(callbackQuery, env) {
  const { data, from, message } = callbackQuery;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const userId = from?.id;

  if (!env.TELEGRAM_BOT_TOKEN) return;
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);

  let config = await getConfig(env);

  // Admin check
  if (config.adminId && userId !== config.adminId && !data.startsWith("menu:")) {
    await tg.answerCallback(callbackQuery.id, "🔒 Admin only", true);
    return;
  }

  const [section, action, param] = data.split(":");

  try {
    switch (section) {
      case "menu":
        await handleMenu(tg, chatId, messageId, action, config);
        break;

      case "settings":
        await handleSettings(tg, chatId, messageId, action, param, config, env);
        config = await getConfig(env);
        break;

      case "autopost":
        await handleAutopost(tg, chatId, messageId, action, param, config, env);
        config = await getConfig(env);
        break;

      case "models":
        await handleModels(tg, chatId, messageId, action, env);
        break;

      case "lora":
        await handleLora(tg, chatId, messageId, action, param, config, env);
        config = await getConfig(env);
        break;

      case "llm":
        await handleLlm(tg, chatId, messageId, action, param, config, env);
        config = await getConfig(env);
        break;

      case "caption":
        await handleCaptionMode(tg, chatId, messageId, action, config, env);
        config = await getConfig(env);
        break;

      case "postproc":
        await handlePostProcessors(tg, chatId, messageId, action, param, config, env);
        config = await getConfig(env);
        break;

      case "action":
        await handleActions(tg, chatId, messageId, action, config, env);
        break;

      default:
        await tg.answerCallback(callbackQuery.id, "❓ Unknown action");
    }

    await tg.answerCallback(callbackQuery.id, "");
  } catch (e) {
    console.error("[CALLBACK]", e.message);
    await tg.answerCallback(callbackQuery.id, `❌ Error: ${e.message}`, true);
  }
}

async function handleMenu(tg, chatId, messageId, action, config) {
  let text, keyboard;

  switch (action) {
    case "main":
      text = "🤖 <b>Telegram Image Bot v2.0</b>\n\nВыберите раздел:";
      keyboard = buildMainMenu();
      break;

    case "settings":
      text = `⚙️ <b>Настройки генерации</b>\n\n` +
        `📐 Размер: ${config.width}×${config.height}\n` +
        `🔢 Шаги: ${config.steps} | CFG: ${config.cfgScale}\n` +
        `🎲 Sampler: ${config.sampler}\n` +
        `👤 Face Fix: ${config.faceFixer || "off"}\n` +
        `🖼 HiRes: ${config.hiresFix ? "on" : "off"}\n` +
        `🎨 Post-proc: ${config.postProcessors.length} active`;
      keyboard = buildSettingsMenu(config);
      break;

    case "autopost":
      const captionLabels = { none: "❌ Нет", prompt: "📝 Промпт", ai: "🤖 AI" };
      text = `📬 <b>Автопостинг</b>\n\n` +
        `💬 Чат: <code>${config.chatId || "не задан"}</code>\n` +
        `📢 Канал: <code>${config.channelId || "не задан"}</code>\n` +
        `⏱ Интервал: ${config.interval} мин\n` +
        `🔢 Кол-во: ${config.count}\n` +
        `📝 Подпись: ${captionLabels[config.captionMode]}\n` +
        `🟢 Статус: ${config.enabled ? "ВКЛ" : "ВЫКЛ"}`;
      keyboard = buildAutopostMenu(config);
      break;

    case "models":
      text = "📚 <b>Модели</b>\n\nИспользуйте поиск для нахождения моделей.";
      keyboard = buildModelsMenu();
      break;

    case "lora":
      text = `🔧 <b>LoRA</b>\n\nДобавлено: ${config.loras?.length || 0}`;
      keyboard = buildLoraMenu(config);
      break;

    case "llm":
      text = `🤖 <b>LLM Настройки</b>\n\n` +
        `Модель: <code>${config.llmModel}</code>\n` +
        `Инструкция: ${config.llmInstruction ? "✓" : "✗"}`;
      keyboard = buildLlmMenu(config);
      break;

    case "key":
      const keyInfo = await hordeCheckKey(env);
      text = `🔑 <b>Horde Ключ</b>\n\n` +
        `Статус: ${keyInfo.ok ? "✅ OK" : "❌ Error"}\n` +
        `Пользователь: ${escapeHtml(keyInfo.user || "anon")}\n` +
        `Kudos: ${keyInfo.kudos || 0}\n` +
        `Trusted: ${keyInfo.trusted ? "yes" : "no"}`;
      keyboard = KB.inline([KB.row(KB.btn("◀️ Назад", "menu:main"))]);
      break;

    case "status":
      const redis = getRedis(env);
      const pendingCount = (await redis.keys("pending:*")).length;
      const bl = await getWorkerBlacklist(env);
      text = `📊 <b>Статус</b>\n\n` +
        `Автопост: ${config.enabled ? "🟢 ВКЛ" : "🔴 ВЫКЛ"}\n` +
        `Очередь: ${pendingCount}\n` +
        `Блэклист: ${bl.length} воркеров`;
      keyboard = KB.inline([KB.row(KB.btn("◀️ Назад", "menu:main"))]);
      break;

    case "generate":
      text = "🎨 <b>Генерация</b>\n\nНажмите для запуска.";
      keyboard = KB.inline([
        KB.row(KB.btn("🚀 Запустить", "action:generate")),
        KB.row(KB.btn("◀️ Назад", "menu:main")),
      ]);
      break;

    default:
      text = "❓ Unknown menu";
      keyboard = buildMainMenu();
  }

  if (messageId) {
    await tg.edit(chatId, messageId, text, { reply_markup: keyboard });
  } else {
    await tg.send(chatId, text, { reply_markup: keyboard });
  }
}

async function handleSettings(tg, chatId, messageId, action, param, config, env) {
  switch (action) {
    case "prompt":
      await tg.answerCallback(callbackQuery.id, "📝 Отправьте новый промпт текстом");
      // Store state for next message
      const redis = getRedis(env);
      await redis.set(`state:${chatId}`, { type: "set_prompt", messageId }, { ex: 300 });
      return;

    case "size":
      await tg.answerCallback(callbackQuery.id, "📐 Отправьте: ширина высота (например: 1024 1024)");
      await redis.set(`state:${chatId}`, { type: "set_size", messageId }, { ex: 300 });
      return;

    case "steps":
      await tg.answerCallback(callbackQuery.id, "🔢 Отправьте число шагов (1-150)");
      await redis.set(`state:${chatId}`, { type: "set_steps", messageId }, { ex: 300 });
      return;

    case "cfg":
      await tg.answerCallback(callbackQuery.id, "🎚 Отправьте CFG scale (1-30)");
      await redis.set(`state:${chatId}`, { type: "set_cfg", messageId }, { ex: 300 });
      return;

    case "sampler":
      const samplers = ["k_euler", "k_euler_a", "k_lms", "k_heun", "k_dpm_2", "k_dpm_2_a", "k_dpmpp_2s_a", "k_dpmpp_2m", "k_dpmpp_sde", "DDIM"];
      const rows = [];
      for (let i = 0; i < samplers.length; i += 2) {
        rows.push(KB.row(
          KB.btn(`${config.sampler === samplers[i] ? "✓" : "○"} ${samplers[i]}`, `settings:sampler_set:${samplers[i]}`),
          samplers[i + 1] ? KB.btn(`${config.sampler === samplers[i + 1] ? "✓" : "○"} ${samplers[i + 1]}`, `settings:sampler_set:${samplers[i + 1]}`) : null
        ).filter(Boolean));
      }
      rows.push(KB.row(KB.btn("◀️ Назад", "menu:settings")));
      await tg.edit(chatId, messageId, "🎲 <b>Выберите sampler</b>", { reply_markup: KB.inline(rows) });
      return;

    case "sampler_set":
      config.sampler = param;
      await saveConfig(env, config);
      await handleSettings(tg, chatId, messageId, "sampler", null, config, env);
      return;

    case "clipskip":
      await tg.answerCallback(callbackQuery.id, "📎 Отправьте CLIP skip (1-4)");
      await redis.set(`state:${chatId}`, { type: "set_clipskip", messageId }, { ex: 300 });
      return;

    case "facefixer":
      const ffEnabled = !!config.faceFixer;
      config.faceFixer = ffEnabled ? null : "CodeFormers";
      if (!ffEnabled) {
        if (!config.postProcessors.includes("CodeFormers")) {
          config.postProcessors.push("CodeFormers");
        }
      } else {
        config.postProcessors = config.postProcessors.filter((p) => p !== "CodeFormers");
      }
      await saveConfig(env, config);
      await handleMenu(tg, chatId, messageId, "settings", config);
      return;

    case "hires":
      config.hiresFix = !config.hiresFix;
      await saveConfig(env, config);
      await handleMenu(tg, chatId, messageId, "settings", config);
      return;

    case "nsfw":
      config.nsfw = !config.nsfw;
      await saveConfig(env, config);
      await handleMenu(tg, chatId, messageId, "settings", config);
      return;

    case "postproc":
      await tg.edit(chatId, messageId, "🎨 <b>Пост-процессоры</b>\n\nВыберите активные:", { reply_markup: buildPostProcessorsMenu(config) });
      return;
  }

  await handleMenu(tg, chatId, messageId, "settings", config);
}

async function handleAutopost(tg, chatId, messageId, action, param, config, env) {
  const redis = getRedis(env);

  switch (action) {
    case "chat":
      await tg.answerCallback(callbackQuery.id, "💬 Отправьте ID чата или /setchat");
      await redis.set(`state:${chatId}`, { type: "set_chat", messageId }, { ex: 300 });
      return;

    case "channel":
      await tg.answerCallback(callbackQuery.id, "📢 Отправьте ID канала (например: @channelname или -100...)");
      await redis.set(`state:${chatId}`, { type: "set_channel", messageId }, { ex: 300 });
      return;

    case "interval":
      await tg.answerCallback(callbackQuery.id, "⏱ Отправьте интервал в минутах (1-1440)");
      await redis.set(`state:${chatId}`, { type: "set_interval", messageId }, { ex: 300 });
      return;

    case "count":
      await tg.answerCallback(callbackQuery.id, "🔢 Отправьте количество (1-10)");
      await redis.set(`state:${chatId}`, { type: "set_count", messageId }, { ex: 300 });
      return;

    case "caption":
      await tg.edit(chatId, messageId, "📝 <b>Режим подписи</b>\n\nВыберите вариант:", { reply_markup: buildCaptionModeMenu() });
      return;

    case "toggle":
      if (!config.chatId && !config.channelId) {
        await tg.answerCallback(callbackQuery.id, "❌ Сначала настройте чат или канал!", true);
        return;
      }
      if (!config.generalPrompt) {
        await tg.answerCallback(callbackQuery.id, "❌ Сначала установите промпт!", true);
        return;
      }
      config.enabled = !config.enabled;
      await saveConfig(env, config);
      await handleMenu(tg, chatId, messageId, "autopost", config);
      return;
  }

  await handleMenu(tg, chatId, messageId, "autopost", config);
}

async function handleCaptionMode(tg, chatId, messageId, action, config, env) {
  config.captionMode = action;
  await saveConfig(env, config);
  await handleMenu(tg, chatId, messageId, "autopost", config);
}

async function handlePostProcessors(tg, chatId, messageId, action, param, config, env) {
  if (action === "toggle") {
    const idx = config.postProcessors.indexOf(param);
    if (idx >= 0) {
      config.postProcessors.splice(idx, 1);
    } else {
      config.postProcessors.push(param);
    }
    await saveConfig(env, config);
    await tg.edit(chatId, messageId, "🎨 <b>Пост-процессоры</b>\n\nВыберите активные:", { reply_markup: buildPostProcessorsMenu(config) });
    return;
  }
  await handleMenu(tg, chatId, messageId, "settings", config);
}

async function handleModels(tg, chatId, messageId, action, env) {
  if (action === "search") {
    await tg.answerCallback(callbackQuery.id, "🔍 Отправьте название модели для поиска");
    const redis = getRedis(env);
    await redis.set(`state:${chatId}`, { type: "search_model", messageId }, { ex: 300 });
    return;
  }

  await handleMenu(tg, chatId, messageId, "models");
}

async function handleLora(tg, chatId, messageId, action, param, config, env) {
  const redis = getRedis(env);

  if (action === "search") {
    await tg.answerCallback(callbackQuery.id, "🔍 Отправьте запрос для поиска LoRA (на английском)");
    await redis.set(`state:${chatId}`, { type: "search_lora", messageId }, { ex: 300 });
    return;
  }

  if (action === "list") {
    const loras = config.loras || [];
    if (!loras.length) {
      await tg.edit(chatId, messageId, "📋 <b>LoRA</b>\n\nСписок пуст. Используйте поиск.", { reply_markup: buildLoraMenu(config) });
      return;
    }

    let text = "📋 <b>Ваши LoRA</b>\n\n";
    loras.forEach((l, i) => {
      text += `${i + 1}. <code>${escapeHtml(l.name)}</code> (str: ${l.strength}, clip: ${l.clip})\n`;
    });

    const keyboard = KB.inline([
      KB.row(KB.btn("🗑 Очистить все", "lora:clear")),
      KB.row(KB.btn("◀️ Назад", "menu:lora")),
    ]);
    await tg.edit(chatId, messageId, text, { reply_markup: keyboard });
    return;
  }

  if (action === "clear") {
    config.loras = [];
    await saveConfig(env, config);
    await tg.answerCallback(callbackQuery.id, "✅ LoRA очищены");
    await handleLora(tg, chatId, messageId, "list", null, config, env);
    return;
  }

  await handleMenu(tg, chatId, messageId, "lora", config);
}

async function handleLlm(tg, chatId, messageId, action, param, config, env) {
  const redis = getRedis(env);

  if (action === "model") {
    const models = [
      "google/gemma-2-9b-it:free",
      "meta-llama/llama-3.1-8b-instruct:free",
      "mistralai/mistral-7b-instruct:free",
      "qwen/qwen-2-7b-instruct:free",
    ];

    const rows = [];
    for (let i = 0; i < models.length; i += 2) {
      rows.push(KB.row(
        KB.btn(`${config.llmModel === models[i] ? "✓" : "○"} ${models[i].substring(0, 20)}`, `llm:model_set:${models[i]}`),
        models[i + 1] ? KB.btn(`${config.llmModel === models[i + 1] ? "✓" : "○"} ${models[i + 1].substring(0, 20)}`, `llm:model_set:${models[i + 1]}`) : null
      ).filter(Boolean));
    }
    rows.push(KB.row(KB.btn("◀️ Назад", "menu:llm")));
    await tg.edit(chatId, messageId, "🤖 <b>Выберите LLM модель</b>", { reply_markup: KB.inline(rows) });
    return;
  }

  if (action === "model_set") {
    config.llmModel = param;
    await saveConfig(env, config);
    await handleLlm(tg, chatId, messageId, "model", null, config, env);
    return;
  }

  if (action === "instruction") {
    await tg.answerCallback(callbackQuery.id, "📝 Отправьте инструкцию для LLM");
    await redis.set(`state:${chatId}`, { type: "set_llm_instruction", messageId }, { ex: 300 });
    return;
  }

  await handleMenu(tg, chatId, messageId, "llm", config);
}

async function handleActions(tg, chatId, messageId, action, config, env) {
  if (action === "generate") {
    if (!config.generalPrompt) {
      await tg.answerCallback(callbackQuery.id, "❌ Сначала установите промпт!", true);
      return;
    }

    const targetChats = [];
    if (config.chatId) targetChats.push(config.chatId);
    if (config.channelId) targetChats.push(config.channelId);

    if (!targetChats.length) {
      await tg.answerCallback(callbackQuery.id, "❌ Настройте чат или канал!", true);
      return;
    }

    await tg.answerCallback(callbackQuery.id, "🎨 Запуск генерации...");

    const bl = await getWorkerBlacklist(env);
    const blIds = bl.map((w) => w.id).filter(Boolean);

    for (let i = 0; i < config.count; i++) {
      try {
        const { instructions, cleanPrompt } = parsePromptInstructions(config.generalPrompt);
        const llmInstr = [...instructions, config.llmInstruction].filter(Boolean).join(". ");
        const prompt = await generatePrompt(cleanPrompt, env, llmInstr);

        const result = await hordeSubmit(prompt, config, env, { workerBlacklist: blIds });

        if (result.id) {
          const redis = getRedis(env);
          await redis.set(
            `pending:${result.id}`,
            {
              targetChats,
              prompt,
              originalPrompt: config.generalPrompt,
              at: Date.now(),
              notify: chatId,
              retries: 0,
              captionMode: config.captionMode,
            },
            { ex: 3600 }
          );

          if (messageId) {
            await tg.edit(chatId, messageId, `📤 <b>Запрос отправлен</b>\n\nID: <code>${result.id}</code>\nПромпт: ${truncate(prompt, 150)}`, { reply_markup: buildMainMenu() });
          }
        } else {
          await tg.send(chatId, `❌ Horde error: ${escapeHtml(JSON.stringify(result).substring(0, 200))}`);
        }
      } catch (e) {
        await tg.send(chatId, `❌ Error: ${escapeHtml(e.message)}`);
      }
    }
    return;
  }

  if (action === "clearqueue") {
    const redis = getRedis(env);
    const keys = await redis.keys("pending:*");
    for (const key of keys) {
      await redis.del(key);
    }
    await tg.answerCallback(callbackQuery.id, `✅ Очищено: ${keys.length}`);
    await handleMenu(tg, chatId, messageId, "status", config);
    return;
  }
}

// ============================================================
// State Handler (for multi-step inputs)
// ============================================================
async function handleStateMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const redis = getRedis(env);

  const state = await redis.get(`state:${chatId}`);
  if (!state) return false;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  let config = await getConfig(env);

  try {
    switch (state.type) {
      case "set_prompt":
        config.generalPrompt = text;
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ Промпт установлен:\n<code>${escapeHtml(text)}</code>`, { reply_markup: buildMainMenu() });
        break;

      case "set_size":
        const parts = text.split(/\s+/);
        let w = parseInt(parts[0], 10);
        let h = parseInt(parts[1], 10);
        if (isNaN(w) || isNaN(h) || w < 256 || h < 256 || w > 2048 || h > 2048) {
          await tg.send(chatId, "❌ Invalid size. Use: 1024 1024");
          return true;
        }
        config.width = Math.round(w / 64) * 64;
        config.height = Math.round(h / 64) * 64;
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ Размер: ${config.width}×${config.height}`, { reply_markup: buildMainMenu() });
        break;

      case "set_steps":
        const s = parseInt(text, 10);
        if (isNaN(s) || s < 1 || s > 150) {
          await tg.send(chatId, "❌ Steps must be 1-150");
          return true;
        }
        config.steps = s;
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ Steps: ${s}`, { reply_markup: buildMainMenu() });
        break;

      case "set_cfg":
        const c = parseFloat(text);
        if (isNaN(c) || c < 1 || c > 30) {
          await tg.send(chatId, "❌ CFG must be 1-30");
          return true;
        }
        config.cfgScale = c;
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ CFG: ${c}`, { reply_markup: buildMainMenu() });
        break;

      case "set_clipskip":
        const cs = parseInt(text, 10);
        if (isNaN(cs) || cs < 1 || cs > 4) {
          await tg.send(chatId, "❌ CLIP skip must be 1-4");
          return true;
        }
        config.clipSkip = cs;
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ CLIP Skip: ${cs}`, { reply_markup: buildMainMenu() });
        break;

      case "set_chat":
        config.chatId = text.startsWith("@") ? text : parseInt(text, 10);
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ Чат установлен: <code>${config.chatId}</code>`, { reply_markup: buildAutopostMenu(config) });
        break;

      case "set_channel":
        config.channelId = text.startsWith("@") ? text : parseInt(text, 10);
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ Канал установлен: <code>${config.channelId}</code>`, { reply_markup: buildAutopostMenu(config) });
        break;

      case "set_interval":
        const n = parseInt(text, 10);
        if (isNaN(n) || n < 1 || n > 1440) {
          await tg.send(chatId, "❌ Interval must be 1-1440 minutes");
          return true;
        }
        config.interval = n;
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ Интервал: ${n} мин`, { reply_markup: buildAutopostMenu(config) });
        break;

      case "set_count":
        const cnt = parseInt(text, 10);
        if (isNaN(cnt) || cnt < 1 || cnt > 10) {
          await tg.send(chatId, "❌ Count must be 1-10");
          return true;
        }
        config.count = cnt;
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ Кол-во: ${cnt}`, { reply_markup: buildAutopostMenu(config) });
        break;

      case "set_llm_instruction":
        config.llmInstruction = text;
        await saveConfig(env, config);
        await tg.edit(chatId, state.messageId, `✅ LLM инструкция:\n<code>${escapeHtml(text)}</code>`, { reply_markup: buildLlmMenu(config) });
        break;

      case "search_model":
        await tg.send(chatId, "🔍 Поиск моделей...");
        const models = await hordeGetModels();
        const filtered = (Array.isArray(models) ? models : [])
          .filter((m) => m.name?.toLowerCase().includes(text.toLowerCase()))
          .slice(0, 20);

        if (!filtered.length) {
          await tg.send(chatId, "😕 Ничего не найдено");
        } else {
          let txt = `🔍 <b>Модели: "${escapeHtml(text)}"</b>\n\n`;
          filtered.forEach((m) => {
            const tag = m.name?.includes("XL") || m.name?.includes("SDXL") ? "🟢" : "⚪";
            txt += `${tag} <code>${escapeHtml(m.name)}</code> (${m.count}w)\n`;
          });
          txt += "\n/setmodel <name> — выбрать";
          await tg.send(chatId, txt);
        }
        break;

      case "search_lora":
        await tg.send(chatId, "🔍 Поиск LoRA на CivitAI...");
        try {
          const url = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(text)}&limit=10&sort=Highest%20Rated&nsfw=true`;
          const data = await (await fetch(url)).json();
          if (!data.items?.length) {
            await tg.send(chatId, "😕 Ничего не найдено");
          } else {
            let txt = `🔍 <b>LoRA: "${escapeHtml(text)}"</b>\n\n`;
            for (const item of data.items.slice(0, 10)) {
              const ver = item.modelVersions?.[0];
              const vid = ver?.id || "?";
              txt += `${item.nsfw ? "🔞" : "✅"} <b>${escapeHtml(item.name)}</b> [${escapeHtml(ver?.baseModel || "?")}]\n`;
              txt += `   ➕ /addlora ${vid} 0.8\n\n`;
            }
            await tg.send(chatId, txt);
          }
        } catch (e) {
          await tg.send(chatId, `❌ ${escapeHtml(e.message)}`);
        }
        break;

      default:
        await tg.send(chatId, "❓ Unknown state");
    }

    await redis.del(`state:${chatId}`);
    return true;
  } catch (e) {
    console.error("[STATE]", e.message);
    await tg.send(chatId, `❌ Error: ${escapeHtml(e.message)}`);
    await redis.del(`state:${chatId}`);
    return true;
  }
}

// ============================================================
// Scheduler (Auto-posting)
// ============================================================
async function processScheduled(env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.TELEGRAM_BOT_TOKEN) return;

  const redis = getRedis(env);
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);

  // Process pending generations
  const pendingKeys = await redis.keys("pending:*");
  for (const key of pendingKeys) {
    const id = key.replace("pending:", "");
    try {
      const data = await redis.get(key);
      if (!data) {
        await redis.del(key);
        continue;
      }

      if (Date.now() - data.at > 20 * 60 * 1000) {
        await redis.del(key);
        if (data.notify) await tg.send(data.notify, `⏰ Generation timeout: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      if (!check.done) continue;

      const result = await hordeGetResult(id);
      await redis.del(key);

      if (result.faulted) {
        if (data.notify) await tg.send(data.notify, `❌ Generation <code>${id}</code> failed`);
        continue;
      }

      const gens = result.generations || [];
      if (!gens.length) {
        if (data.notify) await tg.send(data.notify, `❌ No generations for <code>${id}</code>`);
        continue;
      }

      for (const gen of gens) {
        const workerId = gen.worker_id || "?";
        const workerName = gen.worker_name || "?";
        const censored = isCensored(gen);

        if (censored) {
          await addWorkerToBlacklist(env, workerId, workerName);
          if (data.notify) {
            await tg.send(data.notify, `🔴 Worker <code>${escapeHtml(workerName)}</code> returned censorship\nRetrying...`);
          }
          continue;
        }

        if (!gen.img) continue;

        // Build caption based on mode
        let caption = "";
        if (data.captionMode === "prompt") {
          caption = `🎨 <i>${escapeHtml(truncate(data.prompt, 200))}</i>`;
        } else if (data.captionMode === "ai" && env.OPENROUTER_API_KEY) {
          const aiCaption = await generateCaption(data.originalPrompt || data.prompt, env);
          caption = aiCaption ? `✨ ${escapeHtml(aiCaption)}` : "";
        }

        // Send to all target chats
        const targetChats = data.targetChats || [data.chatId];
        for (const targetChat of targetChats) {
          if (!targetChat) continue;
          await deliverImage(tg, targetChat, gen.img, caption, data.notify);
        }

        if (data.notify && targetChats.length > 0) {
          await tg.send(data.notify, "✅ Image sent");
        }
      }
    } catch (e) {
      console.error(`[CRON] ${id}:`, e.message);
    }
  }

  // Auto-post new generations
  if (!config.enabled || (!config.chatId && !config.channelId) || !config.generalPrompt) return;
  if (pendingKeys.length > 0) return;

  const lastPost = parseInt((await redis.get("last_post_time")) || "0", 10);
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  await redis.set("last_post_time", String(now));

  const bl = await getWorkerBlacklist(env);
  const blIds = bl.map((w) => w.id).filter(Boolean);

  const targetChats = [];
  if (config.chatId) targetChats.push(config.chatId);
  if (config.channelId) targetChats.push(config.channelId);

  for (let i = 0; i < config.count; i++) {
    try {
      const { instructions, cleanPrompt } = parsePromptInstructions(config.generalPrompt);
      const llmInstr = [...instructions, config.llmInstruction].filter(Boolean).join(". ");
      const prompt = await generatePrompt(cleanPrompt, env, llmInstr);

      const result = await hordeSubmit(prompt, config, env, { workerBlacklist: blIds });
      if (result.id) {
        await redis.set(
          `pending:${result.id}`,
          {
            targetChats,
            prompt,
            originalPrompt: config.generalPrompt,
            at: now,
            notify: null,
            retries: 0,
            captionMode: config.captionMode,
          },
          { ex: 3600 }
        );
      }
    } catch (e) {
      console.error("[CRON] auto:", e.message);
    }
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

        // Handle callback query
        if (upd.callback_query) {
          await handleCallback(upd.callback_query, env);
          return new Response("OK");
        }

        // Handle message
        if (upd.message) {
          // Check for state first
          const handled = await handleStateMessage(upd.message, env);
          if (!handled && upd.message.text) {
            await handleCommand(upd.message, env);
          }
        }
      } catch (e) {
        console.error("[WH]", e.message);
      }
      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response("No TELEGRAM_BOT_TOKEN!", { status: 500 });
      }
      const wh = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: wh,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: true,
        }),
      });
      return new Response(`Webhook: ${wh}\n\n${JSON.stringify(await r.json(), null, 2)}`);
    }

    if (url.pathname === "/") {
      return new Response("🤖 Telegram Image Bot v2.0 is running!\nVisit /setup to configure webhook.");
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    try {
      await processScheduled(env);
    } catch (e) {
      console.error("[CRON] CRASH:", e.message);
    }
  },
};