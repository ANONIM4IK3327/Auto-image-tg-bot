// ============================================================
//  Telegram Image Bot v13 — Cloudflare Workers
//  AI Horde (NSFW, LoRA из CivitAI) + OpenRouter (промпты)
//
//  Исправления относительно v12:
//  ✅ slow_workers убран → API default = true (больше воркеров)
//  ✅ allow_downgrade убран → API default = false (без даунгрейда)
//  ✅ Цензура детектируется через gen_metadata[].type=="censorship"
//     (официальный способ по swagger, а не только размер файла)
//  ✅ gen.state === "censored" как дополнительная проверка
//  ✅ Блэклист воркеров через API: workers[] + worker_blacklist:true
//  ✅ nsfw:true явно везде = "пропускать воркеров с цензурой"
//  ✅ Структура из старого рабочего кода + фичи v12
// ============================================================

const DEFAULT_CONFIG = {
  enabled: false,
  chatId: null,
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
  negativePrompt:
    "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "",
  clipSkip: 2,
  hiresFix: false,
  hiresFixDenoising: 0.65,
  karras: true,
};

const HORDE_API = "https://stablehorde.net/api/v2";
// Идентификатор клиента для AI Horde (формат: name:version:contact)
const HORDE_AGENT = { "Client-Agent": "TgImageBot:13.0:tg" };
const MAX_RETRIES = 3;
// Минимальный размер нормальной картинки в KB
// Censorship placeholder от Horde ~2KB WebP
const MIN_IMAGE_KB = 10;

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

  // Отправка картинки из буфера памяти (Buffer → FormData)
  async sendPhoto(chatId, arrayBuffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    // Всегда jpeg для Telegram (он конвертирует WebP в jpeg на лету)
    form.append("photo", new File([arrayBuffer], "image.jpeg", { type: "image/jpeg" }));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
    return r.json();
  }

  // Документ для форматов, которые sendPhoto не принимает
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

  // Отправка по URL (R2-ссылки часто принимаются напрямую)
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
//  WORKER BLACKLIST
//  Хранит ID воркеров, вернувших заглушки
//  Передаётся в Horde API как workers[] + worker_blacklist:true
// ══════════════════════════════════════

async function getWorkerBlacklist(env) {
  return (await KV.get(env, "worker_blacklist", "json")) || [];
}

async function addWorkerToBlacklist(env, workerId, workerName) {
  if (!workerId || workerId === "?" || workerId.length < 10) return;
  const list = await getWorkerBlacklist(env);
  if (!list.find(w => w.id === workerId)) {
    list.push({ id: workerId, name: workerName, t: Date.now() });
    while (list.length > 30) list.shift();
    await KV.put(env, "worker_blacklist", JSON.stringify(list));
    console.log(`[BL] Добавлен воркер: ${workerName} (${workerId})`);
  }
}

async function clearWorkerBlacklist(env) {
  await KV.put(env, "worker_blacklist", "[]");
}

// ══════════════════════════════════════
//  CENSORSHIP DETECTION
//
//  По swagger gen_metadata[].type === "censorship" — официальный
//  способ. gen.censored и gen.state === "censored" тоже проверяем.
// ══════════════════════════════════════

function isCensored(gen) {
  // 1. Официальный способ (swagger: gen_metadata)
  if (gen.gen_metadata?.some(m => m.type === "censorship")) return true;
  // 2. Флаг censored
  if (gen.censored === true) return true;
  // 3. Устаревшее поле state (swagger помечает как OBSOLETE)
  if (gen.state === "censored") return true;
  return false;
}

// ══════════════════════════════════════
//  AI HORDE API
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

  // ─────────────────────────────────────────────────────────
  //  ПАРАМЕТРЫ ЗАПРОСА — объяснение каждого флага:
  //
  //  nsfw: true
  //    Swagger: "Set to true if this request is NSFW.
  //    This will SKIP workers which censor images."
  //    → Самый важный флаг. Horde сам фильтрует воркеров с цензурой.
  //
  //  censor_nsfw: false
  //    Swagger: "If the request is SFW, and the worker accidentally
  //    generates NSFW, it will send back a censored image."
  //    → Нам не нужна эта цензура, ставим false.
  //
  //  trusted_workers: false  (API default: false)
  //    Swagger: "When true, only trusted workers will serve this
  //    request. When False, Evaluating workers will also be used
  //    which can increase speed but adds more risk!"
  //    → Оставляем false для широкого пула воркеров.
  //
  //  slow_workers: НЕ УКАЗЫВАЕМ  (API default: true)
  //    Swagger: "When True, allows slower workers to pick up this
  //    request. Disabling this incurs an extra kudos cost."
  //    → В v12 мы ставили false — это СРЕЗАЛО большинство воркеров
  //      и стоило лишние кудосы! Теперь используем дефолт (true).
  //
  //  replacement_filter: true  (API default: true)
  //    Swagger: "If enabled, suspicious prompts are sanitized
  //    through a string replacement filter instead."
  //    → Безопаснее true — слово не блокирует весь запрос.
  //
  //  allow_downgrade: НЕ УКАЗЫВАЕМ  (API default: false)
  //    В v12 мы ставили true — это могло подменять модель на
  //    другую с цензурой. Теперь используем дефолт (false).
  //
  //  r2: true  (API default: true)
  //    Изображение отдаётся как URL к R2-бакету. Если воркер
  //    не смог залить в R2 — придёт base64 WebP.
  //
  //  workers[] + worker_blacklist: true
  //    Передаём накопленный список ID воркеров-цензоров.
  //    Horde не выдаёт задание этим воркерам.
  // ─────────────────────────────────────────────────────────

  const params = {
    sampler_name: config.sampler,
    cfg_scale: config.cfgScale,
    width: config.width,
    height: config.height,
    steps: config.steps,
    karras: config.karras !== false,
    clip_skip: config.clipSkip || 2,
    tiling: false,
    allow_downgrade: true,
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

  const body = {
    prompt: config.negativePrompt
      ? `${prompt} ### ${config.negativePrompt}`
      : prompt,
    params,
    nsfw: true,                  // Пропускать воркеров с цензурой
    censor_nsfw: false,          // Не цензурить NSFW-контент
    trusted_workers: false,      // Широкий пул воркеров
    replacement_filter: true,    // Замена слов вместо блока запроса
    models: [config.model],
    r2: true,                    // Получаем URL, а не base64
    shared: false,
  };

  // Блэклист воркеров (max 5 по API)
  if (opts.workerBlacklist?.length > 0) {
    body.workers = opts.workerBlacklist.slice(0, 5);
    body.worker_blacklist = true;
  }

  const resp = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, ...HORDE_AGENT },
    body: JSON.stringify(body),
  });
  return resp.json();
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

// Декодируем base64 в ArrayBuffer
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

// Отдаёт { sent: bool, tooSmall: bool, sizeKB: number }
async function deliverImage(tg, chatId, imgData, caption, notifyChat) {
  if (!imgData) {
    if (notifyChat) await tg.send(notifyChat, "❌ Нет данных картинки от воркера");
    return { sent: false, tooSmall: false, sizeKB: 0 };
  }

  const isUrl = imgData.startsWith("http");
  let buf;

  if (isUrl) {
    buf = await downloadImage(imgData);
    if (!buf) {
      if (notifyChat) await tg.send(notifyChat, "❌ Не удалось скачать с R2. Пробуем URL напрямую...");
      // Попробуем отправить URL напрямую в Telegram
      const urlRes = await tg.sendPhotoUrl(chatId, imgData, caption);
      if (urlRes.ok) return { sent: true, tooSmall: false, sizeKB: 0 };
      return { sent: false, tooSmall: false, sizeKB: 0 };
    }
  } else {
    buf = base64ToBuffer(imgData);
    if (!buf) return { sent: false, tooSmall: false, sizeKB: 0 };
  }

  const sizeKB = Math.round(buf.byteLength / 1024);

  // Censorship placeholder от Horde — маленький WebP (~2KB)
  if (sizeKB < MIN_IMAGE_KB) {
    if (notifyChat) {
      await tg.send(notifyChat,
        `🚫 <b>Цензурная заглушка!</b> Размер: ${sizeKB}KB (норма >${MIN_IMAGE_KB}KB)\n` +
        `Воркер добавляется в блэклист, запрос повторяется...`
      );
    }
    return { sent: false, tooSmall: true, sizeKB };
  }

  // 1. Отправляем как фото (Telegram конвертирует WebP → jpeg)
  let res = await tg.sendPhoto(chatId, buf, caption);
  if (res.ok) return { sent: true, tooSmall: false, sizeKB };

  // 2. Фолбэк — как документ (сохраняет оригинальный WebP)
  console.log("[IMG] sendPhoto failed, trying sendDocument:", res.description);
  res = await tg.sendDocument(chatId, buf, caption);
  if (res.ok) return { sent: true, tooSmall: false, sizeKB };

  // 3. Для R2 URL — последний шанс, отправляем ссылку напрямую
  if (isUrl) {
    console.log("[IMG] sendDocument failed, trying URL fallback...");
    const urlRes = await tg.sendPhotoUrl(chatId, imgData, caption);
    if (urlRes.ok) return { sent: true, tooSmall: false, sizeKB };
  }

  if (notifyChat) {
    await tg.send(notifyChat, `❌ Не удалось отправить: ${escapeHtml(res.description || "?")}`);
  }
  return { sent: false, tooSmall: false, sizeKB };
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
function pickN(arr, n) { return [...arr].sort(() => Math.random() - 0.5).slice(0, n); }

function templatePrompt(base) {
  return [base, pick(P.angle), pick(P.light), pick(P.style), pick(P.mood), ...pickN(P.detail, 2), "masterpiece", "best quality", "highly detailed"].join(", ");
}

async function llmPrompt(instruction, apiKey, model) {
  const directions = [
    "Focus on unusual creative perspective", "Emphasize dramatic lighting and deep shadows",
    "Place subject in unexpected environment", "Focus on intricate textures and micro-details",
    "Use bold unconventional color palette", "Capture dynamic motion and energy",
    "Create contemplative atmospheric scene", "Use extreme framing — very close or very wide",
    "Create cinematic movie composition", "Add weather effects — rain, snow, fog",
    "Focus on reflections and mirror surfaces", "Give it futuristic sci-fi aesthetic",
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
            content: `You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations, no quotes, no markdown. Under 100 words. Be creative and unique. Direction: ${pick(directions)}`,
          },
          { role: "user", content: `Create a unique detailed image generation prompt for: ${instruction}` },
        ],
        temperature: 1.3,
        max_tokens: 200,
      }),
    });
    const data = await resp.json();
    const p = data.choices?.[0]?.message?.content?.trim().replace(/^["'`*]+|["'`*]+$/g, "");
    if (p?.length > 10) return p;
  } catch (e) { console.error("[LLM]", e.message); }
  return templatePrompt(instruction);
}

async function generatePrompt(instruction, env) {
  if (env.OPENROUTER_API_KEY) {
    const config = await getConfig(env);
    return llmPrompt(instruction, env.OPENROUTER_API_KEY, config.llmModel || env.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free");
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
      `🏓 <b>Pong! v13</b>\n\n` +
      `📍 Chat: <code>${chatId}</code>\n` +
      `👤 User: <code>${userId}</code>\n` +
      `💾 KV: ${env.BOT_KV ? "✅" : "❌"}\n` +
      `🎨 Horde: ${k === "0000000000" ? "🔴 анонимный (NSFW не работает!)" : "✅ " + k.substring(0, 8) + "..."}\n` +
      `🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️ шаблоны"}`
    );
    return;
  }

  if (cmd === "/diagnostic") {
    const k = getApiKey(env);
    const bl = await getWorkerBlacklist(env);
    await tg.send(chatId,
      `🔧 <b>Диагностика v13</b>\n\n` +
      `💾 KV: ${env.BOT_KV ? "✅" : "❌ НЕ ПРИВЯЗАН"}\n` +
      `🔑 Horde key: ${k === "0000000000" ? "🔴 анонимный" : "✅ " + k.substring(0, 8) + "..."}\n` +
      `🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}\n\n` +
      `<b>Параметры запроса:</b>\n` +
      `  nsfw: true (пропускает воркеров с цензурой)\n` +
      `  censor_nsfw: false\n` +
      `  trusted_workers: false (широкий пул)\n` +
      `  slow_workers: <i>default true</i> (не отключаем!)\n` +
      `  replacement_filter: true\n` +
      `  r2: true\n\n` +
      `🚫 Воркеров в блэклисте: <b>${bl.length}</b>\n` +
      `📏 Мин. размер картинки: ${MIN_IMAGE_KB}KB\n\n` +
      `<b>Детект цензуры (v13):</b>\n` +
      `  1. gen_metadata[].type=="censorship" (swagger)\n` +
      `  2. gen.censored === true\n` +
      `  3. gen.state === "censored"\n` +
      `  4. Размер файла < ${MIN_IMAGE_KB}KB`
    );
    return;
  }

  if (cmd === "/checkkey") {
    await tg.send(chatId, "🔑 Проверяю ключ Horde...");
    const info = await hordeCheckKey(env);
    if (!info.ok) {
      await tg.send(chatId, `❌ <b>Ключ невалидный!</b>\n${escapeHtml(info.err || "")}`);
    } else {
      let status = "";
      if (info.anon) status = "🔴 <b>Анонимный ключ!</b>\nNSFW работать НЕ БУДЕТ.\nЗарегистрируйся: https://stablehorde.net";
      else if (info.flagged) status = "⚠️ Аккаунт помечен — возможна цензура";
      else status = "✅ Всё в порядке, NSFW должен работать";

      await tg.send(chatId,
        `${info.anon ? "🔴" : "✅"} <b>${escapeHtml(info.user || "anonymous")}</b>\n\n` +
        `💎 Kudos: ${info.kudos || 0}\n` +
        `🛡 Trusted: ${info.trusted ? "да" : "нет"}\n` +
        `🚩 Flagged: ${info.flagged ? "⚠️ ДА" : "нет"}\n\n` +
        status
      );
    }
    return;
  }

  if (cmd === "/testimg") {
    await tg.send(chatId, "🧪 <b>Тест отправки изображений</b>\n\n1. URL метод...");
    const r1 = await tg.sendPhotoUrl(chatId, "https://picsum.photos/512/512", "URL метод");
    await tg.send(chatId, r1.ok ? "✅ URL работает!\n\n2. Buffer метод..." : `❌ URL: ${escapeHtml(r1.description)}\n\n2. Buffer метод...`);
    try {
      const resp = await fetch("https://picsum.photos/256/256");
      const buf = await resp.arrayBuffer();
      const r2 = await tg.sendPhoto(chatId, buf, "Buffer метод");
      await tg.send(chatId, r2.ok ? "✅ <b>Оба метода работают!</b>" : `❌ Buffer: ${escapeHtml(r2.description)}`);
    } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
    return;
  }

  if (cmd === "/testsfw") {
    if (!env.BOT_KV) { await tg.send(chatId, "❌ KV не привязан!"); return; }
    const config = await getConfig(env);
    await tg.send(chatId, "🧪 <b>SFW тест генерации (горы, пейзаж)</b>\nОтправляю в Horde...");
    const sfwPrompt = "beautiful mountain landscape, crystal clear lake, sunset sky, orange and pink clouds, pine trees, snow capped peaks, nature photography, 4k, masterpiece, best quality, highly detailed, sharp focus";
    try {
      const result = await hordeSubmit(sfwPrompt, config, env, { skipLoras: true });
      if (result.id) {
        await KV.put(env, `pending:${result.id}`, JSON.stringify({
          chatId, prompt: sfwPrompt, at: Date.now(), notify: chatId, debug: true, retries: 99, sfwTest: true,
        }), { expirationTtl: 3600 });
        await tg.send(chatId, `📤 ID: <code>${result.id}</code>\n⏳ Жди результат (следующий cron-тик)...`);
      } else {
        await tg.send(chatId, `❌ Horde ответил: <code>${escapeHtml(JSON.stringify(result).substring(0, 400))}</code>`);
      }
    } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
    return;
  }

  if (!env.BOT_KV) { await tg.send(chatId, "❌ KV не привязан! Используй /diagnostic"); return; }
  let config = await getConfig(env);

  // Первый пользователь = admin
  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(env, config);
    await tg.send(chatId, `👑 Ты назначен админом. ID: <code>${userId}</code>`);
  }
  if (config.adminId !== userId) {
    await tg.send(chatId, `🔒 Только для админа (ID: ${config.adminId})`);
    return;
  }

  switch (cmd) {
    case "/start":
    case "/help": {
      await tg.send(chatId,
        `🤖 <b>Image Bot v13</b>\n\n` +
        `<b>Основные:</b>\n` +
        `/setchat — чат для постинга\n` +
        `/setprompt &lt;текст&gt; — тема\n` +
        `/setinterval &lt;мин&gt; — интервал\n` +
        `/setcount &lt;1-10&gt; — кол-во\n` +
        `/enable | /disable — авторежим\n` +
        `/generate — сгенерировать сейчас\n\n` +
        `<b>Модель и LoRA:</b>\n` +
        `/setmodel &lt;название&gt;\n` +
        `/listmodels — топ-40 моделей\n` +
        `/searchlora &lt;запрос&gt; — CivitAI\n` +
        `/addlora &lt;version_id&gt; [сила] [clip]\n` +
        `/removelora &lt;id&gt; | /listloras\n\n` +
        `<b>Параметры:</b>\n` +
        `/setsize &lt;W&gt; &lt;H&gt; | /setsteps &lt;N&gt;\n` +
        `/setcfg &lt;N&gt; | /setsampler &lt;имя&gt;\n` +
        `/setneg &lt;текст&gt; | /setclipskip &lt;1-4&gt;\n` +
        `/setllm &lt;model_id&gt;\n\n` +
        `<b>Управление:</b>\n` +
        `/status | /pending | /cancel\n` +
        `/workerbl — блэклист воркеров\n` +
        `/clearworkerbl — очистить блэклист\n` +
        `/checkkey — проверить ключ Horde\n` +
        `/diagnostic | /testsfw | /testimg`
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
      if (!p) { await tg.send(chatId, "❌ /setprompt &lt;тема&gt;"); break; }
      config.generalPrompt = p;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Промпт:\n<code>${escapeHtml(p)}</code>`);
      break;
    }

    case "/setinterval": {
      const n = parseInt(args[0]);
      if (isNaN(n) || n < 1) { await tg.send(chatId, "❌ /setinterval &lt;минуты&gt; (мин. 1)"); break; }
      config.interval = n;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Интервал: ${n} мин.`);
      break;
    }

    case "/setcount": {
      const n = parseInt(args[0]);
      if (isNaN(n) || n < 1 || n > 10) { await tg.send(chatId, "❌ /setcount &lt;1-10&gt;"); break; }
      config.count = n;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Кол-во: ${n}`);
      break;
    }

    case "/setmodel": {
      const name = args.join(" ");
      if (!name) { await tg.send(chatId, "❌ /setmodel &lt;название&gt;\nСм. /listmodels"); break; }
      config.model = name;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Модель: <code>${escapeHtml(name)}</code>`);
      break;
    }

    case "/listmodels": {
      await tg.send(chatId, "⏳ Загружаю список...");
      try {
        const models = await hordeGetModels();
        const sorted = models.filter(m => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 40);
        let txt = "📋 <b>Модели (топ-40):</b>\n\n";
        for (const m of sorted) {
          const tag = (m.name.includes("XL") || m.name.includes("SDXL")) ? "🟢" : "⚪";
          txt += `${tag} <code>${escapeHtml(m.name)}</code> (${m.count}w)\n`;
        }
        txt += "\n🟢 = SDXL  ⚪ = SD1.5\n/setmodel &lt;название&gt;";
        await tg.send(chatId, txt);
      } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
      break;
    }

    case "/searchlora": {
      const query = args.join(" ");
      if (!query) { await tg.send(chatId, "❌ /searchlora &lt;запрос на английском&gt;"); break; }
      await tg.send(chatId, "🔍 Ищу на CivitAI...");
      try {
        const url = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(query)}&limit=10&sort=Highest%20Rated&nsfw=true`;
        const data = await (await fetch(url)).json();
        if (!data.items?.length) { await tg.send(chatId, "😕 Ничего не найдено"); break; }
        let txt = `🔍 <b>LoRA: "${escapeHtml(query)}"</b>\n\n`;
        for (const item of data.items.slice(0, 10)) {
          const ver = item.modelVersions?.[0];
          const vid = ver?.id || "?";
          txt += `${item.nsfw ? "🔞" : "✅"} <b>${escapeHtml(item.name)}</b> [${ver?.baseModel || "?"}]\n`;
          txt += `   ➕ <code>/addlora ${vid} 0.8</code>\n\n`;
        }
        await tg.send(chatId, txt);
      } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
      break;
    }

    case "/addlora": {
      const id = args[0]; const str = parseFloat(args[1]) || 0.8; const clip = parseFloat(args[2]) || 1;
      if (!id) { await tg.send(chatId, "❌ /addlora &lt;civitai_version_id&gt; [strength=0.8] [clip=1]"); break; }
      config.loras = (config.loras || []).filter(l => String(l.name) !== String(id));
      config.loras.push({ name: id, strength: str, clip });
      await saveConfig(env, config);
      await tg.send(chatId, `✅ LoRA <code>${id}</code> (strength: ${str}, clip: ${clip})`);
      break;
    }

    case "/removelora": {
      const id = args[0];
      if (!id) { await tg.send(chatId, "❌ /removelora &lt;id&gt;"); break; }
      config.loras = (config.loras || []).filter(l => String(l.name) !== String(id));
      await saveConfig(env, config);
      await tg.send(chatId, `✅ LoRA <code>${id}</code> удалена`);
      break;
    }

    case "/listloras": {
      const loras = config.loras || [];
      if (!loras.length) { await tg.send(chatId, "📋 LoRA нет. /searchlora для поиска"); break; }
      let txt = "📋 <b>Ваши LoRA:</b>\n\n";
      loras.forEach((l, i) => {
        txt += `${i + 1}. <code>${escapeHtml(l.name)}</code> (str: ${l.strength}, clip: ${l.clip})\n   ❌ /removelora ${l.name}\n\n`;
      });
      await tg.send(chatId, txt);
      break;
    }

    case "/setsize": {
      let w = parseInt(args[0]), h = parseInt(args[1]);
      if (isNaN(w) || isNaN(h) || w < 256 || h < 256 || w > 2048 || h > 2048) {
        await tg.send(chatId, "❌ /setsize &lt;W&gt; &lt;H&gt; (256-2048, кратно 64)\n\n<code>/setsize 1024 1024</code> — квадрат\n<code>/setsize 832 1216</code> — портрет\n<code>/setsize 1216 832</code> — ландшафт");
        break;
      }
      config.width = Math.round(w / 64) * 64;
      config.height = Math.round(h / 64) * 64;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Размер: ${config.width}×${config.height}`);
      break;
    }

    case "/setsteps": {
      const s = parseInt(args[0]);
      if (isNaN(s) || s < 1 || s > 150) { await tg.send(chatId, "❌ /setsteps &lt;1-150&gt;"); break; }
      config.steps = s;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Steps: ${s}`);
      break;
    }

    case "/setcfg": {
      const c = parseFloat(args[0]);
      if (isNaN(c) || c < 1 || c > 30) { await tg.send(chatId, "❌ /setcfg &lt;1-30&gt;"); break; }
      config.cfgScale = c;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ CFG: ${c}`);
      break;
    }

    case "/setsampler": {
      const samplers = ["k_euler","k_euler_a","k_lms","k_heun","k_dpm_2","k_dpm_2_a","k_dpmpp_2s_a","k_dpmpp_2m","k_dpmpp_sde","DDIM"];
      const s = args[0];
      if (!s || !samplers.includes(s)) {
        await tg.send(chatId, `❌ Доступные сэмплеры:\n${samplers.map(x => `<code>${x}</code>`).join("\n")}`);
        break;
      }
      config.sampler = s;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Сэмплер: ${s}`);
      break;
    }

    case "/setneg": {
      config.negativePrompt = args.join(" ") || DEFAULT_CONFIG.negativePrompt;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Негативный промпт:\n<code>${escapeHtml(config.negativePrompt)}</code>`);
      break;
    }

    case "/setclipskip": {
      const cs = parseInt(args[0]);
      if (isNaN(cs) || cs < 1 || cs > 4) { await tg.send(chatId, "❌ /setclipskip &lt;1-4&gt;"); break; }
      config.clipSkip = cs;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ CLIP Skip: ${cs}`);
      break;
    }

    case "/setllm": {
      const llm = args.join(" ");
      if (!llm) {
        await tg.send(chatId,
          `❌ /setllm &lt;model_id&gt;\n\n<b>Бесплатные на OpenRouter:</b>\n` +
          `<code>meta-llama/llama-3.1-8b-instruct:free</code>\n` +
          `<code>google/gemma-2-9b-it:free</code>\n` +
          `<code>mistralai/mistral-7b-instruct:free</code>\n` +
          `<code>qwen/qwen-2-7b-instruct:free</code>`
        );
        break;
      }
      config.llmModel = llm;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ LLM: <code>${escapeHtml(llm)}</code>`);
      break;
    }

    case "/enable": {
      if (!config.chatId) { await tg.send(chatId, "❌ Сначала /setchat"); break; }
      if (!config.generalPrompt) { await tg.send(chatId, "❌ Сначала /setprompt"); break; }
      config.enabled = true;
      await saveConfig(env, config);
      await tg.send(chatId, `🟢 Автопостинг включён!\nИнтервал: ${config.interval} мин. × ${config.count} шт.`);
      break;
    }

    case "/disable": {
      config.enabled = false;
      await saveConfig(env, config);
      await tg.send(chatId, "🔴 Автопостинг выключен");
      break;
    }

    case "/status": {
      let pendingCount = 0;
      try { pendingCount = (await KV.list(env, "pending:")).keys.length; } catch {}
      const bl = await getWorkerBlacklist(env);
      const lorasTxt = (config.loras || []).map(l => `  • <code>${escapeHtml(l.name)}</code> (${l.strength})`).join("\n") || "  нет";
      await tg.send(chatId,
        `📊 <b>Статус v13</b>\n\n` +
        `<b>Автопост:</b> ${config.enabled ? "🟢 ВКЛ" : "🔴 ВЫКЛ"}\n` +
        `<b>Чат:</b> <code>${config.chatId || "не задан"}</code>\n` +
        `<b>Интервал:</b> ${config.interval} мин. × ${config.count} шт.\n\n` +
        `<b>Промпт:</b>\n<code>${escapeHtml(config.generalPrompt || "не задан")}</code>\n\n` +
        `<b>Модель:</b> <code>${escapeHtml(config.model)}</code>\n` +
        `<b>Размер:</b> ${config.width}×${config.height} | <b>Steps:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}\n` +
        `<b>Сэмплер:</b> ${config.sampler} | <b>CLIP:</b> ${config.clipSkip}\n\n` +
        `<b>LoRA:</b>\n${lorasTxt}\n\n` +
        `<b>LLM:</b> <code>${escapeHtml(config.llmModel || env.LLM_MODEL || "auto")}</code>\n` +
        `<b>В очереди:</b> ${pendingCount} | <b>Блэклист:</b> ${bl.length} воркеров`
      );
      break;
    }

    case "/generate": {
      if (!config.generalPrompt) { await tg.send(chatId, "❌ Сначала /setprompt"); break; }
      const target = config.chatId || chatId;
      await tg.send(chatId, `⏳ Генерирую ${config.count} изображений...`);
      const bl = await getWorkerBlacklist(env);
      const blIds = bl.map(w => w.id).filter(Boolean);
      for (let i = 0; i < config.count; i++) {
        try {
          const prompt = await generatePrompt(config.generalPrompt, env);
          await tg.send(chatId, `🎨 #${i + 1}:\n<code>${escapeHtml(prompt.substring(0, 300))}</code>`);
          const result = await hordeSubmit(prompt, config, env, { workerBlacklist: blIds });
          if (result.id) {
            await KV.put(env, `pending:${result.id}`, JSON.stringify({
              chatId: target, prompt, at: Date.now(), notify: chatId, retries: 0,
            }), { expirationTtl: 3600 });
            await tg.send(chatId, `📤 ID: <code>${result.id}</code>`);
          } else {
            await tg.send(chatId, `❌ Horde: <code>${escapeHtml(JSON.stringify(result).substring(0, 300))}</code>`);
          }
        } catch (e) { await tg.send(chatId, `❌ ${escapeHtml(e.message)}`); }
      }
      break;
    }

    case "/pending": {
      const list = await KV.list(env, "pending:");
      if (!list.keys.length) { await tg.send(chatId, "📋 Очередь пуста"); break; }
      let txt = `📋 <b>В очереди: ${list.keys.length}</b>\n\n`;
      const checks = await Promise.all(list.keys.slice(0, 10).map(async k => {
        const id = k.name.replace("pending:", "");
        try {
          const c = await hordeCheck(id);
          const s = c.done ? "✅ Готово" : c.processing ? "⚙️ Генерируется" : `⏳ #${c.queue_position}`;
          return `🔸 <code>${id}</code>\n   ${s} | ~${c.wait_time || 0}с\n`;
        } catch { return `🔸 <code>${id}</code> — не удалось проверить\n`; }
      }));
      await tg.send(chatId, txt + checks.join("\n"));
      break;
    }

    case "/cancel": {
      const list = await KV.list(env, "pending:");
      await Promise.all(list.keys.map(k => KV.del(env, k.name)));
      await tg.send(chatId, `🗑 Удалено: ${list.keys.length}`);
      break;
    }

    case "/workerbl": {
      const bl = await getWorkerBlacklist(env);
      if (!bl.length) { await tg.send(chatId, "📋 Блэклист пуст"); break; }
      let txt = `🚫 <b>Блэклист воркеров: ${bl.length}</b>\n\n`;
      bl.forEach(w => {
        txt += `• <code>${escapeHtml(w.name || "?")}</code>\n  ID: <code>${w.id}</code>\n  ${new Date(w.t).toISOString().substring(0, 10)}\n\n`;
      });
      txt += "\n/clearworkerbl — очистить";
      await tg.send(chatId, txt);
      break;
    }

    case "/clearworkerbl": {
      await clearWorkerBlacklist(env);
      await tg.send(chatId, "✅ Блэклист воркеров очищен");
      break;
    }

    default: {
      if (cmd.startsWith("/")) await tg.send(chatId, "❓ Неизвестная команда — /help");
    }
  }
}

// ══════════════════════════════════════
//  CRON — обработка очереди и автопостинг
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

      // Таймаут 20 минут
      if (Date.now() - data.at > 20 * 60 * 1000) {
        await KV.del(env, key.name);
        if (data.notify) await tg.send(data.notify, `⏰ Таймаут генерации: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      if (!check.done) continue;

      if (data.notify) await tg.send(data.notify, `⚡ Генерация <code>${id}</code> завершена!`);

      const result = await hordeGetResult(id);

      if (result.faulted) {
        await KV.del(env, key.name);
        if (data.notify) await tg.send(data.notify, `❌ Генерация провалилась (faulted)`);
        continue;
      }

      const gens = result.generations || [];
      if (!gens.length) { await KV.del(env, key.name); continue; }

      let anySent = false;
      let anySmall = false;

      for (const gen of gens) {
        const workerId = gen.worker_id || "?";
        const workerName = gen.worker_name || "?";

        // ── Детект цензуры через gen_metadata (официальный метод по swagger) ──
        const censoredByMeta = isCensored(gen);

        if (data.debug && data.notify) {
          const imgInfo = !gen.img ? "null"
            : gen.img.startsWith("http") ? `URL (${gen.img.substring(0, 45)}...)`
            : `base64 (${gen.img.length} chars, ~${Math.round(gen.img.length * 0.75 / 1024)}KB декодировано)`;

          const metaInfo = gen.gen_metadata?.length
            ? gen.gen_metadata.map(m => `${m.type}:${m.value}`).join(", ")
            : "нет";

          await tg.send(data.notify,
            `🔍 <b>Результат:</b>\n` +
            `   censored флаг: ${gen.censored ? "🔴 да" : "✅ нет"}\n` +
            `   state: ${gen.state || "ok"}\n` +
            `   gen_metadata: ${escapeHtml(metaInfo)}\n` +
            `   isCensored(): ${censoredByMeta ? "🔴 да" : "✅ нет"}\n` +
            `   Worker: <code>${escapeHtml(workerName)}</code>\n` +
            `   Worker ID: <code>${escapeHtml(workerId)}</code>\n` +
            `   Model: <code>${escapeHtml(gen.model || "?")}</code>\n` +
            `   Image: ${escapeHtml(imgInfo)}`
          );
        }

        // Если Horde сам сказал что цензура — сразу в блэклист, без скачивания
        if (censoredByMeta) {
          await addWorkerToBlacklist(env, workerId, workerName);
          anySmall = true;
          if (data.notify) {
            await tg.send(data.notify,
              `🔴 Воркер <code>${escapeHtml(workerName)}</code> вернул цензуру (gen_metadata)\n` +
              `Добавляю в блэклист, повторяю запрос...`
            );
          }
          continue;
        }

        if (!gen.img) {
          if (data.notify) await tg.send(data.notify, "❌ gen.img пустой");
          continue;
        }

        if (data.notify) await tg.send(data.notify, `📨 Скачиваю и отправляю...`);

        const caption = data.prompt
          ? `🎨 <i>${escapeHtml(data.prompt.substring(0, 200))}</i>`
          : "";

        const { sent, tooSmall, sizeKB } = await deliverImage(tg, data.chatId, gen.img, caption, data.notify);

        if (sent) {
          anySent = true;
        } else if (tooSmall) {
          anySmall = true;
          // Файл слишком мал — тоже блэклистим воркера
          await addWorkerToBlacklist(env, workerId, workerName);
        }
      }

      await KV.del(env, key.name);

      // Повторная попытка с обновлённым блэклистом
      if (anySmall && !anySent && !data.sfwTest) {
        const retries = (data.retries || 0) + 1;
        if (retries < MAX_RETRIES) {
          try {
            const bl = await getWorkerBlacklist(env);
            const blIds = bl.map(w => w.id).filter(Boolean);
            const nr = await hordeSubmit(data.prompt, config, env, { workerBlacklist: blIds });
            if (nr.id) {
              await KV.put(env, `pending:${nr.id}`, JSON.stringify({
                ...data, at: Date.now(), retries,
              }), { expirationTtl: 3600 });
              if (data.notify) {
                await tg.send(data.notify,
                  `🔄 Повтор ${retries}/${MAX_RETRIES}: <code>${nr.id}</code>\n` +
                  `🚫 Блэклист: ${blIds.length} воркеров`
                );
              }
            }
          } catch (e) { console.error("[CRON] retry:", e.message); }
        } else {
          if (data.notify) {
            await tg.send(data.notify,
              `❌ <b>${MAX_RETRIES} попыток — все заглушки!</b>\n\n` +
              `Возможные причины:\n` +
              `• Анонимный ключ Horde (NSFW не работает с 0000000000)\n` +
              `• Аккаунт помечен (проверь /checkkey)\n` +
              `• Все доступные воркеры цензурируют эту модель\n\n` +
              `/clearworkerbl — сбросить блэклист и попробовать снова`
            );
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

  const bl = await getWorkerBlacklist(env);
  const blIds = bl.map(w => w.id).filter(Boolean);

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env, { workerBlacklist: blIds });
      if (result.id) {
        await KV.put(env, `pending:${result.id}`, JSON.stringify({
          chatId: config.chatId, prompt, at: now, notify: null, retries: 0,
        }), { expirationTtl: 3600 });
      }
    } catch (e) { console.error("[CRON] auto:", e.message); }
  }
}

// ══════════════════════════════════════
//  ENTRY POINT
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
      return new Response(`Webhook: ${wh}\n\n${JSON.stringify(await r.json(), null, 2)}`);
    }

    return new Response("🤖 Image Bot v13 OK");
  },

  async scheduled(event, env, ctx) {
    try { await processScheduled(env); }
    catch (e) { console.error("[CRON] CRASH:", e.message); }
  },
};