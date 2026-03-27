
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
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "",
  clipSkip: 2,
  hiresFix: false,
  hiresFixDenoising: 0.65,
  karras: true,
  postProcessing: [],
  captionMode: 0,
  captionInstruction: "Напиши короткое, красивое и поэтичное описание к этому изображению на русском языке. Максимум 180 символов. Добавь 1-2 эмодзи. Стиль: вдохновляющий пост в Telegram-канале.",
  channelId: null
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:14.0:tg" };
const MIN_IMAGE_KB = 10;

function escapeHtml(e) {
  return null == e ? "" : String(e).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clamp(e, t, a) {
  return Math.max(t, Math.min(a, e));
}

function isHttpUrl(e) {
  return "string" == typeof e && /^https?:\/\//i.test(e);
}

class Telegram {
  constructor(e) {
    this.base = `https://api.telegram.org/bot${e}`;
  }
  async api(e, t) {
    const a = await fetch(`${this.base}/${e}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) });
    const n = await a.json();
    return n.ok || console.error(`[TG] ${e}:`, JSON.stringify(n).substring(0, 400)), n;
  }
  send(e, t, a = {}) {
    return this.api("sendMessage", { chat_id: e, text: t, parse_mode: "HTML", ...a });
  }
  async sendPhoto(e, t, a = "") {
    const n = new FormData();
    n.append("chat_id", String(e));
    n.append("photo", new File([t], "image.webp", { type: "image/webp" }));
    if (a) {
      n.append("caption", a.substring(0, 1024));
      n.append("parse_mode", "HTML");
    }
    return (await fetch(`${this.base}/sendPhoto`, { method: "POST", body: n })).json();
  }
  async sendDocument(e, t, a = "") {
    const n = new FormData();
    n.append("chat_id", String(e));
    n.append("document", new File([t], "image.webp", { type: "image/webp" }));
    if (a) {
      n.append("caption", a.substring(0, 1024));
      n.append("parse_mode", "HTML");
    }
    return (await fetch(`${this.base}/sendDocument`, { method: "POST", body: n })).json();
  }
  sendPhotoUrl(e, t, a = "") {
    return this.api("sendPhoto", { chat_id: e, photo: t, caption: a.substring(0, 1024), parse_mode: "HTML" });
  }
}

const KV = {
  async command(e, t) {
    const a = e.UPSTASH_REDIS_REST_URL;
    const n = e.UPSTASH_REDIS_REST_TOKEN;
    if (!a || !n) return console.error("[REDIS] Нет UPSTASH_REDIS_REST_URL / TOKEN"), null;
    const s = await fetch(a, {
      method: "POST",
      headers: { Authorization: `Bearer ${n}`, "Content-Type": "application/json" },
      body: JSON.stringify(t)
    });
    if (!s.ok) return console.error(`[REDIS] HTTP ${s.status}`), null;
    const r = await s.json();
    return r.error ? (console.error("[REDIS] Error:", r.error), null) : r.result;
  },
  async get(e, t, a = "text") {
    const n = await this.command(e, ["GET", t]);
    if (null == n) return null;
    if ("json" === a) try { return JSON.parse(n); } catch { return null; }
    return n;
  },
  async put(e, t, a, n = {}) {
    let s = ["SET", t];
    "string" != typeof a && (a = JSON.stringify(a));
    s.push(a);
    if (n.expirationTtl) s.push("EX", n.expirationTtl);
    await this.command(e, s);
  },
  async del(e, t) {
    await this.command(e, ["DEL", t]);
  },
  list: async (e, t) => {
    const a = await this.command(e, ["KEYS", `${t}*`]) || [];
    return { keys: a.map(e => ({ name: e })) };
  }
};

async function getConfig(e) {
  const t = await KV.get(e, "config", "json");
  return { ...DEFAULT_CONFIG, ...t || {} };
}

async function saveConfig(e, t) {
  await KV.put(e, "config", JSON.stringify(t));
}

async function getWorkerBlacklist(e) {
  return await KV.get(e, "worker_blacklist", "json") || [];
}

async function addWorkerToBlacklist(e, t, a) {
  if (!t || "?" === t || String(t).length < 10) return;
  const n = await getWorkerBlacklist(e);
  if (!n.find(e => e.id === t)) {
    n.push({ id: t, name: a || "?", t: Date.now() });
    while (n.length > 30) n.shift();
    await KV.put(e, "worker_blacklist", JSON.stringify(n));
  }
}

async function clearWorkerBlacklist(e) {
  await KV.put(e, "worker_blacklist", "[]");
}

function isCensored(e) {
  return !( !e || !e.gen_metadata?.some(e => "censorship" === e.type) && !0 !== e.censored && "censored" !== e.state );
}

function getApiKey(e) {
  return (e.HORDE_API_KEY || "").trim() || "0000000000";
}

async function hordeCheckKey(e) {
  const t = getApiKey(e);
  try {
    const e = await fetch(`${HORDE_API}/find_user`, { headers: { apikey: t, ...HORDE_HEADERS } });
    if (401 === e.status || 403 === e.status) return { ok: false, anon: "0000000000" === t };
    const a = await e.json();
    return { ok: true, anon: "0000000000" === t, user: a.username, kudos: a.kudos, trusted: a.trusted, flagged: a.flagged };
  } catch (e) {
    return { ok: false, anon: "0000000000" === t, err: e.message };
  }
}

async function hordeSubmit(e, t, a, n = {}) {
  const s = getApiKey(a);
  const o = {
    sampler_name: t.sampler,
    cfg_scale: t.cfgScale,
    width: t.width,
    height: t.height,
    steps: t.steps,
    karras: !1 !== t.karras,
    clip_skip: t.clipSkip || 2,
    tiling: false,
    post_processing: t.postProcessing || [],
    n: 1
  };
  if (t.hiresFix) {
    o.hires_fix = true;
    o.hires_fix_denoising_strength = t.hiresFixDenoising || 0.65;
  }
  if (!n.skipLoras && t.loras?.length > 0) {
    o.loras = t.loras.map(e => ({ name: String(e.name), model: e.strength ?? 1, clip: e.clip ?? 1, inject_trigger: "any", is_version: true }));
  }
  const i = {
    prompt: t.negativePrompt ? `${e} ### ${t.negativePrompt}` : e,
    params: o,
    nsfw: true,
    censor_nsfw: false,
    trusted_workers: false,
    replacement_filter: true,
    models: [t.model],
    r2: true,
    shared: false,
    allow_downgrade: true
  };
  if (n.workerBlacklist?.length > 0) {
    i.workers = n.workerBlacklist.slice(0, 5);
    i.worker_blacklist = true;
  }
  return (await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: s, ...HORDE_HEADERS },
    body: JSON.stringify(i)
  })).json();
}

async function hordeCheck(e) {
  return (await fetch(`${HORDE_API}/generate/check/${e}`, { headers: HORDE_HEADERS })).json();
}

async function hordeGetResult(e) {
  return (await fetch(`${HORDE_API}/generate/status/${e}`, { headers: HORDE_HEADERS })).json();
}

async function hordeGetModels() {
  return (await fetch(`${HORDE_API}/status/models?type=image`, { headers: HORDE_HEADERS })).json();
}

async function downloadImage(e) {
  try {
    const t = await fetch(e);
    return t.ok ? await t.arrayBuffer() : null;
  } catch (e) {
    return console.error("[IMG] Fetch error:", e.message), null;
  }
}

function base64ToBuffer(e) {
  try {
    const t = atob(e);
    const a = new Uint8Array(t.length);
    for (let e = 0; e < t.length; e++) a[e] = t.charCodeAt(e);
    return a.buffer;
  } catch (e) {
    return console.error("[IMG] Base64 decode error:", e.message), null;
  }
}

function bufferSizeKB(e) {
  return Math.round(e.byteLength / 1024);
}

async function deliverImage(e, t, a, n, s) {
  if (!a) return s && await e.send(s, "❌ Нет данных картинки от воркера"), { sent: false, tooSmall: false, sizeKB: 0 };
  const o = isHttpUrl(a);
  let i = null;
  if (o) {
    if (i = await downloadImage(a), !i) return (await e.sendPhotoUrl(t, a, n)).ok ? { sent: true, tooSmall: false, sizeKB: 0 } : { sent: false, tooSmall: false, sizeKB: 0 };
  } else if (i = base64ToBuffer(a), !i) return { sent: false, tooSmall: false, sizeKB: 0 };
  const r = bufferSizeKB(i);
  if (r < 10) return s && await e.send(s, `🚫 <b>Похоже на заглушку/цензуру</b>\nРазмер: ${r}KB (норма > 10KB)`), { sent: false, tooSmall: true, sizeKB: r };
  let c = await e.sendPhoto(t, i, n);
  return c.ok ? { sent: true, tooSmall: false, sizeKB: r } : (console.log("[IMG] sendPhoto failed, trying sendDocument:", c.description), c = await e.sendDocument(t, i, n), c.ok || o && (await e.sendPhotoUrl(t, a, n)).ok ? { sent: true, tooSmall: false, sizeKB: r } : (s && await e.send(s, `❌ Не удалось отправить изображение: ${escapeHtml(c.description || "unknown error")}`), { sent: false, tooSmall: false, sizeKB: r }));
}

const P = {
  angle: ["from above", "low angle", "eye level", "dutch angle", "bird's eye view", "extreme close-up", "wide establishing shot", "portrait framing", "three-quarter view", "profile view", "from behind", "over the shoulder"],
  light: ["golden hour sunlight", "blue hour twilight", "dramatic chiaroscuro", "soft overcast light", "neon cyberpunk glow", "moonlit night", "studio rim lighting", "dappled forest light", "harsh midday shadows", "candlelit ambiance", "volumetric god rays", "backlit silhouette"],
  style: ["photorealistic photography", "digital concept art", "oil painting", "watercolor washes", "anime cel shading", "dark fantasy illustration", "hyperrealistic 8k render", "film noir", "surrealist dreamlike", "pop art", "renaissance painting", "vaporwave aesthetic"],
  mood: ["serene and peaceful", "intense and dramatic", "mysterious and enigmatic", "vibrant and energetic", "ethereal and dreamlike", "dark and brooding", "warm and intimate", "epic and grandiose", "melancholic and wistful", "playful and whimsical"],
  detail: ["intricate filigree details", "rough textured surfaces", "smooth polished finish", "ornate decoration", "minimalist clean lines", "weathered aged patina", "crystalline sharp focus", "beautiful bokeh", "particle effects", "reflections and refractions"]
};

function pick(e) {
  return e[Math.floor(Math.random() * e.length)];
}

function pickN(e, t) {
  return [...e].sort(() => Math.random() - 0.5).slice(0, t);
}

function templatePrompt(e) {
  return [e, pick(P.angle), pick(P.light), pick(P.style), pick(P.mood), ...pickN(P.detail, 2), "masterpiece", "best quality", "highly detailed"].join(", ");
}

async function llmPrompt(e, t, a) {
  const n = ["Focus on unusual creative perspective", "Emphasize dramatic lighting and deep shadows", "Place subject in unexpected environment", "Focus on intricate textures and micro-details", "Use bold unconventional color palette", "Capture dynamic motion and energy", "Create contemplative atmospheric scene", "Use extreme framing — very close or very wide", "Create cinematic movie composition", "Add weather effects — rain, snow, fog", "Focus on reflections and mirror surfaces", "Give it futuristic sci-fi aesthetic"];
  try {
    const s = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}`, "HTTP-Referer": "https://t.me", "X-Title": "TgImageBot" },
      body: JSON.stringify({
        model: a || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          { role: "system", content: `You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations, no quotes, no markdown. Under 100 words. Be creative and unique. Direction: ${pick(n)}. If the user request contains instructions in [square brackets], incorporate them creatively into the prompt as specific style or content directives.` },
          { role: "user", content: `Create a unique detailed image generation prompt for: ${e}` }
        ],
        temperature: 1.3,
        max_tokens: 200
      })
    });
    const o = await s.json();
    const i = o.choices?.[0]?.message?.content?.trim().replace(/^["'`*]+|["'`*]+$/g, "");
    if (i?.length > 10) return i;
  } catch (e) {
    console.error("[LLM]", e.message);
  }
  return templatePrompt(e);
}

async function generatePrompt(e, t) {
  if (t.OPENROUTER_API_KEY) {
    const a = await getConfig(t);
    return llmPrompt(e, t.OPENROUTER_API_KEY, a.llmModel || t.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free");
  }
  return templatePrompt(e);
}

async function generateAICaption(e, t, a) {
  if (!a.OPENROUTER_API_KEY || !e) return e ? `🎨 <i>${escapeHtml(e.substring(0, 200))}</i>` : "";
  const n = t.llmModel || a.LLM_MODEL || "google/gemma-2-9b-it:free";
  try {
    const s = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.OPENROUTER_API_KEY}`, "HTTP-Referer": "https://t.me", "X-Title": "TgImageBot" },
      body: JSON.stringify({
        model: n,
        messages: [
          { role: "system", content: t.captionInstruction || DEFAULT_CONFIG.captionInstruction },
          { role: "user", content: `Промпт изображения: ${e}\n\nНапиши подпись:` }
        ],
        temperature: 0.9,
        max_tokens: 150
      })
    });
    const o = await s.json();
    const i = o.choices?.[0]?.message?.content?.trim();
    if (i?.length > 10) return i;
  } catch (e) {
    console.error("[CAPTION LLM]", e.message);
  }
  return e ? `🎨 <i>${escapeHtml(e.substring(0, 200))}</i>` : "";
}

async function getSendCaption(e, t, a) {
  switch (t.captionMode) {
    case 0: return "";
    case 1: return e ? `🎨 <i>${escapeHtml(e.substring(0, 300))}</i>` : "";
    case 2: return await generateAICaption(e, t, a);
    default: return "";
  }
}

async function getStatusResponse(e, t) {
  let a = 0;
  try { a = (await KV.list(t, "pending:")).keys.length; } catch {}
  const n = await getWorkerBlacklist(t);
  const s = (e.loras || []).map(e => `  • <code>${escapeHtml(e.name)}</code> (${e.strength})`).join("\n") || "  none";
  const r = `📊 <b>Status</b>\n\n<b>Autopost:</b> ${e.enabled ? "🟢 ON" : "🔴 OFF"}\n<b>Chat (группа):</b> <code>${e.chatId || "—"}</code>\n<b>Channel:</b> <code>${e.channelId || "—"}</code>\n<b>Interval:</b> ${e.interval} min.\n<b>Count:</b> ${e.count}\n\n<b>Prompt:</b>\n<code>${escapeHtml(e.generalPrompt || "—")}</code>\n\n<b>Model:</b> <code>${escapeHtml(e.model)}</code>\n<b>Size:</b> ${e.width}×${e.height}\n<b>Steps:</b> ${e.steps} | <b>CFG:</b> ${e.cfgScale}\n<b>Sampler:</b> ${e.sampler}\n<b>CLIP Skip:</b> ${e.clipSkip || 1}\n<b>NSFW:</b> ${e.nsfw ? "🔞 yes" : "no"}\n<b>Post-processing:</b> ${e.postProcessing?.length ? e.postProcessing.join(", ") : "нет"}\n\n<b>Negative:</b>\n<code>${escapeHtml(e.negativePrompt)}</code>\n\n<b>LoRA:</b>\n${s}\n\n<b>Caption mode:</b> ${["Нет подписи", "Только промпт", "🤖 AI-генерация"][e.captionMode || 0]}\n<b>LLM:</b> <code>${escapeHtml(e.llmModel || t.LLM_MODEL || "auto")}</code>\n<b>Queue:</b> ${a}\n<b>Blacklist:</b> ${n.length} workers`;
  return { text: r, keyboard: { inline_keyboard: [[{ text: e.enabled ? "🔴 Отключить автопост" : "🟢 Включить автопост", callback_data: "toggle:enabled" }], [{ text: "📝 Промпт", callback_data: "hint:setprompt" }, { text: "🎨 Модель / LoRA", callback_data: "hint:setmodel" }], [{ text: "🔄 Обновить статус", callback_data: "refresh:status" }]] } };
}

async function handleCallback(e, t) {
  if (!t.TELEGRAM_BOT_TOKEN) return;
  const a = new Telegram(t.TELEGRAM_BOT_TOKEN);
  try { await a.api("answerCallbackQuery", { callback_query_id: e.id }); } catch {}
  const n = e.data || "";
  const s = e.message?.chat?.id;
  const r = e.message?.message_id;
  if (!s || !r) return;
  let o = await getConfig(t);
  if (o.adminId !== e.from?.id) return void await a.api("answerCallbackQuery", { callback_query_id: e.id, text: "🔒 Только для админа", show_alert: true });
  if ("toggle:enabled" === n) {
    o.enabled = !o.enabled;
    await saveConfig(t, o);
    const { text: e, keyboard: n } = await getStatusResponse(o, t);
    await a.api("editMessageText", { chat_id: s, message_id: r, text: e, parse_mode: "HTML", reply_markup: n });
  } else if ("refresh:status" === n) {
    const { text: e, keyboard: n } = await getStatusResponse(o, t);
    await a.api("editMessageText", { chat_id: s, message_id: r, text: e, parse_mode: "HTML", reply_markup: n });
  } else if (n.startsWith("hint:")) {
    const t = n.split(":")[1];
    const o = "setprompt" === t ? "Отправь /setprompt <новый текст темы>" : "setmodel" === t ? "Отправь /setmodel <имя модели> или /listmodels" : "Неизвестная подсказка";
    await a.send(s, `💡 ${o}`);
  }
}

async function handleCommand(e, t) {
  const a = e.chat.id;
  const n = e.from?.id;
  const s = e.text || "";
  if (!t.TELEGRAM_BOT_TOKEN) return;
  const o = new Telegram(t.TELEGRAM_BOT_TOKEN);
  const i = s.split(/\s+/);
  const r = i[0].split("@")[0].toLowerCase();
  const c = i.slice(1);
  if ("/ping" === r) {
    const e = getApiKey(t);
    return void await o.send(a, `🏓 <b>Pong!</b>\n\n📍 Chat: <code>${a}</code>\n👤 User: <code>${n}</code>\n💾 Redis: ${t.UPSTASH_REDIS_REST_URL ? "✅" : "❌"}\n🎨 Horde: ${"0000000000" === e ? "🔴 anonymous (NSFW will not work)" : "✅ " + e.substring(0, 8) + "..."}\n🤖 OpenRouter: ` + (t.OPENROUTER_API_KEY ? "✅" : "⚠️ templates"));
  }
  if ("/diagnostic" === r) {
    const e = getApiKey(t);
    const n = await getWorkerBlacklist(t);
    return void await o.send(a, `🔧 <b>Diagnostics</b>\n\n💾 Redis: ${t.UPSTASH_REDIS_REST_URL ? "✅" : "❌"}\n🔑 Horde key: ${"0000000000" === e ? "🔴 anonymous" : "✅ " + e.substring(0, 8) + "..."}\n🤖 OpenRouter: ${t.OPENROUTER_API_KEY ? "✅" : "⚠️"}\n\n<b>Request flags:</b>\n  nsfw: true\n  censor_nsfw: false\n  trusted_workers: false\n  replacement_filter: true\n  r2: true\n  allow_downgrade: true\n\n🚫 Blacklisted workers: <b>${n.length}</b>\n📏 Min image size: 10KB\n\n<b>Censorship detection:</b>\n  1. gen_metadata[].type=="censorship"\n  2. gen.censored === true\n  3. gen.state === "censored"\n  4. size < 10KB`);
  }
  if ("/checkkey" === r) {
    await o.send(a, "🔑 Checking Horde key...");
    const e = await hordeCheckKey(t);
    if (!e.ok) return void await o.send(a, `❌ <b>Invalid key</b>\n${escapeHtml(e.err || "")}`);
    const n = e.anon ? "🔴 <b>Anonymous key</b>\nNSFW will not work.\nRegister at stablehorde.net." : e.flagged ? "⚠️ Account flagged — censorship may happen" : "✅ Key looks fine, NSFW should work";
    return void await o.send(a, `${e.anon ? "🔴" : "✅"} <b>${escapeHtml(e.user || "anonymous")}</b>\n\n💎 Kudos: ${e.kudos || 0}\n🛡 Trusted: ${e.trusted ? "yes" : "no"}\n🚩 Flagged: ${e.flagged ? "yes" : "no"}\n\n` + n);
  }
  if ("/testimg" === r) {
    await o.send(a, "🧪 Testing image sending...");
    const e = await o.sendPhotoUrl(a, "https://picsum.photos/512/512", "URL test");
    await o.send(a, e.ok ? "✅ URL photo works" : `❌ URL test failed: ${escapeHtml(e.description || "")}`);
    try {
      const e = await fetch("https://picsum.photos/256/256");
      const t = await e.arrayBuffer();
      const n = await o.sendPhoto(a, t, "Buffer test");
      await o.send(a, n.ok ? "✅ Buffer photo works" : `❌ Buffer test failed: ${escapeHtml(n.description || "")}`);
    } catch (e) {
      await o.send(a, `❌ ${escapeHtml(e.message)}`);
    }
    return;
  }
  if ("/testsfw" === r) {
    if (!t.UPSTASH_REDIS_REST_URL) return void await o.send(a, "❌ Upstash Redis не настроен!");
    const e = await getConfig(t);
    const n = "beautiful mountain landscape, crystal clear lake, sunset sky, orange and pink clouds, pine trees, snow capped peaks, nature photography, 4k, masterpiece, best quality, highly detailed, sharp focus";
    await o.send(a, "🧪 Sending SFW test generation to Horde...");
    try {
      const s = await hordeSubmit(n, e, t, { skipLoras: true });
      if (s.id) {
        await KV.put(t, `pending:${s.id}`, JSON.stringify({ chatId: a, prompt: n, at: Date.now(), notify: a, debug: true, retries: 99, sfwTest: true }), { expirationTtl: 3600 });
        await o.send(a, `📤 ID: <code>${s.id}</code>\n⏳ Wait for cron...`);
      } else await o.send(a, `❌ Horde: <code>${escapeHtml(JSON.stringify(s).substring(0, 400))}</code>`);
    } catch (e) {
      await o.send(a, `❌ ${escapeHtml(e.message)}`);
    }
    return;
  }
  if (!t.UPSTASH_REDIS_REST_URL) return void await o.send(a, "❌ Upstash Redis не настроен! Используй /diagnostic");
  let l = await getConfig(t);
  if (!l.adminId) {
    l.adminId = n;
    await saveConfig(t, l);
    await o.send(a, `👑 You are admin. ID: <code>${n}</code>`);
  }
  if (l.adminId === n) {
    switch (r) {
      case "/start":
      case "/help":
        await o.send(a, "🤖 <b>Image Bot</b>\n\n<b>Basics:</b>\n/setchat — set post chat\n/setprompt &lt;text&gt; — main theme\n/setinterval &lt;min&gt; — interval\n/setcount &lt;1-10&gt; — amount\n/enable | /disable — auto mode\n/generate — generate now\n\n<b>Model and LoRA:</b>\n/setmodel &lt;name&gt;\n/listmodels — top-40 models\n/searchlora &lt;query&gt;\n/addlora &lt;version_id&gt; [strength] [clip]\n/removelora &lt;id&gt; | /listloras\n\n<b>Params:</b>\n/setsize &lt;W&gt; &lt;H&gt; | /setsteps &lt;N&gt;\n/setcfg &lt;N&gt; | /setsampler &lt;name&gt;\n/setneg &lt;text&gt; | /setclipskip &lt;1-4&gt;\n/setllm &lt;model_id&gt;\n\n<b>Autopost captions + channel:</b>\n/setcaption none | prompt | ai\n/setcaptioninstr &lt;инструкция ИИ&gt;\n/setchannel &lt;@канал или ID&gt;\n/unsetchannel\n\n<b>Horde улучшайзеры (лица и т.д.):</b>\n/addpostproc GFPGAN\n/removepostproc GFPGAN\n/listpostproc\n\n<b>Management:</b>\n/status | /pending | /cancel\n/workerbl | /clearworkerbl\n/checkkey | /diagnostic | /testsfw | /testimg\n\nИспользуй /status — там удобные кнопки!");
        break;
      case "/setchat":
        l.chatId = a;
        await saveConfig(t, l);
        await o.send(a, `✅ Post chat set: <code>${a}</code>`);
        break;
      case "/setprompt":
        const e = c.join(" ");
        if (!e) { await o.send(a, "❌ /setprompt &lt;theme&gt;"); break; }
        l.generalPrompt = e;
        await saveConfig(t, l);
        await o.send(a, `✅ Prompt:\n<code>${escapeHtml(e)}</code>`);
        break;
      case "/setinterval":
        const e = parseInt(c[0], 10);
        if (Number.isNaN(e) || e < 1) { await o.send(a, "❌ /setinterval &lt;minutes&gt; (min 1)"); break; }
        l.interval = e;
        await saveConfig(t, l);
        await o.send(a, `✅ Interval: ${e} min`);
        break;
      case "/setcount":
        const e = parseInt(c[0], 10);
        if (Number.isNaN(e) || e < 1 || e > 10) { await o.send(a, "❌ /setcount &lt;1-10&gt;"); break; }
        l.count = e;
        await saveConfig(t, l);
        await o.send(a, `✅ Count: ${e}`);
        break;
      case "/setmodel":
        const e = c.join(" ");
        if (!e) { await o.send(a, "❌ /setmodel &lt;name&gt;\nUse /listmodels"); break; }
        l.model = e;
        await saveConfig(t, l);
        await o.send(a, `✅ Model: <code>${escapeHtml(e)}</code>`);
        break;
      case "/listmodels":
        await o.send(a, "⏳ Loading model list...");
        try {
          const e = await hordeGetModels();
          const t = (Array.isArray(e) ? e : []).filter(e => e.count > 0).sort((e, t) => t.count - e.count).slice(0, 40);
          let n = "📋 <b>Models (top-40 by workers):</b>\n\n";
          for (const e of t) n += `${e.name?.includes("XL") || e.name?.includes("SDXL") ? "🟢" : "⚪"} <code>${escapeHtml(e.name || "?")}</code> (${e.count}w)\n`;
          n += "\n🟢 = SDXL  ⚪ = SD1.5\nCopy name: /setmodel &lt;name&gt;";
          await o.send(a, n);
        } catch (e) {
          await o.send(a, `❌ ${escapeHtml(e.message)}`);
        }
        break;
      case "/searchlora":
        const e = c.join(" ");
        if (!e) { await o.send(a, "❌ /searchlora &lt;query in English&gt;"); break; }
        await o.send(a, "🔍 Searching CivitAI...");
        try {
          const t = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(e)}&limit=10&sort=Highest%20Rated&nsfw=true`;
          const n = await (await fetch(t)).json();
          if (!n.items?.length) { await o.send(a, "😕 Nothing found"); break; }
          let s = `🔍 <b>LoRA: "${escapeHtml(e)}"</b>\n\n`;
          for (const e of n.items.slice(0, 10)) {
            const t = e.modelVersions?.[0];
            const a = t?.id || "?";
            s += `${e.nsfw ? "🔞" : "✅"} <b>${escapeHtml(e.name)}</b> [${escapeHtml(t?.baseModel || "?")}]\n`;
            s += `   ➕ <code>/addlora ${a} 0.8</code>\n\n`;
          }
          await o.send(a, s);
        } catch (e) {
          await o.send(a, `❌ ${escapeHtml(e.message)}`);
        }
        break;
      case "/addlora":
        const e = c[0];
        const n = parseFloat(c[1]) || 0.8;
        const s = parseFloat(c[2]) || 1;
        if (!e) { await o.send(a, "❌ /addlora &lt;civitai_version_id&gt; [strength=0.8] [clip=1]"); break; }
        l.loras = (l.loras || []).filter(t => String(t.name) !== String(e));
        l.loras.push({ name: e, strength: n, clip: s });
        await saveConfig(t, l);
        await o.send(a, `✅ LoRA <code>${escapeHtml(e)}</code> (strength: ${n}, clip: ${s})`);
        break;
      case "/removelora":
        const e = c[0];
        if (!e) { await o.send(a, "❌ /removelora &lt;id&gt;"); break; }
        l.loras = (l.loras || []).filter(t => String(t.name) !== String(e));
        await saveConfig(t, l);
        await o.send(a, `✅ LoRA <code>${escapeHtml(e)}</code> removed`);
        break;
      case "/listloras":
        const e = l.loras || [];
        if (!e.length) { await o.send(a, "📋 No LoRA yet. Use /searchlora"); break; }
        let t = "📋 <b>Your LoRA:</b>\n\n";
        e.forEach((e, a) => { t += `${a + 1}. <code>${escapeHtml(e.name)}</code> (str: ${e.strength}, clip: ${e.clip})\n   ❌ /removelora ${escapeHtml(e.name)}\n\n`; });
        await o.send(a, t);
        break;
      case "/setsize":
        let e = parseInt(c[0], 10);
        let n = parseInt(c[1], 10);
        if (Number.isNaN(e) || Number.isNaN(n) || e < 256 || n < 256 || e > 2048 || n > 2048) {
          await o.send(a, "❌ /setsize &lt;W&gt; &lt;H&gt; (256-2048, multiple of 64)\n\n<code>/setsize 1024 1024</code> — square\n<code>/setsize 832 1216</code> — portrait\n<code>/setsize 1216 832</code> — landscape");
          break;
        }
        l.width = 64 * Math.round(e / 64);
        l.height = 64 * Math.round(n / 64);
        await saveConfig(t, l);
        await o.send(a, `✅ Size: ${l.width}×${l.height}`);
        break;
      case "/setsteps":
        const e = parseInt(c[0], 10);
        if (Number.isNaN(e) || e < 1 || e > 150) { await o.send(a, "❌ /setsteps &lt;1-150&gt;"); break; }
        l.steps = e;
        await saveConfig(t, l);
        await o.send(a, `✅ Steps: ${e}`);
        break;
      case "/setcfg":
        const e = parseFloat(c[0]);
        if (Number.isNaN(e) || e < 1 || e > 30) { await o.send(a, "❌ /setcfg &lt;1-30&gt;"); break; }
        l.cfgScale = e;
        await saveConfig(t, l);
        await o.send(a, `✅ CFG: ${e}`);
        break;
      case "/setsampler":
        const e = ["k_euler", "k_euler_a", "k_lms", "k_heun", "k_dpm_2", "k_dpm_2_a", "k_dpmpp_2s_a", "k_dpmpp_2m", "k_dpmpp_sde", "DDIM"];
        const n = c[0];
        if (!n || !e.includes(n)) { await o.send(a, "❌ Available samplers:\n" + e.map(e => `<code>${e}</code>`).join("\n")); break; }
        l.sampler = n;
        await saveConfig(t, l);
        await o.send(a, `✅ Sampler: ${n}`);
        break;
      case "/setneg":
        l.negativePrompt = c.join(" ") || DEFAULT_CONFIG.negativePrompt;
        await saveConfig(t, l);
        await o.send(a, `✅ Negative prompt:\n<code>${escapeHtml(l.negativePrompt)}</code>`);
        break;
      case "/setclipskip":
        const e = parseInt(c[0], 10);
        if (Number.isNaN(e) || e < 1 || e > 4) { await o.send(a, "❌ /setclipskip &lt;1-4&gt;"); break; }
        l.clipSkip = e;
        await saveConfig(t, l);
        await o.send(a, `✅ CLIP Skip: ${e}`);
        break;
      case "/setllm":
        const e = c.join(" ");
        if (!e) {
          await o.send(a, "❌ /setllm &lt;model_id&gt;\n\n<b>Free OpenRouter models:</b>\n<code>meta-llama/llama-3.1-8b-instruct:free</code>\n<code>google/gemma-2-9b-it:free</code>\n<code>mistralai/mistral-7b-instruct:free</code>\n<code>qwen/qwen-2-7b-instruct:free</code>");
          break;
        }
        l.llmModel = e;
        await saveConfig(t, l);
        await o.send(a, `✅ LLM: <code>${escapeHtml(e)}</code>`);
        break;
      case "/setcaption":
        const e = c[0]?.toLowerCase() || "";
        const n = "prompt" === e || "1" === e ? 1 : "ai" === e || "2" === e ? 2 : 0;
        l.captionMode = n;
        await saveConfig(t, l);
        await o.send(a, `✅ Режим подписи: ${0 === n ? "без" : 1 === n ? "промпт" : "🤖 AI"}`);
        break;
      case "/setcaptioninstr":
        const e = c.join(" ");
        if (!e) { await o.send(a, "❌ /setcaptioninstr &lt;инструкция для ИИ&gt;"); break; }
        l.captionInstruction = e;
        await saveConfig(t, l);
        await o.send(a, `✅ Инструкция для AI-подписи обновлена`);
        break;
      case "/setchannel":
        const e = c[0];
        if (!e) { await o.send(a, "❌ /setchannel &lt;@username или chat ID&gt;"); break; }
        l.channelId = e;
        await saveConfig(t, l);
        await o.send(a, `✅ Канал для автопоста: <code>${escapeHtml(e)}</code>\nГруппа остаётся активной: <code>${l.chatId || "—"}</code>`);
        break;
      case "/unsetchannel":
        l.channelId = null;
        await saveConfig(t, l);
        await o.send(a, "✅ Канал отвязан (группа работает как раньше)");
        break;
      case "/addpostproc":
        const e = c[0];
        if (!e) { await o.send(a, "❌ /addpostproc &lt;GFPGAN | CodeFormer&gt;"); break; }
        l.postProcessing = l.postProcessing || [];
        if (!l.postProcessing.includes(e)) l.postProcessing.push(e);
        await saveConfig(t, l);
        await o.send(a, `✅ Post-processing <code>${escapeHtml(e)}</code> добавлен (улучшайзеры лиц и т.д.)`);
        break;
      case "/removepostproc":
        const e = c[0];
        if (!e) { await o.send(a, "❌ /removepostproc &lt;name&gt;"); break; }
        l.postProcessing = (l.postProcessing || []).filter(t => t !== e);
        await saveConfig(t, l);
        await o.send(a, `✅ Post-processing <code>${escapeHtml(e)}</code> удалён`);
        break;
      case "/listpostproc":
        const e = l.postProcessing || [];
        let t = "📋 <b>Post-processing (Horde улучшайзеры):</b>\n\n";
        t += e.length ? e.map(e => `• <code>${escapeHtml(e)}</code> — /removepostproc ${escapeHtml(e)}`).join("\n") : "нет\n\nОбщие: GFPGAN (лица), CodeFormer (лучшие лица)";
        await o.send(a, t);
        break;
      case "/enable":
        if (!l.chatId) { await o.send(a, "❌ First: /setchat"); break; }
        if (!l.generalPrompt) { await o.send(a, "❌ First: /setprompt"); break; }
        l.enabled = true;
        await saveConfig(t, l);
        await o.send(a, `🟢 Autoposting enabled!\nInterval: ${l.interval} min.\nCount: ${l.count}`);
        break;
      case "/disable":
        l.enabled = false;
        await saveConfig(t, l);
        await o.send(a, "🔴 Autoposting disabled");
        break;
      case "/status":
        const { text: e, keyboard: n } = await getStatusResponse(l, t);
        await o.send(a, e, { reply_markup: n });
        break;
      case "/generate":
        if (!l.generalPrompt) { await o.send(a, "❌ First: /setprompt"); break; }
        const e = l.chatId || a;
        await o.send(a, `⏳ Generating ${l.count} images...`);
        const n = (await getWorkerBlacklist(t)).map(e => e.id).filter(Boolean);
        for (let s = 0; s < l.count; s++) {
          try {
            const i = await generatePrompt(l.generalPrompt, t);
            await o.send(a, `🎨 #${s + 1}:\n<code>${escapeHtml(i.substring(0, 300))}</code>`);
            const r = await hordeSubmit(i, l, t, { workerBlacklist: n });
            if (r.id) {
              await KV.put(t, `pending:${r.id}`, JSON.stringify({ chatId: e, prompt: i, at: Date.now(), notify: a, retries: 0 }), { expirationTtl: 3600 });
              await o.send(a, `📤 ID: <code>${r.id}</code>`);
            } else await o.send(a, `❌ Horde: <code>${escapeHtml(JSON.stringify(r).substring(0, 300))}</code>`);
          } catch (e) {
            await o.send(a, `❌ ${escapeHtml(e.message)}`);
          }
        }
        break;
      case "/pending":
        const e = await KV.list(t, "pending:");
        if (!e.keys.length) { await o.send(a, "📋 Queue is empty"); break; }
        let n = `📋 <b>In queue: ${e.keys.length}</b>\n\n`;
        for (const t of e.keys.slice(0, 10)) {
          const e = t.name.replace("pending:", "");
          try {
            const t = await hordeCheck(e);
            n += `🔸 <code>${e}</code>\n   ${t.done ? "✅ Ready" : t.processing ? "⚙️ Processing" : `⏳ Queue #${t.queue_position || "?"}`} | ~${t.wait_time || 0}s\n\n`;
          } catch {
            n += `🔸 <code>${e}</code> — failed to check\n\n`;
          }
        }
        await o.send(a, n);
        break;
      case "/cancel":
        const e = await KV.list(t, "pending:");
        await Promise.all(e.keys.map(e => KV.del(t, e.name)));
        await o.send(a, `🗑 Removed from queue: ${e.keys.length}`);
        break;
      case "/workerbl":
        const e = await getWorkerBlacklist(t);
        if (!e.length) { await o.send(a, "📋 Worker blacklist is empty"); break; }
        let n = `🚫 <b>Worker blacklist: ${e.length}</b>\n\n`;
        for (const t of e) n += `• <code>${escapeHtml(t.name || "?")}</code>\n  ID: <code>${escapeHtml(t.id)}</code>\n  ${new Date(t.t).toISOString().slice(0, 10)}\n\n`;
        n += "/clearworkerbl — clear blacklist";
        await o.send(a, n);
        break;
      case "/clearworkerbl":
        await clearWorkerBlacklist(t);
        await o.send(a, "✅ Worker blacklist cleared");
        break;
      default:
        if (r.startsWith("/")) await o.send(a, "❓ Unknown command — /help");
    }
  } else await o.send(a, `🔒 Admin only (ID: ${l.adminId})`);
}

async function processScheduled(e) {
  if (!e.TELEGRAM_BOT_TOKEN || !e.UPSTASH_REDIS_REST_URL || !e.UPSTASH_REDIS_REST_TOKEN) return;
  const t = new Telegram(e.TELEGRAM_BOT_TOKEN);
  const a = await getConfig(e);
  for (const s of (await KV.list(e, "pending:")).keys) {
    const n = s.name.replace("pending:", "");
    try {
      const o = await KV.get(e, s.name, "json");
      if (!o) { await KV.del(e, s.name); continue; }
      if (Date.now() - o.at > 12e5) {
        await KV.del(e, s.name);
        o.notify && await t.send(o.notify, `⏰ Generation timeout: <code>${n}</code>`);
        continue;
      }
      if (!(await hordeCheck(n)).done) continue;
      const i = await hordeGetResult(n);
      await KV.del(e, s.name);
      if (i.faulted) {
        o.notify && await t.send(o.notify, `❌ Generation <code>${n}</code> failed`);
        continue;
      }
      const r = i.generations || [];
      if (!r.length) {
        o.notify && await t.send(o.notify, `❌ No generations returned for <code>${n}</code>`);
        continue;
      }
      let c = false;
      let l = false;
      for (const a of r) {
        const n = a.worker_id || "?";
        const s = a.worker_name || "?";
        const i = isCensored(a);
        if (o.debug && o.notify) {
          const e = a.img ? isHttpUrl(a.img) ? `URL (${a.img.substring(0, 45)}...)` : `base64 (${a.img.length} chars)` : "null";
          const r = a.gen_metadata?.length ? a.gen_metadata.map(e => `${e.type}:${e.value}`).join(", ") : "none";
          await t.send(o.notify, `🔍 <b>Result</b>\ncensored: ${a.censored ? "yes" : "no"}\nstate: ${a.state || "ok"}\ngen_metadata: ${escapeHtml(r)}\nisCensored(): ${i ? "yes" : "no"}\nWorker: <code>${escapeHtml(s)}</code>\nWorker ID: <code>${escapeHtml(n)}</code>\nModel: <code>${escapeHtml(a.model || "?")}</code>\nImage: ${escapeHtml(e)}`);
        }
        if (i) {
          await addWorkerToBlacklist(e, n, s);
          l = true;
          o.notify && await t.send(o.notify, `🔴 Worker <code>${escapeHtml(s)}</code> returned censorship\nAdded to blacklist and retrying...`);
          continue;
        }
        if (!a.img) {
          o.notify && await t.send(o.notify, "❌ gen.img is empty");
          continue;
        }
        const d = o.prompt || "";
        const p = await getSendCaption(d, a, e);
        const { sent: m, tooSmall: u, sizeKB: h } = await deliverImage(t, o.chatId, a.img, p, o.notify);
        if (m) c = true;
        if (u) {
          l = true;
          await addWorkerToBlacklist(e, n, s);
          o.notify && await t.send(o.notify, `🚫 Worker <code>${escapeHtml(s)}</code> probably returned a placeholder (${h}KB)`);
        }
        if (a.channelId) {
          await deliverImage(t, a.channelId, a.img, p, null);
        }
      }
      if (l && !c && !o.sfwTest) {
        const n = (o.retries || 0) + 1;
        if (n < 3) {
          try {
            const s = (await getWorkerBlacklist(e)).map(e => e.id).filter(Boolean);
            const i = await hordeSubmit(o.prompt, a, e, { workerBlacklist: s });
            if (i.id) {
              await KV.put(e, `pending:${i.id}`, JSON.stringify({ ...o, at: Date.now(), retries: n }), { expirationTtl: 3600 });
              o.notify && await t.send(o.notify, `🔄 Retry ${n}/3: <code>${i.id}</code>\n🚫 Blacklist: ${s.length} workers`);
            }
          } catch (e) {
            console.error("[CRON] retry:", e.message);
          }
        } else o.notify && await t.send(o.notify, "❌ <b>3 attempts — all placeholders/censored</b>\n\nPossible reasons:\n• Anonymous Horde key (NSFW will not work)\n• Account flagged\n• All available workers censor this model\n\n/clearworkerbl — clear blacklist and try again");
      }
      c && o.notify && o.notify !== o.chatId && await t.send(o.notify, "✅ Image sent");
    } catch (e) {
      console.error(`[CRON] ${n}:`, e.message);
    }
  }
  if (!a.enabled || !a.chatId || !a.generalPrompt) return;
  if ((await KV.list(e, "pending:")).keys.length > 0) return;
  const s = parseInt(await KV.get(e, "last_post_time") || "0", 10);
  const o = Date.now();
  if (o - s < 60 * a.interval * 1e3) return;
  await KV.put(e, "last_post_time", String(o));
  const i = (await getWorkerBlacklist(e)).map(e => e.id).filter(Boolean);
  for (let t = 0; t < a.count; t++) {
    try {
      const t = await generatePrompt(a.generalPrompt, e);
      const n = await hordeSubmit(t, a, e, { workerBlacklist: i });
      if (n.id) await KV.put(e, `pending:${n.id}`, JSON.stringify({ chatId: a.chatId, prompt: t, at: o, notify: null, retries: 0 }), { expirationTtl: 3600 });
    } catch (e) {
      console.error("[CRON] auto:", e.message);
    }
  }
}

export default {
  async fetch(e, t) {
    const a = new URL(e.url);
    if ("/webhook" === a.pathname) {
      if ("POST" !== e.method) return new Response("POST only", { status: 405 });
      try {
        const a = await e.json();
        a.message?.text && await handleCommand(a.message, t);
        a.callback_query && await handleCallback(a.callback_query, t);
      } catch (e) {
        console.error("[WH]", e.message);
      }
      return new Response("OK");
    }
    if ("/setup" === a.pathname) {
      if (!t.TELEGRAM_BOT_TOKEN) return new Response("No TELEGRAM_BOT_TOKEN!", { status: 500 });
      const e = `${a.origin}/webhook`;
      const n = await fetch(`https://api.telegram.org/bot${t.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: e, allowed_updates: ["message", "callback_query"], drop_pending_updates: true })
      });
      return new Response(`Webhook: ${e}\n\n${JSON.stringify(await n.json(), null, 2)}`);
    }
    return "/" === a.pathname ? new Response("🤖 Telegram Image Bot is running!\nVisit /setup to configure webhook.") : new Response("Not found", { status: 404 });
  },
  async scheduled(e, t, a) {
    try {
      await processScheduled(t);
    } catch (e) {
      console.error("[CRON] CRASH:", e.message);
    }
  }
};