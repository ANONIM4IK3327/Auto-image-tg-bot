// ============================================================
//  Telegram Image Bot v12
//  Fixes:
//  - r2:false по умолчанию (base64 напрямую, без риска истечения URL)
//  - Диагностика малых файлов: показывает реальное содержимое 1KB-ответа
//  - Блэклист воркеров-цензоров при повторах (авто + глобальный)
//  - trusted_workers настраивается (по умолчанию false — больше воркеров)
//  - slow_workers: true по умолчанию — ещё больше воркеров
//  - Content-Type проверка при скачивании R2 URL
//  - Команды: /setr2, /settrusted, /setslow, /workerblacklist
// ============================================================

const DEFAULT_CONFIG = {
  enabled: false,
  chatId: null,
  adminId: null,
  interval: 60,
  count: 1,
  generalPrompt: "",
  model: "CyberRealistic Pony",
  loras: [],
  width: 704,
  height: 1024,
  steps: 8,
  cfgScale: 2,
  sampler: "k_euler_a",
  nsfw: true,
  negativePrompt:
    "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "",
  clipSkip: 2,
  hiresFix: false,
  hiresFixDenoising: 0.65,
  karras: true,
  // v12: новые настройки
  useR2: false,          // false = base64 (надёжнее), true = URL (быстрее, но может истекать)
  trustedWorkers: false, // false = больше воркеров
  slowWorkers: true,     // true = ещё больше воркеров
  workerBlacklist: [],   // список заблокированных воркеров-цензоров
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_AGENT = { "Client-Agent": "TgImageBot:12.0:tg" };
const MAX_RETRIES = 3;
const MIN_IMAGE_KB = 20;

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ══════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════

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
    if (!res.ok) console.error(`[TG] ${method}:`, JSON.stringify(res).substring(0, 200));
    return res;
  }

  send(chatId, text) {
    return this.api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  }

  async sendPhoto(chatId, arrayBuffer, filename = "image.jpeg", caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new File([arrayBuffer], filename, { type: "image/jpeg" }));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
    return await r.json();
  }

  async sendDocument(chatId, arrayBuffer, filename = "image.webp", caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new File([arrayBuffer], filename, { type: "image/webp" }));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form });
    return await r.json();
  }

  sendPhotoUrl(chatId, url, caption = "") {
    return this.api("sendPhoto", {
      chat_id: chatId,
      photo: url,
      caption: caption.substring(0, 1024),
      parse_mode: "HTML",
    });
  }
}

// ══════════════════════════════════════
//  KV STORAGE
// ══════════════════════════════════════

const KV = {
  async get(env, key, type = "text") {
    if (!env.BOT_KV) return null;
    try { return await env.BOT_KV.get(key, type); } catch { return null; }
  },
  async put(env, key, val, opts = {}) {
    if (!env.BOT_KV) throw new Error("KV не привязан!");
    await env.BOT_KV.put(key, val, opts);
  },
  async del(env, key) {
    if (env.BOT_KV) await env.BOT_KV.delete(key);
  },
  async list(env, prefix) {
    if (!env.BOT_KV) return { keys: [] };
    return env.BOT_KV.list({ prefix });
  },
};

async function getConfig(env) {
  const s = await KV.get(env, "config", "json");
  return { ...DEFAULT_CONFIG, ...(s || {}) };
}
async function saveConfig(env, c) {
  await KV.put(env, "config", JSON.stringify(c));
}

// ══════════════════════════════════════
//  CENSOR LOG
// ══════════════════════════════════════

async function getCensorLog(env) {
  return (await KV.get(env, "censor_log", "json")) || [];
}
async function addCensorLog(env, worker, reason) {
  const log = await getCensorLog(env);
  log.push({ w: worker, r: reason, t: Date.now() });
  while (log.length > 50) log.shift();
  await KV.put(env, "censor_log", JSON.stringify(log));
}
async function clearCensorLog(env) {
  await KV.put(env, "censor_log", "[]");
}

// ══════════════════════════════════════
//  AI HORDE
// ══════════════════════════════════════

function getApiKey(env) {
  return (env.HORDE_API_KEY || "").trim() || "0000000000";
}

async function hordeCheckKey(env) {
  const key = getApiKey(env);
  try {
    const r = await fetch(`${HORDE_API}/find_user`, {
      headers: { apikey: key, ...HORDE_AGENT },
    });
    if (r.status === 401 || r.status === 403)
      return { ok: false, anon: key === "0000000000" };
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
    tiling: false,
    post_processing: [],
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

  // v12: Блэклист воркеров (для повторов и глобальный)
  const blacklistedWorkers = opts.blacklistedWorkers || config.workerBlacklist || [];

  const body = {
    prompt: config.negativePrompt
      ? `${prompt} ### ${config.negativePrompt}`
      : prompt,
    params,
    nsfw: true,
    censor_nsfw: false,
    // v12: trusted_workers из конфига (false по умолчанию = больше воркеров)
    trusted_workers: opts.forceTrusted !== undefined ? opts.forceTrusted : (config.trustedWorkers ?? false),
    models: [config.model],
    // v12: r2 из конфига (false по умолчанию = base64, надёжнее)
    r2: opts.forceR2 !== undefined ? opts.forceR2 : (config.useR2 ?? false),
    replacement_filter: false,
    shared: false,
    // v12: slow_workers из конфига (true по умолчанию = больше воркеров)
    slow_workers: opts.forceSlow !== undefined ? opts.forceSlow : (config.slowWorkers ?? true),
    allow_downgrade: true,
    dry_run: false,
  };

  // v12: Добавляем блэклист если есть
  if (blacklistedWorkers.length > 0) {
    body.blacklist_workers = blacklistedWorkers;
  }

  const resp = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, ...HORDE_AGENT },
    body: JSON.stringify(body),
  });
  return await resp.json();
}

async function hordeCheck(id) {
  const r = await fetch(`${HORDE_API}/generate/check/${id}`, { headers: HORDE_AGENT });
  return r.json();
}

async function hordeGetResult(id) {
  const r = await fetch(`${HORDE_API}/generate/status/${id}`, { headers: HORDE_AGENT });
  return r.json();
}

async function hordeGetModels() {
  const r = await fetch(`${HORDE_API}/status/models?type=image`, { headers: HORDE_AGENT });
  return r.json();
}

// ══════════════════════════════════════
//  IMAGE DELIVERY
// ══════════════════════════════════════

// v12: Скачивает изображение с проверкой Content-Type
async function downloadImage(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[IMG] HTTP ${resp.status}`);
      return { buf: null, contentType: null, textPreview: `HTTP ${resp.status}` };
    }
    const contentType = resp.headers.get("content-type") || "";
    const buf = await resp.arrayBuffer();

    // Если Content-Type не image/* — это XML/HTML ошибка (истёкший R2 URL и т.п.)
    if (!contentType.includes("image/") && !contentType.includes("octet-stream")) {
      const text = new TextDecoder().decode(buf.slice(0, 400));
      console.error(`[IMG] Non-image: ${contentType}, body: ${text}`);
      return { buf: null, contentType, textPreview: text };
    }

    return { buf, contentType, textPreview: null };
  } catch (e) {
    console.error("[IMG] Fetch err:", e.message);
    return null;
  }
}

async function deliverImage(tg, chatId, imgData, caption, notifyChat) {
  if (!imgData) {
    if (notifyChat) await tg.send(notifyChat, "❌ Нет данных картинки (gen.img пустой)");
    return { sent: false, tooSmall: false };
  }

  let buf;
  const isUrl = imgData.startsWith("http");

  if (isUrl) {
    const result = await downloadImage(imgData);

    if (!result) {
      if (notifyChat) await tg.send(notifyChat, "❌ Не удалось скачать картинку по R2 URL");
      return { sent: false, tooSmall: false };
    }

    // v12: Если вернулся не-image контент — показываем что именно пришло
    if (!result.buf) {
      if (notifyChat) {
        await tg.send(notifyChat,
          `❌ <b>R2 URL вернул не-картинку!</b>\n` +
          `Content-Type: <code>${escapeHtml(result.contentType || "?")}</code>\n` +
          `Содержимое:\n<pre>${escapeHtml((result.textPreview || "").substring(0, 300))}</pre>\n\n` +
          `💡 <i>URL истёк или недоступен. Выполни /setr2 off для режима base64.</i>`
        );
      }
      return { sent: false, tooSmall: false };
    }

    buf = result.buf;
  } else {
    // Воркер вернул Base64 (режим r2:false)
    try {
      let b64 = imgData;
      // v12: поддержка data URL ("data:image/...;base64,...")
      if (b64.includes(",")) b64 = b64.split(",")[1];
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      buf = bytes.buffer;
    } catch (e) {
      console.error("[IMG] Base64 decode error", e);
      if (notifyChat) await tg.send(notifyChat, `❌ Base64 decode ошибка: ${escapeHtml(e.message)}`);
      return { sent: false, tooSmall: false };
    }
  }

  const sizeKB = Math.round(buf.byteLength / 1024);

  if (sizeKB < MIN_IMAGE_KB) {
    // v12: Диагностика малого изображения — определяем тип по заголовкам байт
    const bytes = new Uint8Array(buf.slice(0, 16));
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ");
    const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8;
    const isPng  = bytes[0] === 0x89 && bytes[1] === 0x50;
    const typeGuess = isJpeg ? "JPEG" : isPng ? "PNG" : "неизвестный";

    if (notifyChat) {
      await tg.send(notifyChat,
        `🚫 <b>Мелкая картинка!</b> ${sizeKB}KB (нужно >${MIN_IMAGE_KB}KB)\n` +
        `Формат: ${typeGuess} | Байты: <code>${hex}</code>\n\n` +
        (isJpeg || isPng
          ? `⚠️ Это настоящее изображение — вероятно <b>чёрный квадрат цензуры</b> от воркера.\n` +
            `Воркер имеет свой censor list. При повторе этот воркер будет исключён.`
          : `⚠️ Это не изображение — сбой воркера или ошибка данных.`)
      );
    }
    return { sent: false, tooSmall: true };
  }

  // 1. Пытаемся отправить как фото
  let res = await tg.sendPhoto(chatId, buf, "image.jpeg", caption);
  if (res.ok) return { sent: true, tooSmall: false };

  // 2. Отправляем как документ (WebP и другие форматы)
  console.log("[IMG] sendPhoto failed, trying sendDocument...", res.description);
  res = await tg.sendDocument(chatId, buf, "image.webp", caption);
  if (res.ok) return { sent: true, tooSmall: false };

  // 3. Фолбэк по URL если это была R2 ссылка
  if (isUrl) {
    console.log("[IMG] sendDocument failed, trying URL fallback...");
    const resUrl = await tg.sendPhotoUrl(chatId, imgData, caption);
    if (resUrl.ok) return { sent: true, tooSmall: false };
  }

  if (notifyChat) {
    await tg.send(notifyChat, `❌ Отправка не удалась: ${escapeHtml(res.description || "?")}`);
  }
  return { sent: false, tooSmall: false };
}

// ══════════════════════════════════════
//  PROMPT GENERATION
// ══════════════════════════════════════

const P = {
  angle: ["from above","low angle","eye level","dutch angle","bird's eye view","extreme close-up","wide establishing shot","portrait framing","three-quarter view","profile view","from behind","over the shoulder"],
  light: ["golden hour sunlight","blue hour twilight","dramatic chiaroscuro","soft overcast light","neon cyberpunk glow","moonlit night","studio rim lighting","dappled forest light","harsh midday shadows","candlelit ambiance","volumetric god rays","backlit silhouette"],
  style: ["photorealistic photography","digital concept art","oil painting","watercolor washes","anime cel shading","dark fantasy illustration","hyperrealistic 8k render","film noir","surrealist dreamlike","pop art","renaissance painting","vaporwave aesthetic"],
  mood: ["serene and peaceful","intense and dramatic","mysterious and enigmatic","vibrant and energetic","ethereal and dreamlike","dark and brooding","warm and intimate","epic and grandiose","melancholic","playful and whimsical"],
  detail: ["intricate filigree details","rough textured surfaces","smooth polished finish","ornate decoration","minimalist clean lines","weathered aged patina","crystalline sharp focus","beautiful bokeh","particle effects","reflections and refractions"],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function templatePrompt(base) {
  return [base, pick(P.angle), pick(P.light), pick(P.style), pick(P.mood), pick(P.detail), pick(P.detail), "masterpiece", "best quality", "highly detailed"].join(", ");
}

async function llmPrompt(instruction, apiKey, model) {
  const directions = [
    "Focus on unusual creative perspective",
    "Emphasize dramatic lighting and deep shadows",
    "Place subject in unexpected environment",
    "Focus on intricate textures and micro-details",
    "Use bold unconventional color palette",
    "Capture dynamic motion and energy",
    "Create contemplative atmospheric scene",
    "Use extreme framing — very close or very wide",
    "Create cinematic movie composition",
    "Add weather effects — rain, snow, fog",
    "Focus on reflections and mirror surfaces",
    "Give it futuristic sci-fi aesthetic",
  ];

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
        model: model || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          {
            role: "system",
            content: `You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations, no quotes, no markdown, no numbering. Under 100 words. Be creative and unique. Direction: ${pick(directions)}`,
          },
          {
            role: "user",
            content: `Create a unique detailed image generation prompt for: ${instruction}`,
          },
        ],
        temperature: 1.3,
        max_tokens: 200,
      }),
    });
    const data = await resp.json();
    if (data.choices?.[0]?.message?.content) {
      let p = data.choices[0].message.content.trim().replace(/^["'`*]+|["'`*]+$/g, "");
      if (p.length > 10) return p;
    }
  } catch (e) {
    console.error("[LLM]", e.message);
  }
  return templatePrompt(instruction);
}

async function generatePrompt(instruction, env) {
  if (env.OPENROUTER_API_KEY) {
    const config = await getConfig(env);
    const model = config.llmModel || env.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
    return llmPrompt(instruction, env.OPENROUTER_API_KEY, model);
  }
  return templatePrompt(instruction);
}

// ══════════════════════════════════════
//  COMMAND HANDLER
// ══════════════════════════════════════

async function handleCommand(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text || "";
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  // ── Команды без KV ──

  if (cmd === "/ping") {
    const k = getApiKey(env);
    await tg.send(chatId,
      `🏓 <b>Pong! v12</b>\n\n` +
      `📍 Chat: <code>${chatId}</code>\n` +
      `👤 User: <code>${userId}</code>\n` +
      `💾 KV: ${env.BOT_KV ? "✅ привязан" : "❌ не привязан"}\n` +
      `🎨 Horde: ${k === "0000000000" ? "❌ анонимный" : "✅ " + k.substring(0, 8) + "..."}\n` +
      `🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️ шаблоны"}`
    );
    return;
  }

  if (cmd === "/diagnostic") {
    const k = getApiKey(env);
    let config = {};
    try { config = await getConfig(env); } catch {}
    let t = `🔧 <b>Диагностика v12</b>\n\n`;
    t += `💾 KV: ${env.BOT_KV ? "✅" : "❌ НЕ ПРИВЯЗАН"}\n`;
    t += `🔑 Horde: ${k === "0000000000" ? "❌ анонимный" : "✅ " + k.substring(0, 8) + "..."}\n`;
    t += `🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}\n\n`;
    t += `⚙️ r2: ${config.useR2 ? "true (URL ⚠️ может истекать)" : "false (base64 ✅ надёжно)"}\n`;
    t += `⚙️ trusted_workers: ${config.trustedWorkers ?? false}\n`;
    t += `⚙️ slow_workers: ${config.slowWorkers ?? true}\n`;
    t += `⚙️ Блэклист воркеров: ${(config.workerBlacklist || []).length} шт.\n`;
    t += `⚙️ Мин. размер: ${MIN_IMAGE_KB}KB\n`;
    await tg.send(chatId, t);
    return;
  }

  if (cmd === "/checkkey") {
    await tg.send(chatId, "🔑 Проверяю ключ...");
    const info = await hordeCheckKey(env);
    if (!info.ok) {
      await tg.send(chatId, `❌ <b>Ключ невалидный!</b>\n\n${escapeHtml(info.err || "")}`);
    } else {
      await tg.send(chatId,
        `${info.anon ? "🔴" : "✅"} <b>${escapeHtml(info.user)}</b>\n\n` +
        `💎 Kudos: ${info.kudos}\n` +
        `🛡 Trusted: ${info.trusted ? "да" : "нет"}\n` +
        `🚩 Flagged: ${info.flagged ? "⚠️ ДА" : "нет"}\n\n` +
        (info.anon ? "🔴 <b>Анонимный ключ — NSFW будет цензуриться!</b>" :
         info.flagged ? "⚠️ Аккаунт помечен — возможна цензура" :
         "✅ Всё в порядке")
      );
    }
    return;
  }

  if (cmd === "/testimg") {
    await tg.send(chatId, "🧪 <b>Тест отправки картинок</b>\n\n1️⃣ URL метод...");
    const r1 = await tg.sendPhotoUrl(chatId, "https://picsum.photos/512/512", "✅ URL метод работает");
    await tg.send(chatId, r1.ok ? "✅ URL ОК!\n\n2️⃣ Buffer метод..." : `❌ URL: ${escapeHtml(r1.description)}\n\n2️⃣ Buffer метод...`);
    try {
      const resp = await fetch("https://picsum.photos/256/256");
      const buf = await resp.arrayBuffer();
      const r2 = await tg.sendPhoto(chatId, buf, "image.jpeg", "✅ Buffer метод работает");
      await tg.send(chatId, r2.ok ? "✅ <b>Оба метода работают!</b>" : `❌ Buffer: ${escapeHtml(r2.description)}`);
    } catch (e) {
      await tg.send(chatId, `❌ ${escapeHtml(e.message)}`);
    }
    return;
  }

  if (cmd === "/testsfw") {
    if (!env.BOT_KV) { await tg.send(chatId, "❌ KV!"); return; }
    const config = await getConfig(env);
    await tg.send(chatId,
      `🧪 <b>SFW тест генерации</b>\n\n` +
      `⚙️ r2: ${config.useR2 ? "true (URL)" : "false (base64 ✅)"}\n` +
      `⚙️ trusted: ${config.trustedWorkers ?? false}\n` +
      `⚙️ slow: ${config.slowWorkers ?? true}\n\n` +
      `Отправляю запрос на AI Horde...`
    );
    const sfwPrompt = "beautiful mountain landscape, crystal clear lake, sunset sky with orange and pink clouds, pine trees, snow capped peaks, nature photography, national geographic, 4k, masterpiece, best quality, highly detailed, sharp focus";
    try {
      const result = await hordeSubmit(sfwPrompt, config, env, { skipLoras: true });
      if (result.id) {
        await KV.put(env, `pending:${result.id}`, JSON.stringify({
          chatId, prompt: sfwPrompt, at: Date.now(), notify: chatId, debug: true, retries: 99, sfwTest: true,
        }), { expirationTtl: 3600 });
        await tg.send(chatId, `📤 ID: <code>${result.id}</code>\n⏳ Ожидай результат...`);
      } else {
        await tg.send(chatId, `❌ ${escapeHtml(JSON.stringify(result).substring(0, 400))}`);
      }
    } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
    return;
  }

  if (!env.BOT_KV) { await tg.send(chatId, "❌ KV не привязан! /diagnostic"); return; }
  let config = await getConfig(env);

  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(env, config);
    await tg.send(chatId, `👑 Вы назначены админом! ID: <code>${userId}</code>`);
  }
  if (config.adminId !== userId) {
    await tg.send(chatId, `🔒 Доступ только для админа (ID: ${config.adminId})`);
    return;
  }

  switch (cmd) {
    case "/start":
    case "/help": {
      await tg.send(chatId,
        `🤖 <b>Image Generator Bot v12</b>\n\n` +
        `<b>Основные:</b>\n` +
        `/status — текущие настройки\n` +
        `/generate — генерировать сейчас\n` +
        `/pending — очередь\n` +
        `/cancel — очистить очередь\n\n` +
        `<b>Настройки генерации:</b>\n` +
        `/setr2 [on|off] — URL vs base64 (рек. off)\n` +
        `/settrusted [on|off] — только trusted воркеры\n` +
        `/setslow [on|off] — медленные воркеры (рек. on)\n` +
        `/setmodel &lt;название&gt; — модель\n` +
        `/setprompt &lt;тема&gt; — промпт\n` +
        `/setchat — установить чат для постинга\n\n` +
        `<b>Диагностика:</b>\n` +
        `/checkkey — проверить API ключ\n` +
        `/testimg — тест отправки\n` +
        `/testsfw — тест генерации\n` +
        `/diagnostic — диагностика\n` +
        `/censorlog — лог цензуры\n` +
        `/workerblacklist — блэклист воркеров\n` +
        `/listmodels — список моделей`
      );
      break;
    }

    case "/setchat": {
      config.chatId = chatId;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Чат для постинга: <code>${chatId}</code>`);
      break;
    }

    case "/setprompt": {
      const p = args.join(" ");
      if (!p) { await tg.send(chatId, "❌ /setprompt &lt;ваша тема&gt;"); break; }
      config.generalPrompt = p;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Промпт:\n<code>${escapeHtml(p)}</code>`);
      break;
    }

    case "/setmodel": {
      const name = args.join(" ");
      if (!name) { await tg.send(chatId, "❌ /setmodel &lt;название&gt;"); break; }
      config.model = name;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Модель: <code>${escapeHtml(name)}</code>`);
      break;
    }

    // v12: Управление режимом r2
    case "/setr2": {
      const val = args[0]?.toLowerCase();
      if (val === "on" || val === "true") {
        config.useR2 = true;
        await saveConfig(env, config);
        await tg.send(chatId,
          `⚠️ <b>R2 URL режим включён.</b>\n\n` +
          `Картинки скачиваются по URL. Если снова 1KB — попробуй /setr2 off\n` +
          `(Presigned URL от AI Horde может истечь пока cron ждёт готовности)`
        );
      } else if (val === "off" || val === "false") {
        config.useR2 = false;
        await saveConfig(env, config);
        await tg.send(chatId,
          `✅ <b>Base64 режим включён (рекомендуется).</b>\n\n` +
          `Картинки приходят прямо в JSON-ответе API. Никаких истечений URL.`
        );
      } else {
        const current = config.useR2 ? "on (URL ⚠️)" : "off (base64 ✅)";
        await tg.send(chatId,
          `📡 <b>Текущий режим r2: ${current}</b>\n\n` +
          `/setr2 off — base64 (надёжно, рекомендуется)\n` +
          `/setr2 on — URL (чуть быстрее, может давать 1KB)`
        );
      }
      break;
    }

    // v12: Управление trusted_workers
    case "/settrusted": {
      const val = args[0]?.toLowerCase();
      if (val === "on" || val === "true") {
        config.trustedWorkers = true;
        await saveConfig(env, config);
        await tg.send(chatId, `✅ trusted_workers: true\n⚠️ Меньше воркеров доступно.`);
      } else if (val === "off" || val === "false") {
        config.trustedWorkers = false;
        await saveConfig(env, config);
        await tg.send(chatId, `✅ trusted_workers: false\n✅ Максимум доступных воркеров.`);
      } else {
        await tg.send(chatId,
          `🛡 <b>trusted_workers: ${config.trustedWorkers ?? false}</b>\n\n` +
          `/settrusted on — только доверенные\n` +
          `/settrusted off — все воркеры (рекомендуется)`
        );
      }
      break;
    }

    // v12: Управление slow_workers
    case "/setslow": {
      const val = args[0]?.toLowerCase();
      if (val === "on" || val === "true") {
        config.slowWorkers = true;
        await saveConfig(env, config);
        await tg.send(chatId, `✅ slow_workers: true\n✅ Больше воркеров доступно.`);
      } else if (val === "off" || val === "false") {
        config.slowWorkers = false;
        await saveConfig(env, config);
        await tg.send(chatId, `✅ slow_workers: false\n⚠️ Только быстрые воркеры.`);
      } else {
        await tg.send(chatId,
          `🐢 <b>slow_workers: ${config.slowWorkers ?? true}</b>\n\n` +
          `/setslow on — включить медленные (рекомендуется)\n` +
          `/setslow off — только быстрые`
        );
      }
      break;
    }

    // v12: Управление блэклистом воркеров
    case "/workerblacklist": {
      const bl = config.workerBlacklist || [];
      if (!bl.length) {
        await tg.send(chatId, "📋 Блэклист воркеров пуст\n\nВоркеры добавляются автоматически после 3 неудачных попыток.\n/censorlog — история цензуры");
      } else {
        let txt = `🚫 <b>Блэклист воркеров: ${bl.length}</b>\n\n`;
        bl.forEach((w, i) => { txt += `${i + 1}. <code>${escapeHtml(w)}</code>\n`; });
        txt += "\n/clearworkerblacklist — очистить";
        await tg.send(chatId, txt);
      }
      break;
    }

    case "/clearworkerblacklist": {
      config.workerBlacklist = [];
      await saveConfig(env, config);
      await tg.send(chatId, "✅ Блэклист воркеров очищен");
      break;
    }

    case "/enable": {
      config.enabled = true;
      await saveConfig(env, config);
      await tg.send(chatId, "🟢 Автопостинг включён");
      break;
    }

    case "/disable": {
      config.enabled = false;
      await saveConfig(env, config);
      await tg.send(chatId, "🔴 Автопостинг выключен");
      break;
    }

    case "/listmodels": {
      await tg.send(chatId, "⏳ Загружаю список моделей...");
      try {
        const models = await hordeGetModels();
        const sorted = models.filter(m => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 30);
        let txt = "📋 <b>Модели (топ-30 по числу воркеров):</b>\n\n";
        for (const m of sorted) {
          txt += `<code>${escapeHtml(m.name)}</code> (${m.count})\n`;
        }
        await tg.send(chatId, txt);
      } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
      break;
    }

    case "/status": {
      let pendingCount = 0;
      try { const pending = await KV.list(env, "pending:"); pendingCount = pending.keys.length; } catch {}
      const clog = await getCensorLog(env);
      const lorasTxt = (config.loras || []).map(l => `  • <code>${escapeHtml(l.name)}</code> (${l.strength})`).join("\n") || "  нет";
      const bl = config.workerBlacklist || [];

      await tg.send(chatId,
`📊 <b>Статус v12</b>

<b>Автопост:</b> ${config.enabled ? "🟢 ВКЛ" : "🔴 ВЫКЛ"}
<b>Чат:</b> <code>${config.chatId || "не задан"}</code>
<b>Интервал:</b> ${config.interval} мин. × ${config.count} шт.

<b>Промпт:</b>
<code>${escapeHtml(config.generalPrompt || "не задан")}</code>

<b>Модель:</b> <code>${escapeHtml(config.model)}</code>
<b>Размер:</b> ${config.width}×${config.height}
<b>NSFW:</b> ${config.nsfw ? "🔞 да" : "нет"}

<b>LoRA:</b>
${lorasTxt}

<b>🔧 Режим генерации:</b>
  r2: ${config.useR2 ? "URL ⚠️" : "base64 ✅"}
  trusted_workers: ${config.trustedWorkers ?? false}
  slow_workers: ${config.slowWorkers ?? true}
  Блэклист: ${bl.length} воркеров

<b>LLM:</b> <code>${escapeHtml(config.llmModel || env.LLM_MODEL || "auto")}</code>
<b>Цензура (лог):</b> ${clog.length} случаев
<b>В очереди:</b> ${pendingCount}`
      );
      break;
    }

    case "/generate": {
      if (!config.generalPrompt) { await tg.send(chatId, "❌ Сначала /setprompt"); break; }
      const target = config.chatId || chatId;
      await tg.send(chatId, `⏳ Генерирую ${config.count} изображений...\n⚙️ r2: ${config.useR2 ? "URL" : "base64 ✅"}`);
      for (let i = 0; i < config.count; i++) {
        try {
          const prompt = await generatePrompt(config.generalPrompt, env);
          await tg.send(chatId, `🎨 #${i + 1}: <code>${escapeHtml(prompt.substring(0, 200))}</code>`);
          const result = await hordeSubmit(prompt, config, env);
          if (result.id) {
            await KV.put(env, `pending:${result.id}`, JSON.stringify({
              chatId: target, prompt, at: Date.now(), notify: chatId, retries: 0,
            }), { expirationTtl: 3600 });
            await tg.send(chatId, `📤 ID: <code>${result.id}</code>`);
          } else { await tg.send(chatId, `❌ ${escapeHtml(JSON.stringify(result).substring(0, 300))}`); }
        } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
      }
      break;
    }

    case "/pending": {
      const list = await KV.list(env, "pending:");
      if (!list.keys.length) { await tg.send(chatId, "📋 Очередь пуста"); break; }
      let txt = `📋 <b>В очереди: ${list.keys.length}</b>\n\n`;
      const promises = list.keys.slice(0, 10).map(async (key) => {
        const id = key.name.replace("pending:", "");
        try {
          const check = await hordeCheck(id);
          const status = check.done ? "✅ Готово" : check.processing ? "⚙️ Генерируется" : `⏳ Очередь #${check.queue_position}`;
          return `🔸 <code>${id}</code>\n   ${status} | ~${check.wait_time || 0}с\n`;
        } catch {
          return `🔸 <code>${id}</code> — не удалось проверить\n`;
        }
      });
      const results = await Promise.all(promises);
      txt += results.join("\n");
      await tg.send(chatId, txt);
      break;
    }

    case "/cancel": {
      const list = await KV.list(env, "pending:");
      await Promise.all(list.keys.map(k => KV.del(env, k.name)));
      await tg.send(chatId, `🗑 Удалено из очереди: ${list.keys.length}`);
      break;
    }

    case "/censorlog": {
      const log = await getCensorLog(env);
      if (!log.length) { await tg.send(chatId, "📋 Лог цензуры пуст"); break; }
      let txt = `🚫 <b>Лог цензуры: ${log.length}</b>\n\n`;
      log.slice(-10).forEach(entry => {
        txt += `• <code>${escapeHtml(entry.w)}</code> [${entry.r}]\n  ${new Date(entry.t).toISOString().substring(0, 16)}\n\n`;
      });
      txt += "/clearcensorlog — очистить";
      await tg.send(chatId, txt);
      break;
    }

    case "/clearcensorlog": {
      await clearCensorLog(env);
      await tg.send(chatId, "✅ Лог очищен");
      break;
    }
  }
}

// ══════════════════════════════════════
//  CRON
// ══════════════════════════════════════

async function processScheduled(env) {
  if (!env.BOT_KV || !env.TELEGRAM_BOT_TOKEN) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);
  const pendingList = await KV.list(env, "pending:");

  for (const key of pendingList.keys) {
    const id = key.name.replace("pending:", "");

    try {
      const data = await KV.get(env, key.name, "json");
      if (!data) { await KV.del(env, key.name); continue; }

      if (Date.now() - data.at > 20 * 60 * 1000) {
        await KV.del(env, key.name);
        if (data.notify) await tg.send(data.notify, `⏰ Таймаут генерации: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      if (!check.done) continue;

      if (data.notify) await tg.send(data.notify, `⚡ Генерация <code>${id}</code> завершена! Получаю результат...`);

      const result = await hordeGetResult(id);

      if (result.faulted) {
        await KV.del(env, key.name);
        if (data.notify) await tg.send(data.notify, `❌ Генерация провалилась (faulted)`);
        continue;
      }

      const gens = result.generations || [];
      if (!gens.length) {
        await KV.del(env, key.name);
        continue;
      }

      let anySent = false;
      let anySmall = false;
      // v12: Собираем воркеров-цензоров для блэклиста
      const censoredWorkers = [];

      for (const gen of gens) {
        const worker = gen.worker_name || "?";

        if (data.debug && data.notify) {
          let imgInfo = "null";
          if (gen.img) {
            imgInfo = gen.img.startsWith("http")
              ? `URL (${gen.img.substring(0, 50)}...)`
              : `base64 (${gen.img.length} chars, ~${Math.round(gen.img.length * 0.75 / 1024)}KB декодировано)`;
          }
          await tg.send(data.notify,
            `🔍 <b>Результат:</b>\n` +
            `   Censored флаг: ${gen.censored ? "🔴 да" : "✅ нет"}\n` +
            `   Worker: <code>${escapeHtml(worker)}</code>\n` +
            `   Model: <code>${escapeHtml(gen.model || "?")}</code>\n` +
            `   Image: ${escapeHtml(imgInfo)}`
          );
        }

        if (data.notify) await tg.send(data.notify, `📨 Скачиваю и отправляю...`);

        const caption = data.prompt ? `🎨 <i>${escapeHtml(data.prompt.substring(0, 150))}</i>` : "";
        const { sent, tooSmall } = await deliverImage(tg, data.chatId, gen.img, caption, data.notify);

        if (sent) {
          anySent = true;
        } else if (tooSmall) {
          anySmall = true;
          await addCensorLog(env, worker, "small_image");
          // v12: запоминаем воркера-цензора
          if (worker !== "?") censoredWorkers.push(worker);
        }
      }

      await KV.del(env, key.name);

      if (anySmall && !anySent && !data.sfwTest) {
        const retries = (data.retries || 0) + 1;
        if (retries < MAX_RETRIES) {
          try {
            // v12: При повторе исключаем воркера-цензора
            const previousBlacklist = data.blacklistedWorkers || [];
            const newBlacklist = [...new Set([...previousBlacklist, ...censoredWorkers])];

            if (data.notify) {
              await tg.send(data.notify,
                `🔄 <b>Повтор ${retries}/${MAX_RETRIES}</b>` +
                (censoredWorkers.length > 0
                  ? `\nИсключаем: <code>${escapeHtml(censoredWorkers.join(", "))}</code>`
                  : "")
              );
            }

            const nr = await hordeSubmit(data.prompt, config, env, {
              blacklistedWorkers: newBlacklist,
            });
            if (nr.id) {
              await KV.put(env, `pending:${nr.id}`, JSON.stringify({
                ...data,
                at: Date.now(),
                retries,
                blacklistedWorkers: newBlacklist,
              }), { expirationTtl: 3600 });
              if (data.notify) await tg.send(data.notify, `📤 Новый ID: <code>${nr.id}</code>`);
            }
          } catch (e) { console.error("[CRON] retry:", e.message); }
        } else {
          // v12: После MAX_RETRIES — добавляем воркеров в глобальный блэклист
          const allCensored = [...new Set([...(data.blacklistedWorkers || []), ...censoredWorkers])];
          if (data.notify) {
            await tg.send(data.notify,
              `❌ <b>${MAX_RETRIES} попытки — всё равно заглушки!</b>\n\n` +
              (allCensored.length > 0
                ? `Воркеры-цензоры добавлены в глобальный блэклист:\n` +
                  allCensored.map(w => `• <code>${escapeHtml(w)}</code>`).join("\n") + "\n\n" +
                  `Используй /workerblacklist и /clearworkerblacklist для управления.`
                : `Попробуй сменить модель (/setmodel) или промпт (/setprompt)`)
            );
          }
          // v12: Автоматически сохраняем в глобальный блэклист
          if (allCensored.length > 0) {
            const freshConfig = await getConfig(env);
            const globalBl = new Set(freshConfig.workerBlacklist || []);
            allCensored.forEach(w => globalBl.add(w));
            freshConfig.workerBlacklist = [...globalBl];
            await saveConfig(env, freshConfig);
          }
        }
      }

      if (anySent && data.notify && data.notify !== data.chatId) {
        await tg.send(data.notify, "✅ Изображение отправлено!");
      }

    } catch (e) {
      console.error(`[CRON] ${id}:`, e.message);
    }
  }

  // ── Автопостинг ──
  if (!config.enabled || !config.chatId || !config.generalPrompt) return;
  const currentPending = await KV.list(env, "pending:");
  if (currentPending.keys.length > 0) return;

  const lastPost = parseInt((await KV.get(env, "last_post_time")) || "0");
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  await KV.put(env, "last_post_time", String(now));
  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env);
      if (result.id) {
        await KV.put(env, `pending:${result.id}`, JSON.stringify({
          chatId: config.chatId, prompt, at: now, notify: null, retries: 0,
        }), { expirationTtl: 3600 });
      }
    } catch (e) { console.error("[CRON] auto:", e.message); }
  }
}

// ══════════════════════════════════════
//  EXPORT
// ══════════════════════════════════════

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      let upd;
      try { upd = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

      if (upd.message?.text) {
        try { await handleCommand(upd.message, env); }
        catch (e) { console.error("[WH]", e.message); }
      }
      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TELEGRAM_BOT_TOKEN!", { status: 500 });
      const wh = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: wh, allowed_updates: ["message"], drop_pending_updates: true }),
      });
      const res = await r.json();
      return new Response(`Webhook: ${wh}\n\n${JSON.stringify(res, null, 2)}`);
    }

    return new Response("🤖 Image Bot v12 OK");
  },

  async scheduled(event, env, ctx) {
    try { await processScheduled(env); }
    catch (e) { console.error("[CRON] CRASH:", e.message); }
  },
};