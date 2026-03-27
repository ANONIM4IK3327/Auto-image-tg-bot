
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
      case "/help": {
        await o.send(a, "🤖 <b>Image Bot</b>\n\n<b>Basics:</b>\n/setchat — set post chat\n/setprompt &lt;text&gt; — main theme\n/setinterval &lt;min&gt; — interval\n/setcount &lt;1-10&gt; — amount\n/enable | /disable — auto mode\n/generate — generate now\n\n<b>Model and LoRA:</b>\n/setmodel &lt;name&gt;\n/listmodels — top-40 models\n/searchlora &lt;query&gt;\n/addlora &lt;version_id&gt; [strength] [clip]\n/removelora &lt;id&gt; | /listloras\n\n<b>Params:</b>\n/setsize &lt;W&gt; &lt;H&gt; | /setsteps &lt;N&gt;\n/setcfg &lt;N&gt; | /setsampler &lt;name&gt;\n/setneg &lt;text&gt; | /setclipskip &lt;1-4&gt;\n/setllm &lt;model_id&gt;\n\n<b>Autopost captions + channel:</b>\n/setcaption none | prompt | ai\n/setcaptioninstr &lt;инструкция ИИ&gt;\n/setchannel &lt;@канал или ID&gt;\n/unsetchannel\n\n<b>Horde улучшайзеры (лица и т.д.):</b>\n/addpostproc GFPGAN\n/removepostproc GFPGAN\n/listpostproc\n\n<b>Management:</b>\n/status | /pending | /cancel\n/workerbl | /clearworkerbl\n/checkkey | /diagnostic | /testsfw | /testimg\n\nИспользуй /status — там удобные кнопки!");
        break;
      }
      case "/setchat": {
        l.chatId = a;
        await saveConfig(t, l);
        await o.send(a, `✅ Post chat set: <code>${a}</code>`);
        break;
      }
      case "/setprompt": {
        const promptText = c.join(" ");
        if (!promptText) { await o.send(a, "❌ /setprompt &lt;theme&gt;"); break; }
        l.generalPrompt = promptText;
        await saveConfig(t, l);
        await o.send(a, `✅ Prompt:\n<code>${escapeHtml(promptText)}</code>`);
        break;
      }
      case "/setinterval": {
        const interval = parseInt(c[0], 10);
        if (Number.isNaN(interval) || interval < 1) { await o.send(a, "❌ /setinterval &lt;minutes&gt; (min 1)"); break; }
        l.interval = interval;
        await saveConfig(t, l);
        await o.send(a, `✅ Interval: ${interval} min`);
        break;
      }
      case "/setcount": {
        const count = parseInt(c[0], 10);
        if (Number.isNaN(count) || count < 1 || count > 10) { await o.send(a, "❌ /setcount &lt;1-10&gt;"); break; }
        l.count = count;
        await saveConfig(t, l);
        await o.send(a, `✅ Count: ${count}`);
        break;
      }
      case "/setmodel": {
        const modelName = c.join(" ");
        if (!modelName) { await o.send(a, "❌ /setmodel &lt;name&gt;\nUse /listmodels"); break; }
        l.model = modelName;
        await saveConfig(t, l);
        await o.send(a, `✅ Model: <code>${escapeHtml(modelName)}</code>`);
        break;
      }
      case "/listmodels": {
        await o.send(a, "⏳ Loading model list...");
        try {
          const models = await hordeGetModels();
          const filtered = (Array.isArray(models) ? models : []).filter(m => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 40);
          let text = "📋 <b>Models (top-40 by workers):</b>\n\n";
          for (const m of filtered) text += `${m.name?.includes("XL") || m.name?.includes("SDXL") ? "🟢" : "⚪"} <code>${escapeHtml(m.name || "?")}</code> (${m.count}w)\n`;
          text += "\n🟢 = SDXL  ⚪ = SD1.5\nCopy name: /setmodel &lt;name&gt;";
          await o.send(a, text);
        } catch (err) {
          await o.send(a, `❌ ${escapeHtml(err.message)}`);
        }
        break;
      }
      case "/searchlora": {
        const query = c.join(" ");
        if (!query) { await o.send(a, "❌ /searchlora &lt;query in English&gt;"); break; }
        await o.send(a, "🔍 Searching CivitAI...");
        try {
          const url = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(query)}&limit=10&sort=Highest%20Rated&nsfw=true`;
          const data = await (await fetch(url)).json();
          if (!data.items?.length) { await o.send(a, "😕 Nothing found"); break; }
          let text = `🔍 <b>LoRA: "${escapeHtml(query)}"</b>\n\n`;
          for (const item of data.items.slice(0, 10)) {
            const version = item.modelVersions?.[0];
            const id = version?.id || "?";
            text += `${item.nsfw ? "🔞" : "✅"} <b>${escapeHtml(item.name)}</b> [${escapeHtml(version?.baseModel || "?")}]\n`;
            text += `   ➕ <code>/addlora ${id} 0.8</code>\n\n`;
          }
          await o.send(a, text);
        } catch (err) {
          await o.send(a, `❌ ${escapeHtml(err.message)}`);
        }
        break;
      }
      case "/addlora": {
        const id = c[0];
        const strength = parseFloat(c[1]) || 0.8;
        const clip = parseFloat(c[2]) || 1;
        if (!id) { await o.send(a, "❌ /addlora &lt;civitai_version_id&gt; [strength=0.8] [clip=1]"); break; }
        l.loras = (l.loras || []).filter(lora => String(lora.name) !== String(id));
        l.loras.push({ name: id, strength, clip });
        await saveConfig(t, l);
        await o.send(a, `✅ LoRA <code>${escapeHtml(id)}</code> (strength: ${strength}, clip: ${clip})`);
        break;
      }
      case "/removelora": {
        const id = c[0];
        if (!id) { await o.send(a, "❌ /removelora &lt;id&gt;"); break; }
        l.loras = (l.loras || []).filter(lora => String(lora.name) !== String(id));
        await saveConfig(t, l);
        await o.send(a, `✅ LoRA <code>${escapeHtml(id)}</code> removed`);
        break;
      }
      case "/listloras": {
        const lorasList = l.loras || [];
        if (!lorasList.length) { await o.send(a, "📋 No LoRA yet. Use /searchlora"); break; }
        let text = "📋 <b>Your LoRA:</b>\n\n";
        lorasList.forEach((lora, idx) => { text += `${idx + 1}. <code>${escapeHtml(lora.name)}</code> (str: ${lora.strength}, clip: ${lora.clip})\n   ❌ /removelora ${escapeHtml(lora.name)}\n\n`; });
        await o.send(a, text);
        break;
      }
      case "/setsize": {
        let w = parseInt(c[0], 10);
        let h = parseInt(c[1], 10);
        if (Number.isNaN(w) || Number.isNaN(h) || w < 256 || h < 256 || w > 2048 || h > 2048) {
          await o.send(a, "❌ /setsize &lt;W&gt; &lt;H&gt; (256-2048, multiple of 64)\n\n<code>/setsize 1024 1024</code> — square\n<code>/setsize 832 1216</code> — portrait\n<code>/setsize 1216 832</code> — landscape");
          break;
        }
        l.width = 64 * Math.round(w / 64);
        l.height = 64 * Math.round(h / 64);
        await saveConfig(t, l);
        await o.send(a, `✅ Size: ${l.width}×${l.height}`);
        break;
      }
      case "/setsteps": {
        const steps = parseInt(c[0], 10);
        if (Number.isNaN(steps) || steps < 1 || steps > 150) { await o.send(a, "❌ /setsteps &lt;1-150&gt;"); break; }
        l.steps = steps;
        await saveConfig(t, l);
        await o.send(a, `✅ Steps: ${steps}`);
        break;
      }
      case "/setcfg": {
        const cfg = parseFloat(c[0]);
        if (Number.isNaN(cfg) || cfg < 1 || cfg > 30) { await o.send(a, "❌ /setcfg &lt;1-30&gt;"); break; }
        l.cfgScale = cfg;
        await saveConfig(t, l);
        await o.send(a, `✅ CFG: ${cfg}`);
        break;
      }
      case "/setsampler": {
        const samplers = ["k_euler", "k_euler_a", "k_lms", "k_heun", "k_dpm_2", "k_dpm_2_a", "k_dpmpp_2s_a", "k_dpmpp_2m", "k_dpmpp_sde", "DDIM"];
        const samplerName = c[0];
        if (!samplerName || !samplers.includes(samplerName)) { await o.send(a, "❌ Available samplers:\n" + samplers.map(s => `<code>${s}</code>`).join("\n")); break; }
        l.sampler = samplerName;
        await saveConfig(t, l);
        await o.send(a, `✅ Sampler: ${samplerName}`);
        break;
      }
      case "/setneg": {
        l.negativePrompt = c.join(" ") || DEFAULT_CONFIG.negativePrompt;
        await saveConfig(t, l);
        await o.send(a, `✅ Negative prompt:\n<code>${escapeHtml(l.negativePrompt)}</code>`);
        break;
      }
      case "/setclipskip": {
        const clipSkipVal = parseInt(c[0], 10);
        if (Number.isNaN(clipSkipVal) || clipSkipVal < 1 || clipSkipVal > 4) { await o.send(a, "❌ /setclipskip &lt;1-4&gt;"); break; }
        l.clipSkip = clipSkipVal;
        await saveConfig(t, l);
        await o.send(a, `✅ CLIP Skip: ${clipSkipVal}`);
        break;
      }
      case "/setllm": {
        const llm = c.join(" ");
        if (!llm) {
          await o.send(a, "❌ /setllm &lt;model_id&gt;\n\n<b>Free OpenRouter models:</b>\n<code>meta-llama/llama-3.1-8b-instruct:free</code>\n<code>google/gemma-2-9b-it:free</code>\n<code>mistralai/mistral-7b-instruct:free</code>\n<code>qwen/qwen-2-7b-instruct:free</code>");
          break;
        }
        l.llmModel = llm;
        await saveConfig(t, l);
        await o.send(a, `✅ LLM: <code>${escapeHtml(llm)}</code>`);
        break;
      }
      case "/setcaption": {
        const modeStr = c[0]?.toLowerCase() || "";
        const mode = "prompt" === modeStr || "1" === modeStr ? 1 : "ai" === modeStr || "2" === modeStr ? 2 : 0;
        l.captionMode = mode;
        await saveConfig(t, l);
        await o.send(a, `✅ Режим подписи: ${0 === mode ? "без" : 1 === mode ? "промпт" : "🤖 AI"}`);
        break;
      }
      case "/setcaptioninstr": {
        const instr = c.join(" ");
        if (!instr) { await o.send(a, "❌ /setcaptioninstr &lt;инструкция для ИИ&gt;"); break; }
        l.captionInstruction = instr;
        await saveConfig(t, l);
        await o.send(a, `✅ Инструкция для AI-подписи обновлена`);
        break;
      }
      case "/setchannel": {
        const channel = c[0];
        if (!channel) { await o.send(a, "❌ /setchannel &lt;@username или chat ID&gt;"); break; }
        l.channelId = channel;
        await saveConfig(t, l);
        await o.send(a, `✅ Канал для автопоста: <code>${escapeHtml(channel)}</code>\nГруппа остаётся активной: <code>${l.chatId || "—"}</code>`);
        break;
      }
      case "/unsetchannel": {
        l.channelId = null;
        await saveConfig(t, l);
        await o.send(a, "✅ Канал отвязан (группа работает как раньше)");
        break;
      }
      case "/addpostproc": {
        const proc = c[0];
        if (!proc) { await o.send(a, "❌ /addpostproc &lt;GFPGAN | CodeFormer&gt;"); break; }
        l.postProcessing = l.postProcessing || [];
        if (!l.postProcessing.includes(proc)) l.postProcessing.push(proc);
        await saveConfig(t, l);
        await o.send(a, `✅ Post-processing <code>${escapeHtml(proc)}</code> добавлен (улучшайзеры лиц и т.д.)`);
        break;
      }
      case "/removepostproc": {
        const proc = c[0];
        if (!proc) { await o.send(a, "❌ /removepostproc &lt;name&gt;"); break; }
        l.postProcessing = (l.postProcessing || []).filter(p => p !== proc);
        await saveConfig(t, l);
        await o.send(a, `✅ Post-processing <code>${escapeHtml(proc)}</code> удалён`);
        break;
      }
      case "/listpostproc": {
        const procs = l.postProcessing || [];
        let text = "📋 <b>Post-processing (Horde улучшайзеры):</b>\n\n";
        text += procs.length ? procs.map(p => `• <code>${escapeHtml(p)}</code> — /removepostproc ${escapeHtml(p)}`).join("\n") : "нет\n\nОбщие: GFPGAN (лица), CodeFormer (лучшие лица)";
        await o.send(a, text);
        break;
      }
      case "/enable": {
        if (!l.chatId) { await o.send(a, "❌ First: /setchat"); break; }
        if (!l.generalPrompt) { await o.send(a, "❌ First: /setprompt"); break; }
        l.enabled = true;
        await saveConfig(t, l);
        await o.send(a, `🟢 Autoposting enabled!\nInterval: ${l.interval} min.\nCount: ${l.count}`);
        break;
      }
      case "/disable": {
        l.enabled = false;
        await saveConfig(t, l);
        await o.send(a, "🔴 Autoposting disabled");
        break;
      }
      case "/status": {
        const { text: statusText, keyboard: kb } = await getStatusResponse(l, t);
        await o.send(a, statusText, { reply_markup: kb });
        break;
      }
      case "/generate": {
        if (!l.generalPrompt) { await o.send(a, "❌ First: /setprompt"); break; }
        const targetChat = l.chatId || a;
        await o.send(a, `⏳ Generating ${l.count} images...`);
        const blacklist = (await getWorkerBlacklist(t)).map(w => w.id).filter(Boolean);
        for (let i = 0; i < l.count; i++) {
          try {
            const prompt = await generatePrompt(l.generalPrompt, t);
            await o.send(a, `🎨 #${i + 1}:\n<code>${escapeHtml(prompt.substring(0, 300))}</code>`);
            const result = await hordeSubmit(prompt, l, t, { workerBlacklist: blacklist });
            if (result.id) {
              await KV.put(t, `pending:${result.id}`, JSON.stringify({ chatId: targetChat, prompt, at: Date.now(), notify: a, retries: 0 }), { expirationTtl: 3600 });
              await o.send(a, `📤 ID: <code>${result.id}</code>`);
            } else await o.send(a, `❌ Horde: <code>${escapeHtml(JSON.stringify(result).substring(0, 300))}</code>`);
          } catch (err) {
            await o.send(a, `❌ ${escapeHtml(err.message)}`);
          }
        }
        break;
      }
      case "/pending": {
        const pendingList = await KV.list(t, "pending:");
        if (!pendingList.keys.length) { await o.send(a, "📋 Queue is empty"); break; }
        let text = `📋 <b>In queue: ${pendingList.keys.length}</b>\n\n`;
        for (const item of pendingList.keys.slice(0, 10)) {
          const id = item.name.replace("pending:", "");
          try {
            const check = await hordeCheck(id);
            text += `🔸 <code>${id}</code>\n   ${check.done ? "✅ Ready" : check.processing ? "⚙️ Processing" : `⏳ Queue #${check.queue_position || "?"}`} | ~${check.wait_time || 0}s\n\n`;
          } catch {
            text += `🔸 <code>${id}</code> — failed to check\n\n`;
          }
        }
        await o.send(a, text);
        break;
      }
      case "/cancel": {
        const pendingList = await KV.list(t, "pending:");
        await Promise.all(pendingList.keys.map(item => KV.del(t, item.name)));
        await o.send(a, `🗑 Removed from queue: ${pendingList.keys.length}`);
        break;
      }
      case "/workerbl": {
        const bl = await getWorkerBlacklist(t);
        if (!bl.length) { await o.send(a, "📋 Worker blacklist is empty"); break; }
        let text = `🚫 <b>Worker blacklist: ${bl.length}</b>\n\n`;
        for (const w of bl) text += `• <code>${escapeHtml(w.name || "?")}</code>\n  ID: <code>${escapeHtml(w.id)}</code>\n  ${new Date(w.t).toISOString().slice(0, 10)}\n\n`;
        text += "/clearworkerbl — clear blacklist";
        await o.send(a, text);
        break;
      }
      case "/clearworkerbl": {
        await clearWorkerBlacklist(t);
        await o.send(a, "✅ Worker blacklist cleared");
        break;
      }
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
      for (const gen of r) {
        const workerId = gen.worker_id || "?";
        const workerName = gen.worker_name || "?";
        const censored = isCensored(gen);
        if (o.debug && o.notify) {
          const imgInfo = gen.img ? isHttpUrl(gen.img) ? `URL (${gen.img.substring(0, 45)}...)` : `base64 (${gen.img.length} chars)` : "null";
          const meta = gen.gen_metadata?.length ? gen.gen_metadata.map(m => `${m.type}:${m.value}`).join(", ") : "none";
          await t.send(o.notify, `🔍 <b>Result</b>\ncensored: ${gen.censored ? "yes" : "no"}\nstate: ${gen.state || "ok"}\ngen_metadata: ${escapeHtml(meta)}\nisCensored(): ${censored ? "yes" : "no"}\nWorker: <code>${escapeHtml(workerName)}</code>\nWorker ID: <code>${escapeHtml(workerId)}</code>\nModel: <code>${escapeHtml(gen.model || "?")}</code>\nImage: ${escapeHtml(imgInfo)}`);
        }
        if (censored) {
          await addWorkerToBlacklist(e, workerId, workerName);
          l = true;
          o.notify && await t.send(o.notify, `🔴 Worker <code>${escapeHtml(workerName)}</code> returned censorship\nAdded to blacklist and retrying...`);
          continue;
        }
        if (!gen.img) {
          o.notify && await t.send(o.notify, "❌ gen.img is empty");
          continue;
        }
        const prompt = o.prompt || "";
        const caption = await getSendCaption(prompt, a, e);
        const { sent: sentOk, tooSmall: tooSmallFlag, sizeKB: size } = await deliverImage(t, o.chatId, gen.img, caption, o.notify);
        if (sentOk) c = true;
        if (tooSmallFlag) {
          l = true;
          await addWorkerToBlacklist(e, workerId, workerName);
          o.notify && await t.send(o.notify, `🚫 Worker <code>${escapeHtml(workerName)}</code> probably returned a placeholder (${size}KB)`);
        }
        if (a.channelId) {
          await deliverImage(t, a.channelId, gen.img, caption, null);
        }
      }
      if (l && !c && !o.sfwTest) {
        const retries = (o.retries || 0) + 1;
        if (retries < 3) {
          try {
            const bl = (await getWorkerBlacklist(e)).map(w => w.id).filter(Boolean);
            const retryResult = await hordeSubmit(o.prompt, a, e, { workerBlacklist: bl });
            if (retryResult.id) {
              await KV.put(e, `pending:${retryResult.id}`, JSON.stringify({ ...o, at: Date.now(), retries }), { expirationTtl: 3600 });
              o.notify && await t.send(o.notify, `🔄 Retry ${retries}/3: <code>${retryResult.id}</code>\n🚫 Blacklist: ${bl.length} workers`);
            }
          } catch (err) {
            console.error("[CRON] retry:", err.message);
          }
        } else o.notify && await t.send(o.notify, "❌ <b>3 attempts — all placeholders/censored</b>\n\nPossible reasons:\n• Anonymous Horde key (NSFW will not work)\n• Account flagged\n• All available workers censor this model\n\n/clearworkerbl — clear blacklist and try again");
      }
      c && o.notify && o.notify !== o.chatId && await t.send(o.notify, "✅ Image sent");
    } catch (err) {
      console.error(`[CRON] ${n}:`, err.message);
    }
  }
  if (!a.enabled || !a.chatId || !a.generalPrompt) return;
  if ((await KV.list(e, "pending:")).keys.length > 0) return;
  const lastTime = parseInt(await KV.get(e, "last_post_time") || "0", 10);
  const now = Date.now();
  if (now - lastTime < 60 * a.interval * 1e3) return;
  await KV.put(e, "last_post_time", String(now));
  const blacklist = (await getWorkerBlacklist(e)).map(w => w.id).filter(Boolean);
  for (let i = 0; i < a.count; i++) {
    try {
      const prompt = await generatePrompt(a.generalPrompt, e);
      const result = await hordeSubmit(prompt, a, e, { workerBlacklist: blacklist });
      if (result.id) await KV.put(e, `pending:${result.id}`, JSON.stringify({ chatId: a.chatId, prompt, at: now, notify: null, retries: 0 }), { expirationTtl: 3600 });
    } catch (err) {
      console.error("[CRON] auto:", err.message);
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
      } catch (err) {
        console.error("[WH]", err.message);
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
    } catch (err) {
      console.error("[CRON] CRASH:", err.message);
    }
  }
};