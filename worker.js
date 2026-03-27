// ============================================================
// Telegram Image Bot — Cloudflare Workers + Upstash Redis
// AI Horde + OpenRouter
// ============================================================

const DEFAULT_CONFIG = {
  enabled: false,
  chatId: null,      // Группа
  channelId: null,   // Канал
  captionMode: 2,    // 1: Без текста, 2: Промпт, 3: LLM Описание
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
  hiresFixDenoising: 0.65,
  karras: true,
  postProcessors: [],
  facefixerStrength: 0.75
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:15.0:tg" };
const MAX_RETRIES = 3;
const MIN_IMAGE_KB = 10;

function escapeHtml(text) {
  if (text == null) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function isHttpUrl(v) { return typeof v === "string" && /^https?:\/\//i.test(v); }

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
    if (!res.ok && res.error_code !== 400) { // 400 часто бывает если "message is not modified"
      console.error(`[TG] ${method}:`, JSON.stringify(res).substring(0, 400));
    }
    return res;
  }

  send(chatId, text, extra = {}) {
    return this.api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
  }

  editMessage(chatId, messageId, text, extra = {}) {
    return this.api("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra });
  }

  answerCallback(cbId, text = "", showAlert = false) {
    return this.api("answerCallbackQuery", { callback_query_id: cbId, text, show_alert: showAlert });
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
    return this.api("sendPhoto", { chat_id: chatId, photo: url, caption: caption.substring(0, 1024), parse_mode: "HTML" });
  }
}

// ============================================================
// Upstash Redis Helpers
// ============================================================

const Redis = {
  async call(env, command, ...args) {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("Не заданы UPSTASH_REDIS_REST_URL и/или UPSTASH_REDIS_REST_TOKEN");
    }
    const url = env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '');
    const body = JSON.stringify([command, ...args]);
    try {
      const res = await fetch(`${url}/`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json"
        },
        body
      });
      const data = await res.json();
      return data.result !== undefined ? data.result : null;
    } catch (e) {
      console.error("[REDIS ERR]", e.message);
      return null;
    }
  },
  async get(env, key, type = "text") {
    const res = await this.call(env, "GET", key);
    if (res == null) return null;
    if (type === "json") {
      try { return JSON.parse(res); } catch { return null; }
    }
    return res;
  },
  async put(env, key, val, opts = {}) {
    if (opts.expirationTtl) {
      await this.call(env, "SET", key, val, "EX", opts.expirationTtl);
    } else {
      await this.call(env, "SET", key, val);
    }
  },
  async del(env, key) {
    await this.call(env, "DEL", key);
  },
  async keys(env, pattern) {
    const res = await this.call(env, "KEYS", pattern);
    if (!res || !Array.isArray(res)) return { keys: [] };
    return { keys: res.map(k => ({ name: k })) };
  }
};

async function getConfig(env) {
  const stored = await Redis.get(env, "bot_config", "json");
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function saveConfig(env, config) {
  await Redis.put(env, "bot_config", JSON.stringify(config));
}

// ============================================================
// Worker blacklist
// ============================================================

async function getWorkerBlacklist(env) {
  return (await Redis.get(env, "worker_blacklist", "json")) || [];
}

async function addWorkerToBlacklist(env, workerId, workerName) {
  if (!workerId || workerId === "?" || String(workerId).length < 10) return;
  const list = await getWorkerBlacklist(env);
  if (!list.find((w) => w.id === workerId)) {
    list.push({ id: workerId, name: workerName || "?", t: Date.now() });
    while (list.length > 30) list.shift();
    await Redis.put(env, "worker_blacklist", JSON.stringify(list));
  }
}

async function clearWorkerBlacklist(env) {
  await Redis.put(env, "worker_blacklist", "[]");
}

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

function getApiKey(env) { return (env.HORDE_API_KEY || "").trim() || "0000000000"; }

async function hordeCheckKey(env) {
  const key = getApiKey(env);
  try {
    const r = await fetch(`${HORDE_API}/find_user`, { headers: { apikey: key, ...HORDE_HEADERS } });
    if (r.status === 401 || r.status === 403) return { ok: false, anon: key === "0000000000" };
    const d = await r.json();
    return { ok: true, anon: key === "0000000000", user: d.username, kudos: d.kudos, trusted: d.trusted, flagged: d.flagged };
  } catch (e) { return { ok: false, anon: key === "0000000000", err: e.message }; }
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
    post_processing: config.postProcessors || [],
    n: 1,
  };

  if (params.post_processing.includes("GFPGAN") || params.post_processing.includes("CodeFormers")) {
    params.facefixer_strength = config.facefixerStrength || 0.75;
  }

  if (config.hiresFix) {
    params.hires_fix = true;
    params.hires_fix_denoising_strength = config.hiresFixDenoising || 0.65;
  }

  if (!opts.skipLoras && config.loras?.length > 0) {
    params.loras = config.loras.map((l) => ({
      name: String(l.name), model: l.strength ?? 1, clip: l.clip ?? 1, inject_trigger: "any", is_version: true
    }));
  }

  const body = {
    prompt: config.negativePrompt ? `${prompt} ### ${config.negativePrompt}` : prompt,
    params,
    nsfw: true, censor_nsfw: false, trusted_workers: false, replacement_filter: true,
    models: [config.model], r2: true, shared: false, allow_downgrade: true,
  };

  if (opts.workerBlacklist?.length > 0) {
    body.workers = opts.workerBlacklist.slice(0, 5);
    body.worker_blacklist = true;
  }

  const resp = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: key, ...HORDE_HEADERS },
    body: JSON.stringify(body)
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
  } catch (e) { return null; }
}

function base64ToBuffer(b64) {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch (e) { return null; }
}

function bufferSizeKB(buf) { return Math.round(buf.byteLength / 1024); }

async function deliverImage(tg, targetChats, imgData, caption, notifyChat) {
  if (!imgData) {
    if (notifyChat) await tg.send(notifyChat, "❌ Нет данных картинки от воркера");
    return { sent: false, tooSmall: false, sizeKB: 0 };
  }

  const isUrl = isHttpUrl(imgData);
  let buf = null;

  if (isUrl) {
    buf = await downloadImage(imgData);
  } else {
    buf = base64ToBuffer(imgData);
  }

  if (!buf && !isUrl) return { sent: false, tooSmall: false, sizeKB: 0 };

  const sizeKB = buf ? bufferSizeKB(buf) : 0;
  if (buf && sizeKB < MIN_IMAGE_KB) {
    if (notifyChat) await tg.send(notifyChat, `🚫 <b>Похоже на заглушку/цензуру</b>\nРазмер: ${sizeKB}KB (норма > ${MIN_IMAGE_KB}KB)`);
    return { sent: false, tooSmall: true, sizeKB };
  }

  let anySent = false;
  for (const chatId of targetChats) {
    if (!chatId) continue;
    let res = null;
    if (buf) {
      res = await tg.sendPhoto(chatId, buf, caption);
      if (!res.ok) res = await tg.sendDocument(chatId, buf, caption);
    }
    if ((!res || !res.ok) && isUrl) {
      res = await tg.sendPhotoUrl(chatId, imgData, caption);
    }
    if (res && res.ok) anySent = true;
  }

  return { sent: anySent, tooSmall: false, sizeKB };
}

// ============================================================
// LLM & Prompts
// ============================================================

const P = {
  angle: ["from above", "low angle", "eye level", "dutch angle", "bird's eye view", "close-up", "wide establishing shot"],
  light: ["golden hour", "blue hour", "dramatic chiaroscuro", "neon cyberpunk glow", "studio rim lighting", "volumetric god rays"],
  style: ["photorealistic photography", "digital concept art", "oil painting", "anime cel shading", "dark fantasy illustration", "film noir"],
  mood: ["serene", "intense", "mysterious", "vibrant", "ethereal", "dark and brooding", "epic"],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function templatePrompt(base) {
  return [base, pick(P.angle), pick(P.light), pick(P.style), pick(P.mood), "masterpiece", "highly detailed"].join(", ");
}

async function llmPrompt(instruction, apiKey, model) {
  let userInstruction = "";
  let basePrompt = instruction;
  // Поиск инструкций в скобках [Сделай это крутым]
  const match = instruction.match(/\[(.*?)\]/);
  if (match) {
    userInstruction = match[1];
    basePrompt = instruction.replace(match[0], '').trim();
  }

  let systemContent = "You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations. Under 100 words.";
  if (userInstruction) {
    systemContent += `\nCRITICAL: The user provided this specific instruction to modify the concept: "${userInstruction}". Radically alter the styling, environment, or mood based on this instruction.`;
  } else {
    systemContent += `\nMake it unique and creative.`;
  }

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: `Concept to expand into a prompt: ${basePrompt}` }
        ],
        temperature: 1.2, max_tokens: 150,
      }),
    });
    const data = await resp.json();
    const p = data.choices?.[0]?.message?.content?.trim().replace(/^["'`*]+|["'`*]+$/g, "");
    if (p?.length > 10) return p;
  } catch (e) { console.error("[LLM Prompt]", e.message); }
  return templatePrompt(basePrompt);
}

async function llmCaption(prompt, apiKey, model) {
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          { role: "system", content: "Ты — креативный копирайтер для Telegram-канала. Напиши красивое, короткое и атмосферное описание для картинки по промпту (1-3 предложения). Можно использовать эмодзи. Без хештегов. Пиши на русском." },
          { role: "user", content: prompt }
        ],
        temperature: 0.8, max_tokens: 150,
      }),
    });
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (text) return text;
  } catch (e) { console.error("[LLM Caption]", e.message); }
  return "";
}

async function generatePrompt(instruction, env) {
  const config = await getConfig(env);
  if (env.OPENROUTER_API_KEY) {
    return llmPrompt(instruction, env.OPENROUTER_API_KEY, config.llmModel || env.LLM_MODEL);
  }
  return templatePrompt(instruction);
}

// ============================================================
// UI & Settings Render
// ============================================================

function getMenuKeyboard(view, config) {
  if (view === "main") {
    return [
      [{text: "🎨 Параметры генерации", callback_data: "menu:params"}],
      [{text: "🤖 LLM & Настройки текста", callback_data: "menu:llm"}],
      [{text: "📢 Автопостинг & Каналы", callback_data: "menu:autopost"}],
      [{text: "❌ Закрыть", callback_data: "menu:close"}]
    ];
  }
  if (view === "params") {
    return [
      [{text: "📐 Изменить размер", callback_data: "menu:size"}, {text: "⚙️ Шаги и CFG", callback_data: "menu:stepscfg"}],
      [{text: "✨ Пост-обработка (Лица, Апскейл)", callback_data: "menu:postpro"}],
      [{text: "◀️ Назад", callback_data: "menu:main"}]
    ];
  }
  if (view === "size") {
    return [
      [{text: "1024x1024", callback_data: "set:size:1024:1024"}, {text: "832x1216", callback_data: "set:size:832:1216"}],
      [{text: "1216x832", callback_data: "set:size:1216:832"}, {text: "512x512", callback_data: "set:size:512:512"}],
      [{text: "◀️ Назад", callback_data: "menu:params"}]
    ];
  }
  if (view === "stepscfg") {
    return [
      [{text: "Шаги -5", callback_data: "set:steps:-5"}, {text: "Шаги +5", callback_data: "set:steps:5"}],
      [{text: "CFG -0.5", callback_data: "set:cfg:-0.5"}, {text: "CFG +0.5", callback_data: "set:cfg:0.5"}],
      [{text: "Сэмплер: Euler a", callback_data: "set:sampler:k_euler_a"}, {text: "Сэмплер: DPM++ 2M", callback_data: "set:sampler:k_dpmpp_2m"}],
      [{text: "◀️ Назад", callback_data: "menu:params"}]
    ];
  }
  if (view === "postpro") {
    const hasFace = config.postProcessors?.includes("GFPGAN");
    const hasUp = config.postProcessors?.includes("RealESRGAN_x4plus");
    const hasBg = config.postProcessors?.includes("strip_background");
    return [
      [{text: `${hasFace ? "✅" : "❌"} Коррекция лиц (GFPGAN)`, callback_data: "toggle:gfpgan"}],
      [{text: `${hasUp ? "✅" : "❌"} Апскейл 4x (RealESRGAN)`, callback_data: "toggle:upscale"}],
      [{text: `${hasBg ? "✅" : "❌"} Удалить фон`, callback_data: "toggle:bg"}],
      [{text: "◀️ Назад", callback_data: "menu:params"}]
    ];
  }
  if (view === "llm") {
    const modes = ["", "Скрывать", "Оригинал промпта", "LLM Описание"];
    return [
      [{text: `Режим текста: ${modes[config.captionMode]}`, callback_data: "toggle:captionmode"}],
      [{text: "◀️ Назад", callback_data: "menu:main"}]
    ];
  }
  if (view === "autopost") {
    return [
      [{text: config.enabled ? "🔴 Выключить Автопост" : "🟢 Включить Автопост", callback_data: "toggle:autopost"}],
      [{text: `Интервал: ${config.interval}м`, callback_data: "noop"}],
      [{text: "Интервал -10м", callback_data: "set:interval:-10"}, {text: "Интервал +10м", callback_data: "set:interval:10"}],
      [{text: "◀️ Назад", callback_data: "menu:main"}]
    ];
  }
  return [];
}

function getMenuText(view, config) {
  if (view === "main") {
    return `⚙️ <b>Настройки бота</b>\n\n<b>Промпт:</b> <code>${escapeHtml(config.generalPrompt || "Не задан")}</code>\n\nВыберите категорию:`;
  }
  if (view === "params") {
    return `🎨 <b>Параметры генерации</b>\n\n<b>Модель:</b> <code>${escapeHtml(config.model)}</code>\n<b>Размер:</b> ${config.width}x${config.height}\n<b>Шаги:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}\n<b>Сэмплер:</b> ${config.sampler}\n<b>Пост-обработка:</b> ${config.postProcessors?.length ? config.postProcessors.join(", ") : "нет"}`;
  }
  if (view === "size") return `📐 <b>Выберите размер:</b>\n(Текущий: ${config.width}x${config.height})`;
  if (view === "stepscfg") return `⚙️ <b>Шаги и CFG:</b>\n\nШаги: ${config.steps}\nCFG: ${config.cfgScale}\nСэмплер: ${config.sampler}`;
  if (view === "postpro") return `✨ <b>Пост-обработка:</b>\nЭти функции используют дополнительные ресурсы Horde.`;
  if (view === "llm") {
    const modes = ["", "Скрывать текст", "Оставлять оригинальный промпт", "Генерировать художественное описание (LLM)"];
    return `🤖 <b>Настройки текста (Caption)</b>\n\nТекущий режим: <b>${modes[config.captionMode]}</b>\n\n<i>Также вы можете отправлять инструкции для изменения промпта в скобках. Пример в промпте:\n"A beautiful girl [сделай её киберпанком]"</i>`;
  }
  if (view === "autopost") return `📢 <b>Автопостинг</b>\n\n<b>Статус:</b> ${config.enabled ? "ВКЛ" : "ВЫКЛ"}\n<b>Интервал:</b> ${config.interval} мин\n<b>Группа:</b> <code>${config.chatId || "Не привязана"}</code>\n<b>Канал:</b> <code>${config.channelId || "Не привязан"}</code>\n\n<i>(Привязка через команды /bindgroup и /bindchannel)</i>`;
  return "Меню";
}

async function renderSettings(tg, chatId, messageId, config, view) {
  if (view === "close") {
    await tg.editMessage(chatId, messageId, "✅ <i>Настройки закрыты</i>");
    return;
  }
  await tg.editMessage(chatId, messageId, getMenuText(view, config), {
    reply_markup: { inline_keyboard: getMenuKeyboard(view, config) }
  });
}

// ============================================================
// Callback & Command Handling
// ============================================================

async function handleCallback(cb, env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data;
  const userId = cb.from.id;

  let config = await getConfig(env);
  if (config.adminId && config.adminId !== userId) {
    return tg.answerCallback(cb.id, "🔒 Доступ запрещен", true);
  }

  let nextView = "main";
  let reload = false;

  if (data.startsWith("menu:")) {
    nextView = data.split(":")[1];
    reload = true;
  } else if (data.startsWith("set:size:")) {
    const [,, w, h] = data.split(":");
    config.width = parseInt(w); config.height = parseInt(h);
    nextView = "size"; reload = true;
  } else if (data.startsWith("set:steps:")) {
    config.steps = clamp(config.steps + parseInt(data.split(":")[2]), 10, 150);
    nextView = "stepscfg"; reload = true;
  } else if (data.startsWith("set:cfg:")) {
    config.cfgScale = clamp(config.cfgScale + parseFloat(data.split(":")[2]), 1, 30);
    nextView = "stepscfg"; reload = true;
  } else if (data.startsWith("set:sampler:")) {
    config.sampler = data.split(":")[2];
    nextView = "stepscfg"; reload = true;
  } else if (data.startsWith("set:interval:")) {
    config.interval = clamp(config.interval + parseInt(data.split(":")[2]), 5, 1440);
    nextView = "autopost"; reload = true;
  } else if (data.startsWith("toggle:autopost")) {
    config.enabled = !config.enabled;
    nextView = "autopost"; reload = true;
  } else if (data.startsWith("toggle:captionmode")) {
    config.captionMode = config.captionMode >= 3 ? 1 : config.captionMode + 1;
    nextView = "llm"; reload = true;
  } else if (data.startsWith("toggle:gfpgan")) {
    if(!config.postProcessors) config.postProcessors = [];
    if(config.postProcessors.includes("GFPGAN")) config.postProcessors = config.postProcessors.filter(x => x !== "GFPGAN");
    else config.postProcessors.push("GFPGAN");
    nextView = "postpro"; reload = true;
  } else if (data.startsWith("toggle:upscale")) {
    if(!config.postProcessors) config.postProcessors = [];
    if(config.postProcessors.includes("RealESRGAN_x4plus")) config.postProcessors = config.postProcessors.filter(x => x !== "RealESRGAN_x4plus");
    else config.postProcessors.push("RealESRGAN_x4plus");
    nextView = "postpro"; reload = true;
  } else if (data.startsWith("toggle:bg")) {
    if(!config.postProcessors) config.postProcessors = [];
    if(config.postProcessors.includes("strip_background")) config.postProcessors = config.postProcessors.filter(x => x !== "strip_background");
    else config.postProcessors.push("strip_background");
    nextView = "postpro"; reload = true;
  } else if (data === "noop") {
    return tg.answerCallback(cb.id);
  }

  if (reload) {
    await saveConfig(env, config);
    await tg.answerCallback(cb.id);
    await renderSettings(tg, chatId, messageId, config, nextView);
  }
}

async function handleCommand(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text || "";
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === "/ping") {
    return tg.send(chatId, `🏓 <b>Pong!</b> Redis подключен.`);
  }

  let config = await getConfig(env);

  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(env, config);
    await tg.send(chatId, `👑 Вы назначены админом. ID: <code>${userId}</code>`);
  }

  if (config.adminId !== userId) {
    await tg.send(chatId, `🔒 Только для администратора.`);
    return;
  }

  switch (cmd) {
    case "/start":
    case "/help": {
      await tg.send(
        chatId,
        `🤖 <b>Умный Image Bot</b>\n\n` +
          `/settings — ⚙️ Интерактивное меню настроек\n` +
          `/setprompt &lt;текст&gt; — Главный промпт\n` +
          `/generate — Сгенерировать сейчас\n\n` +
          `<b>Каналы и Группы:</b>\n` +
          `/bindgroup — Привязать текущую группу для автопостов\n` +
          `/unbindgroup — Отвязать группу\n` +
          `/bindchannel @channel_name — Привязать канал\n` +
          `/unbindchannel — Отвязать канал\n\n` +
          `<b>Модели:</b>\n` +
          `/setmodel &lt;имя&gt;\n` +
          `/listmodels [поиск] — Топ моделей\n`
      );
      break;
    }
    
    case "/settings": {
      await tg.send(chatId, getMenuText("main", config), {
        reply_markup: { inline_keyboard: getMenuKeyboard("main", config) }
      });
      break;
    }

    case "/setprompt": {
      const p = args.join(" ");
      if (!p) { await tg.send(chatId, "❌ /setprompt &lt;текст&gt;"); break; }
      config.generalPrompt = p;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Промпт установлен:\n<code>${escapeHtml(p)}</code>`);
      break;
    }

    case "/bindgroup": {
      config.chatId = chatId;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Группа привязана для автопостинга: <code>${chatId}</code>`);
      break;
    }
    case "/unbindgroup": {
      config.chatId = null;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Группа отвязана.`);
      break;
    }
    case "/bindchannel": {
      if(!args[0]) { await tg.send(chatId, "Укажите юзернейм или ID канала: /bindchannel @mychannel"); break; }
      config.channelId = args[0];
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Канал привязан: <code>${config.channelId}</code>`);
      break;
    }
    case "/unbindchannel": {
      config.channelId = null;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Канал отвязан.`);
      break;
    }

    case "/listmodels": {
      const query = args.join(" ").toLowerCase();
      await tg.send(chatId, "⏳ Загрузка списка моделей...");
      try {
        const models = await hordeGetModels();
        const sorted = (Array.isArray(models) ? models : [])
          .filter((m) => m.count > 0 && (!query || (m.name && m.name.toLowerCase().includes(query))))
          .sort((a, b) => b.count - a.count)
          .slice(0, 40);

        if (!sorted.length) { await tg.send(chatId, "Ничего не найдено."); break; }

        let txt = `📋 <b>Модели ${query ? `(поиск: ${query})` : "(топ-40)"}:</b>\n\n`;
        for (const m of sorted) {
          const tag = m.name?.includes("XL") || m.name?.includes("SDXL") ? "🟢" : "⚪";
          txt += `${tag} <code>${escapeHtml(m.name || "?")}</code> (${m.count}w)\n`;
        }
        await tg.send(chatId, txt);
      } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
      break;
    }
    
    case "/setmodel": {
      const name = args.join(" ");
      if (!name) { await tg.send(chatId, "❌ /setmodel &lt;имя&gt;"); break; }
      config.model = name;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Модель: <code>${escapeHtml(name)}</code>`);
      break;
    }

    case "/generate": {
      if (!config.generalPrompt) { await tg.send(chatId, "❌ Сначала установите /setprompt"); break; }
      await tg.send(chatId, `⏳ Начинаем генерацию...`);

      const bl = await getWorkerBlacklist(env);
      const blIds = bl.map((w) => w.id).filter(Boolean);

      for (let i = 0; i < config.count; i++) {
        try {
          const prompt = await generatePrompt(config.generalPrompt, env);
          
          let captionObj = "";
          if (config.captionMode === 3 && env.OPENROUTER_API_KEY) {
             captionObj = await llmCaption(prompt, env.OPENROUTER_API_KEY, config.llmModel);
          }

          const result = await hordeSubmit(prompt, config, env, { workerBlacklist: blIds });

          if (result.id) {
            await Redis.put(env, `pending:${result.id}`, JSON.stringify({
                chatId: config.chatId,
                channelId: config.channelId,
                prompt,
                captionStr: captionObj,
                at: Date.now(),
                notify: chatId,
                retries: 0,
              }), { expirationTtl: 3600 }
            );
            await tg.send(chatId, `📤 ID: <code>${result.id}</code>`);
          } else {
            await tg.send(chatId, `❌ Horde: <code>${escapeHtml(JSON.stringify(result).substring(0, 300))}</code>`);
          }
        } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
      }
      break;
    }

    case "/status": {
      const list = await Redis.keys(env, "pending:*");
      await tg.send(chatId, `📊 <b>Статус</b>\n\nОчередь (pending): ${list.keys.length}\nRedis URL: Настроен`);
      break;
    }

    case "/clearworkerbl": {
      await clearWorkerBlacklist(env);
      await tg.send(chatId, "✅ Блеклист очищен");
      break;
    }

    default: {
      if (cmd.startsWith("/")) await tg.send(chatId, "❓ Неизвестная команда. Введите /help или используйте /settings");
    }
  }
}

// ============================================================
// Scheduler
// ============================================================

async function processScheduled(env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.TELEGRAM_BOT_TOKEN) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);
  const pendingList = await Redis.keys(env, "pending:*");

  for (const keyObj of pendingList.keys) {
    const key = keyObj.name;
    const id = key.replace("pending:", "");
    try {
      const data = await Redis.get(env, key, "json");
      if (!data) { await Redis.del(env, key); continue; }

      if (Date.now() - data.at > 20 * 60 * 1000) {
        await Redis.del(env, key);
        if (data.notify) await tg.send(data.notify, `⏰ Таймаут генерации: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      if (!check.done) continue;

      const result = await hordeGetResult(id);
      await Redis.del(env, key);

      if (result.faulted) {
        if (data.notify) await tg.send(data.notify, `❌ Генерация <code>${id}</code> упала с ошибкой`);
        continue;
      }

      const gens = result.generations || [];
      if (!gens.length) continue;

      let anySent = false;
      let anySmall = false;

      for (const gen of gens) {
        const workerId = gen.worker_id || "?";
        const workerName = gen.worker_name || "?";
        const censored = isCensored(gen);

        if (censored) {
          await addWorkerToBlacklist(env, workerId, workerName);
          anySmall = true;
          continue;
        }

        let finalCaption = "";
        if (config.captionMode === 2) {
           finalCaption = `🎨 <i>${escapeHtml(data.prompt.substring(0, 200))}</i>`;
        } else if (config.captionMode === 3 && data.captionStr) {
           finalCaption = escapeHtml(data.captionStr);
        }

        const targets = [...new Set([data.chatId, data.channelId].filter(Boolean))];
        if (targets.length === 0 && data.notify) targets.push(data.notify); // Fallback to admin if nothing set

        const { sent, tooSmall, sizeKB } = await deliverImage(tg, targets, gen.img, finalCaption, data.notify);

        if (sent) anySent = true;
        else if (tooSmall) {
          anySmall = true;
          await addWorkerToBlacklist(env, workerId, workerName);
        }
      }

      if (anySmall && !anySent && !data.sfwTest) {
        const retries = (data.retries || 0) + 1;
        if (retries < MAX_RETRIES) {
          const bl = await getWorkerBlacklist(env);
          const nr = await hordeSubmit(data.prompt, config, env, { workerBlacklist: bl.map(w => w.id) });
          if (nr.id) {
            await Redis.put(env, `pending:${nr.id}`, JSON.stringify({ ...data, at: Date.now(), retries }), { expirationTtl: 3600 });
          }
        } else {
          if (data.notify) await tg.send(data.notify, `❌ <b>${MAX_RETRIES} попытки — всё заглушки/цензура</b>\n`);
        }
      }

      if (anySent && data.notify && !data.chatId && !data.channelId) {
         // Sent specifically as notification preview
      }
    } catch (e) { console.error(`[CRON] ${id}:`, e.message); }
  }

  // --- AUTOPOSTING LOGIC ---
  if (!config.enabled || (!config.chatId && !config.channelId) || !config.generalPrompt) return;
  const pl = await Redis.keys(env, "pending:*");
  if (pl.keys.length > 0) return;

  const lastPostStr = await Redis.get(env, "last_post_time") || "0";
  const lastPost = parseInt(lastPostStr, 10);
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  await Redis.put(env, "last_post_time", String(now));

  const bl = await getWorkerBlacklist(env);
  const blIds = bl.map((w) => w.id).filter(Boolean);

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env);
      
      let captionObj = "";
      if (config.captionMode === 3 && env.OPENROUTER_API_KEY) {
         captionObj = await llmCaption(prompt, env.OPENROUTER_API_KEY, config.llmModel);
      }

      const result = await hordeSubmit(prompt, config, env, { workerBlacklist: blIds });
      if (result.id) {
        await Redis.put(env, `pending:${result.id}`, JSON.stringify({
            chatId: config.chatId,
            channelId: config.channelId,
            prompt,
            captionStr: captionObj,
            at: now,
            notify: null,
            retries: 0,
          }), { expirationTtl: 3600 }
        );
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
        if (upd.message?.text) {
          await handleCommand(upd.message, env);
        } else if (upd.callback_query) {
          await handleCallback(upd.callback_query, env);
        }
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

    if (url.pathname === "/") {
      return new Response("🤖 Smart Telegram Image Bot v15 is running!");
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    try {
      await processScheduled(env);
    } catch (e) { console.error("[CRON] CRASH:", e.message); }
  },
};
