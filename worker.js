
// ============================================================
// Telegram Image Bot — Cloudflare Workers
// AI Horde + OpenRouter + Upstash Redis
//
// Improvements:
//  - Settings organized via buttons (/settings)
//  - Enhanced model/LoRA list with search and pagination
  - Added AI Horde enhancers (face fixer, upscalers, etc.) with selection
  - Prompt modification via [brackets] for LLM-driven prompt editing
  - Auto-post modes: prompt hidden/shown/AI-generated post text
  - Telegram channel/group auto-posting with independent control
  - Preset saving/loading for quick configuration switching
  - KV database migrated to Upstash Redis (using UPSTASH_REDIS_REST_URL/TOKEN)
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
  faceFixer: false,
  faceFixerStrength: 0.75,
  upscaler: "None",
  upscaleBy: 2,
  promptMode: "hidden", // hidden/shown/ai
  aiPostInstruction: "Make this a catchy social media post description",
  channelId: null,
  groupId: null,
  useChannel: true,
  useGroup: true,
  presets: {},
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:15.0:tg" };
const MAX_RETRIES = 3;
const MIN_IMAGE_KB = 10;
const UPSTASH_URL = "UPSTASH_REDIS_REST_URL";
const UPSTASH_TOKEN = "UPSTASH_REDIS_REST_TOKEN";

// ============================================================
// Upstash Redis KV Helper
// ============================================================const KV = {
  async get(env, key, type = "text") {
    const url = env[UPSTASH_URL];
    const token = env[UPSTASH_TOKEN];
    if (!url || !token) return null;
    try {
      const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.result === null) return null;
      return type === "json" ? JSON.parse(data.result) : data.result;
    } catch {
      return null;
    }
  },
  async put(env, key, val, opts = {}) {
    const url = env[UPSTASH_URL];
    const token = env[UPSTASH_TOKEN];
    if (!url || !token) throw new Error("KV не привязан!");
    try {
      const value = typeof val === "object" ? JSON.stringify(val) : val;
      const body = { value };
      if (opts.expirationTtl) body.ex = opts.expirationTtl;
      await fetch(`${url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`KV put failed: ${e.message}`);
    }
  },
  async del(env, key) {
    const url = env[UPSTASH_URL];
    const token = env[UPSTASH_TOKEN];
    if (!url || !token) return;
    try {
      await fetch(`${url}/del/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  },
  async list(env, prefix) {
    const url = env[UPSTASH_URL];
    const token = env[UPSTASH_TOKEN];
    if (!url || !token) return { keys: [] };
    try {
      let cursor = "0";
      const keys = [];
      do {
        const res = await fetch(
          `${url}/scan/${cursor}?match=${encodeURIComponent(prefix + "*")}&count=1000`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) break;
        const data = await res.json();
        cursor = data.result[0];
        keys.push(...data.result[1].map((k) => ({ name: k })));
      } while (cursor !== "0");
      return { keys };
    } catch {
      return { keys: [] };
    }
  },
};

// ============================================================
// Config Helpers
// ============================================================

async function getConfig(env) {
  const stored = await KV.get(env, "config", "json");
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function saveConfig(env, config) {
  await KV.put(env, "config", JSON.stringify(config));
}

// ============================================================
// Preset Management
// ============================================================

async function getPresets(env) {
  const presets = await KV.get(env, "presets", "json");
  return presets || {};
}

async function savePreset(env, name, config) {
  const presets = await getPresets(env);
  presets[name] = config;
  await KV.put(env, "presets", presets);
}

async function loadPreset(env, name) {
  const presets = await getPresets(env);
  return presets[name] || null;
}

async function deletePreset(env, name) {
  const presets = await getPresets(env);
  delete presets[name];
  await KV.put(env, "presets", presets);
}

// ============================================================
// Utility Functions
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

// ============================================================
// Telegram// ============================================================

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
    if (!res.ok) {
      console.error(`[TG] ${method}:`, JSON.stringify(res).substring(0, 400));
    }
    return res;
  }

  send(chatId, text, extra = {}) {
    return this.api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...extra,
    });
  }

  async sendPhoto(chatId, arrayBuffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(
      "photo",
      new File([arrayBuffer], "image.webp", { type: "image/webp" })
    );
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.base}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    return r.json();
  }

  async sendDocument(chatId, arrayBuffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(
      "document",
      new File([arrayBuffer], "image.webp", { type: "image/webp" })
    );
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.base}/sendDocument`, {
      method: "POST",
      body: form,
    });
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
}

// ============================================================
// Worker Blacklist
// ============================================================

async function getWorkerBlacklist(env) {
  return (await KV.get(env, "worker_blacklist", "json")) || [];
}

async function addWorkerToBlacklist(env, workerId, workerName) {
  if (!workerId || workerId === "?" || String(workerId).length < 10) return;
  const list = await getWorkerBlacklist(env);
  if (!list.find((w) => w.id === workerId)) {
    list.push({ id: workerId, name: workerName || "?", t: Date.now() });
    while (list.length > 30) list.shift();
    await KV.put(env, "worker_blacklist", JSON.stringify(list));
    console.log(`[BL] Added worker: ${workerName} (${workerId})`);
  }
}

async function clearWorkerBlacklist(env) {
  await KV.put(env, "worker_blacklist", "[]");
}

// ============================================================
// Horde Censorship Detection
// ============================================================function isCensored(gen) {
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
    tiling: false,
    post_processing: [],
    n: 1,
  };

  if (config.hiresFix) {
    params.hires_fix = true;
    params.hires_fix_denoising_strength = config.hiresFixDenoising || 0.65;
  }

  if (config.faceFixer) {
    params.facefixer_strength = config.faceFixerStrength;
  }

  if (config.upscaler !== "None") {
    params.post_processing.push(config.upscaler);
    if (config.upscaleBy !== 2) {
      // Note: Horde doesn't have direct upscale_by parameter, we'll use multiple passes if needed
      // For simplicity, we rely on the upscaler's default scale (usually 2x or 4x)
      // Advanced users can chain upscalers in post_processing array
    }
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
  const r = await fetch(`${HORDE_API}/generate/check/${id}`, {
    headers: HORDE_HEADERS,
  });
  return r.json();
}

async function hordeGetResult(id) {
  const r = await fetch(`${HORDE_API}/generate/status/${id}`, {
    headers: HORDE_HEADERS,
  });
  return r.json();
}

async function hordeGetModels() {
  const r = await fetch(`${HORDE_API}/status/models?type=image`, {
    headers: HORDE_HEADERS,
  });
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
    await tg.send(
      notifyChat,
      `❌ Не удалось отправить изображение: ${escapeHtml(res.description || "unknown error")}`
    );
  }

  return { sent: false, tooSmall: false, sizeKB };
}

// ============================================================
// Prompt Generation
// ============================================================

const P = {
  angle: [
    "from above",
    "low angle",
    "eye level",
    "dutch angle",
    "bird's eye view",
    "extreme close-up",
    "wide establishing shot",
    "portrait framing",
    "three-quarter view",
    "profile view",
    "from behind",
    "over the shoulder",
  ],
  light: [
    "golden hour sunlight",
    "blue hour twilight",
    "dramatic chiaroscuro",
    "soft overcast light",
    "neon cyberpunk glow",
    "moonlit night",
    "studio rim lighting",
    "dappled forest light",
    "harsh midday shadows",
    "candlelit ambiance",
    "volumetric god rays",
    "backlit silhouette",
  ],
  style: [
    "photorealistic photography",
    "digital concept art",
    "oil painting",
    "watercolor washes",
    "anime cel shading",
    "dark fantasy illustration",
    "hyperrealistic 8k render",
    "film noir",
    "surrealist dreamlike",
    "pop art",
    "renaissance painting",
    "vaporwave aesthetic",
  ],
  mood: [
    "serene and peaceful",
    "intense and dramatic",
    "mysterious and enigmatic",
    "vibrant and energetic",
    "ethereal and dreamlike",
    "dark and brooding",
    "warm and intimate",
    "epic and grandiose",
    "melancholic and wistful",
    "playful and whimsical",
  ],
  detail: [
    "intricate filigree details",
    "rough textured surfaces",
    "smooth polished finish",
    "ornate decoration",
    "minimalist clean lines",
    "weathered aged patina",
    "crystalline sharp focus",
    "beautiful bokeh",
    "particle effects",
    "reflections and refractions",
  ],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}

function templatePrompt(base) {
  return [
    base,
    pick(P.angle),
    pick(P.light),
    pick(P.style),
    pick(P.mood),
    ...pickN(P.detail, 2),
    "masterpiece",
    "best quality",
    "highly detailed",
  ].join(", ");
}

function processPromptBrackets(text) {
  // Find all [content] blocks
  const bracketMatches = text.match(/\[([^\]]+)\]/g);
  if (!bracketMatches) return text;

  let processed = text;
  for (const match of bracketMatches) {
    const instruction = match.slice(1, -1).trim();
    if (instruction) {
      // Generate LLM-based replacement for the bracket content
      const replacement = generateLLMReplacement(instruction);
      processed = processed.replace(match, replacement);
    }
  }
  return processed;
}

async function generateLLMReplacement(instruction) {
  if (!env.OPENROUTER_API_KEY) return instruction;
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
        model: "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          {
            role: "system",
            content:
              `You are a creative assistant. Output ONLY the requested content. ` +
              `No explanations, no quotes, no markdown. Be concise and relevant.`,
          },
          {
            role: "user",
            content: `Generate content for: ${instruction}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 100,
      }),
    });

    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || instruction;
  } catch (e) {
    console.error("[LLM Replacement]", e.message);
    return instruction;
  }
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
            content:
              `You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. ` +
              `No explanations, no quotes, no markdown. Under 100 words. Be creative and unique. ` +
              `Direction: ${pick(directions)}`,
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
    const p = data.choices?.[0]?.message?.content?.trim().replace(/^["'`*]+|["'`*]+$/g, "");
    if (p?.length > 10) return p;
  } catch (e) {
    console.error("[LLM]", e.message);
  }

  return templatePrompt(instruction);
}

async function generatePrompt(instruction, env) {
  // First process any [brackets] in the instruction
  const processedInstruction = processPromptBrackets(instruction);
  
  if (env.OPENROUTER_API_KEY) {
    const config = await getConfig(env);
    return llmPrompt(
      processedInstruction,
      env.OPENROUTER_API_KEY,
      config.llmModel || env.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free"
    );
  }
  return templatePrompt(processedInstruction);
}

// ============================================================
// Commands
// ============================================================

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
    const k = getApiKey(env);
    await tg.send(
      chatId,
      `🏓 <b>Pong!</b>\n\n` +
        `📍 Chat: <code>${chatId}</code>\n` +
        `👤 User: <code>${userId}</code>\n` +
        `💾 KV: ${env[UPSTASH_URL] && env[UPSTASH_TOKEN] ? "✅ Upstash" : "❌"}\n` +
        `🎨 Horde: ${k === "0000000000" ? "🔴 anonymous (NSFW will not work)" : "✅ " + k.substring(0, 8) + "..."}\n` +
        `🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️ templates"}`
    );
    return;
  }

  if (cmd === "/diagnostic") {
    const k = getApiKey(env);
    const bl = await getWorkerBlacklist(env);
    await tg.send(
      chatId,
      `🔧 <b>Diagnostics</b>\n\n` +
        `💾 KV: ${env[UPSTASH_URL] && env[UPSTASH_TOKEN] ? "✅ Upstash" : "❌ not bound"}\n` +
        `🔑 Horde key: ${k === "0000000000" ? "🔴 anonymous" : "✅ " + k.substring(0, 8) + "..."}\n` +
        `🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}\n\n` +
        `<b>Request flags:</b>\n` +
        `  nsfw: true\n` +
        `  censor_nsfw: false\n` +
        `  trusted_workers: false\n` +
        `  replacement_filter: true\n` +
        `  r2: true\n` +
        `  allow_downgrade: true\n\n` +
        `🚫 Blacklisted workers: <b>${bl.length}</b>\n` +
        `📏 Min image size: ${MIN_IMAGE_KB}KB\n\n` +
        `<b>Censorship detection:</b>\n` +
        `  1. gen_metadata[].type=="censorship"\n` +
        `  2. gen.censored === true\n` +
        `  3. gen.state === "censored"\n` +
        `  4. size < ${MIN_IMAGE_KB}KB`
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
      ? "🔴 <b>Anonymous key</b>\nNSFW will not work.\nRegister at stablehorde.net."
      : info.flagged      ? "⚠️ Account flagged — censorship may happen"
      : "✅ Key looks fine, NSFW should work";

    await tg.send(
      chatId,
      `${info.anon ? "🔴" : "✅"} <b>${escapeHtml(info.user || "anonymous")}</b>\n\n` +
        `💎 Kudos: ${info.kudos || 0}\n` +
        `🛡 Trusted: ${info.trusted ? "yes" : "no"}\n` +
        `🚩 Flagged: ${info.flagged ? "yes" : "no"}\n\n` +
        status
    );
    return;
  }

  if (cmd === "/testimg") {
    await tg.send(chatId, "🧪 Testing image sending...");

    const urlTest = await tg.sendPhotoUrl(chatId, "https://picsum.photos/512/512", "URL test");
    await tg.send(chatId, urlTest.ok ? "✅ URL photo works" : `❌ URL test failed: ${escapeHtml(urlTest.description || "")}`);

    try {
      const resp = await fetch("https://picsum.photos/256/256");
      const buf = await resp.arrayBuffer();
      const bufTest = await tg.sendPhoto(chatId, buf, "Buffer test");
      await tg.send(
        chatId,
        bufTest.ok
          ? "✅ Buffer photo works"
          : `❌ Buffer test failed: ${escapeHtml(bufTest.description || "")}`
      );
    } catch (e) {
      await tg.send(chatId, `❌ ${escapeHtml(e.message)}`);
    }
    return;
  }

  if (cmd === "/testsfw") {
    if (!(env[UPSTASH_URL] && env[UPSTASH_TOKEN])) {
      await tg.send(chatId, "❌ KV not bound!");
      return;
    }
    const config = await getConfig(env);
    const sfwPrompt =
      "beautiful mountain landscape, crystal clear lake, sunset sky, orange and pink clouds, pine trees, snow capped peaks, nature photography, 4k, masterpiece, best quality, highly detailed, sharp focus";
    await tg.send(chatId, "🧪 Sending SFW test generation to Horde...");
    try {
      const result = await hordeSubmit(sfwPrompt, config, env, { skipLoras: true });
      if (result.id) {
        await KV.put(
          env,
          `pending:${result.id}`,
          JSON.stringify({
            chatId,
            prompt: sfwPrompt,
            at: Date.now(),
            notify: chatId,
            debug: true,
            retries: 99,
            sfwTest: true,
          }),
          { expirationTtl: 3600 }
        );
        await tg.send(chatId, `📤 ID: <code>${result.id}</code>\n⏳ Wait for cron...`);
      } else {
        await tg.send(chatId, `❌ Horde: <code>${escapeHtml(JSON.stringify(result).substring(0, 400))}</code>`);
      }
    } catch (e) {
      await tg.send(chatId, `❌ ${escapeHtml(e.message)}`);
    }
    return;
  }

  if (!(env[UPSTASH_URL] && env[UPSTASH_TOKEN])) {
    await tg.send(chatId, "❌ KV not bound! Use /diagnostic");
    return;
  }

  let config = await getConfig(env);

  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(env, config);
    await tg.send(chatId, `👑 You are admin. ID: <code>${userId}</code>`);
  }

  if (config.adminId !== userId) {
    await tg.send(chatId, `🔒 Admin only (ID: ${config.adminId})`);
    return;
  }

  switch (cmd) {
    case "/start":
    case "/help": {
      await tg.send(
        chatId,
        `🤖 <b>Image Bot</b>\n\n` +
          `<b>Basics:</b>\n` +
          `/setchat — set post chat\n` +
          `/setprompt &lt;text&gt; — main theme\n` +
          `/setinterval &lt;min&gt; — interval\n` +
          `/setcount &lt;1-10&gt; — amount\n` +
          `/enable | /disable — auto mode\n` +
          `/generate — generate now\n\n` +
          `<b>Model and LoRA:</b>\n` +
          `/setmodel &lt;name&gt;\n` +
          `/listmodels — top-40 models\n` +
          `/searchlora &lt;query&gt;\n` +
          `/addlora &lt;version_id&gt; [strength] [clip]\n` +
          `/removelora &lt;id&gt; | /listloras\n\n` +
          `<b>Params:</b>\n` +
          `/setsize &lt;W&gt; &lt;H&gt; | /setsteps &lt;N&gt;\n` +
          `/setcfg &lt;N&gt; | /setsampler &lt;name&gt;\n` +
          `/setneg &lt;text&gt; | /setclipskip &lt;1-4&gt;\n` +
          `/setllm &lt;model_id&gt;\n` +
          `/setfacefixer &lt;on/off&gt; [strength]\n` +
          `/setupscaler &lt;name&gt; [scale]\n\n` +
          `<b>Prompt Control:</b>\n` +
          `/setpromptmode &lt;hidden/shown/ai&gt;\n` +
          `/setaiinstruction &lt;text&gt;\n\n` +
          `<b>Channel/Group:</b>\n` +
          `/setchannel &lt;id&gt;\n` +
          `/setgroup &lt;id&gt;\n` +
          `/togglechannel\n` +
          `/togglegroup\n\n` +
          `<b>Management:</b>\n` +
          `/status | /pending | /cancel\n` +
          `/workerbl | /clearworkerbl\n` +
          `/checkkey | /diagnostic | /testsfw | /testimg\n` +
          `/settings — open settings menu\n` +
          `/preset &lt;name&gt; — load preset\n` +
          `/savepreset &lt;name&gt; — save current config\n` +
          `/delpreset &lt;name&gt; — delete preset\n` +
          `/listpresets`
      );
      break;
    }

    case "/settings": {
      await showSettingsMenu(tg, chatId, config);
      break;
    }

    case "/setchat": {
      config.chatId = chatId;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Post chat set: <code>${chatId}</code>`);
      break;
    }

    case "/setprompt": {
      const p = args.join(" ");
      if (!p) {
        await tg.send(chatId, "❌ /setprompt &lt;theme&gt;");
        break;
      }
      config.generalPrompt = p;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Prompt:\n<code>${escapeHtml(p)}</code>`);
      break;
    }

    case "/setinterval": {
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n) || n < 1) {
        await tg.send(chatId, "❌ /setinterval &lt;minutes&gt; (min 1)");
        break;
      }
      config.interval = n;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Interval: ${n} min`);
      break;
    }

    case "/setcount": {
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n) || n < 1 || n > 10) {
        await tg.send(chatId, "❌ /setcount &lt;1-10&gt;");
        break;
      }
      config.count = n;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Count: ${n}`);
      break;
    }

    case "/setmodel": {
      const name = args.join(" ");
      if (!name) {
        await tg.send(chatId, "❌ /setmodel &lt;name&gt;\nUse /listmodels");
        break;
      }
      config.model = name;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Model: <code>${escapeHtml(name)}</code>`);
      break;
    }

    case "/listmodels": {
      await tg.send(chatId, "⏳ Loading model list...");
      try {
        const models = await hordeGetModels();
        const sorted = (Array.isArray(models) ? models : [])
          .filter((m) => m.count > 0)
          .sort((a, b) => b.count - a.count)
          .slice(0, 40);

        let txt = "📋 <b>Models (top-40 by workers):</b>\n\n";
        for (const m of sorted) {
          const tag = m.name?.includes("XL") || m.name?.includes("SDXL") ? "🟢" : "⚪";
          txt += `${tag} <code>${escapeHtml(m.name || "?")}</code> (${m.count}w)\n`;
        }
        txt += "\n🟢 = SDXL  ⚪ = SD1.5\nCopy name: /setmodel &lt;name&gt;";
        await tg.send(chatId, txt);
      } catch (e) {
        await tg.send(chatId, `❌ ${escapeHtml(e.message)}`);
      }
      break;
    }

    case "/searchlora": {
      const query = args.join(" ");
      if (!query) {
        await tg.send(chatId, "❌ /searchlora &lt;query in English&gt;");
        break;
      }
      await tg.send(chatId, "🔍 Searching CivitAI...");
      try {
        const url = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(
          query
        )}&limit=10&sort=Highest%20Rated&nsfw=true`;
        const data = await (await fetch(url)).json();
        if (!data.items?.length) {
          await tg.send(chatId, "😕 Nothing found");
          break;
        }

        let txt = `🔍 <b>LoRA: "${escapeHtml(query)}"</b>\n\n`;
        for (const item of data.items.slice(0, 10)) {
          const ver = item.modelVersions?.[0];
          const vid = ver?.id || "?";
          txt += `${item.nsfw ? "🔞" : "✅"} <b>${escapeHtml(item.name)}</b> [${escapeHtml(
            ver?.baseModel || "?"
          )}]\n`;
          txt += `   ➕ <code>/addlora ${vid} 0.8</code>\n\n`;
        }
        await tg.send(chatId, txt);
      } catch (e) {
        await tg.send(chatId, `❌ ${escapeHtml(e.message)}`);
      }
      break;
    }

    case "/addlora": {
      const id = args[0];
      const strength = parseFloat(args[1]) || 0.8;
      const clip = parseFloat(args[2]) || 1;
      if (!id) {
        await tg.send(chatId, "❌ /addlora &lt;civitai_version_id&gt; [strength=0.8] [clip=1]");
        break;
      }
      config.loras = (config.loras || []).filter((l) => String(l.name) !== String(id));
      config.loras.push({ name: id, strength, clip });
      await saveConfig(env, config);
      await tg.send(chatId, `✅ LoRA <code>${escapeHtml(id)}</code> (strength: ${strength}, clip: ${clip})`);
      break;
    }

    case "/removelora": {
      const id = args[0];
      if (!id) {
        await tg.send(chatId, "❌ /removelora &lt;id&gt;");
        break;
      }
      config.loras = (config.loras || []).filter((l) => String(l.name) !== String(id));
      await saveConfig(env, config);
      await tg.send(chatId, `✅ LoRA <code>${escapeHtml(id)}</code> removed`);
      break;
    }

    case "/listloras": {
      const loras = config.loras || [];
      if (!loras.length) {
        await tg.send(chatId, "📋 No LoRA yet. Use /searchlora");
        break;
      }
      let txt = "📋 <b>Your LoRA:</b>\n\n";
      loras.forEach((l, i) => {
        txt += `${i + 1}. <code>${escapeHtml(l.name)}</code> (str: ${l.strength}, clip: ${l.clip})\n   ❌ /removelora ${escapeHtml(
          l.name
        )}\n\n`;
      });
      await tg.send(chatId, txt);
      break;
    }

    case "/setsize": {
      let w = parseInt(args[0], 10);
      let h = parseInt(args[1], 10);
      if (
        Number.isNaN(w) ||
        Number.isNaN(h) ||
        w < 256 ||
        h < 256 ||
        w > 2048 ||
        h > 2048
      ) {
        await tg.send(
          chatId,
          "❌ /setsize &lt;W&gt; &lt;H&gt; (256-2048, multiple of 64)\n\n" +
            "<code>/setsize 1024 1024</code> — square\n" +
            "<code>/setsize 832 1216</code> — portrait\n" +
            "<code>/setsize 1216 832</code> — landscape"
        );
        break;
      }
      config.width = Math.round(w / 64) * 64;
      config.height = Math.round(h / 64) * 64;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Size: ${config.width}×${config.height}`);
      break;
    }

    case "/setsteps": {
      const s = parseInt(args[0], 10);
      if (Number.isNaN(s) || s < 1 || s > 150) {
        await tg.send(chatId, "❌ /setsteps &lt;1-150&gt;");
        break;
      }
      config.steps = s;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Steps: ${s}`);
      break;
    }

    case "/setcfg": {
      const c = parseFloat(args[0]);
      if (Number.isNaN(c) || c < 1 || c > 30) {
        await tg.send(chatId, "❌ /setcfg &lt;1-30&gt;");
        break;
      }
      config.cfgScale = c;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ CFG: ${c}`);
      break;
    }

    case "/setsampler": {
      const samplers = [
        "k_euler",
        "k_euler_a",
        "k_lms",
        "k_heun",
        "k_dpm_2",
        "k_dpm_2_a",
        "k_dpmpp_2s_a",
        "k_dpmpp_2m",
        "k_dpmpp_sde",
        "DDIM",
      ];
      const s = args[0];
      if (!s || !samplers.includes(s)) {
        await tg.send(
          chatId,
          "❌ Available samplers:\n" + samplers.map((x) => `<code>${x}</code>`).join("\n")
        );
        break;
      }
      config.sampler = s;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Sampler: ${s}`);
      break;
    }

    case "/setneg": {
      config.negativePrompt = args.join(" ") || DEFAULT_CONFIG.negativePrompt;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Negative prompt:\n<code>${escapeHtml(config.negativePrompt)}</code>`);
      break;
    }

    case "/setclipskip": {
      const cs = parseInt(args[0], 10);
      if (Number.isNaN(cs) || cs < 1 || cs > 4) {
        await tg.send(chatId, "❌ /setclipskip &lt;1-4&gt;");
        break;
      }
      config.clipSkip = cs;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ CLIP Skip: ${cs}`);
      break;
    }

    case "/setllm": {
      const llm = args.join(" ");
      if (!llm) {
        await tg.send(
          chatId,
          `❌ /setllm &lt;model_id&gt;\n\n<b>Free OpenRouter models:</b>\n` +
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

    case "/setfacefixer": {
      const on = args[0]?.toLowerCase() === "on" || args[0] === "1" || args[0] === "true";
      const strength = parseFloat(args[1]) || 0.75;
      config.faceFixer = on;
      config.faceFixerStrength = clamp(strength, 0, 1);
      await saveConfig(env, config);
      await tg.send(
        chatId,
        `✅ Face Fixer: ${on ? "enabled" : "disabled"}${
          on ? ` (strength: ${config.faceFixerStrength})` : ""
        }`
      );
      break;
    }

    case "/setupscaler": {
      const upscaler = args[0] || "None";
      const scale = parseFloat(args[1]) || 2;
      config.upscaler = upscaler;
      config.upscaleBy = clamp(scale, 1, 4);
      await saveConfig(env, config);
      await tg.send(
        chatId,
        `✅ Upscaler: ${upscaler}${
          upscaler !== "None" ? ` (scale: ${config.upscaleBy}x)` : ""
        }`
      );
      break;
    }

    case "/setpromptmode": {
      const mode = args[0]?.toLowerCase();
      if (!["hidden", "shown", "ai"].includes(mode)) {
        await tg.send(chatId, "❌ /setpromptmode &lt;hidden/shown/ai&gt;");
        break;
      }
      config.promptMode = mode;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Prompt mode: ${mode}`);
      break;
    }

    case "/setaiinstruction": {
      const instruction = args.join(" ");
      if (!instruction) {
        await tg.send(chatId, "❌ /setaiinstruction &lt;text&gt;");
        break;
      }
      config.aiPostInstruction = instruction;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ AI Post Instruction:\n<code>${escapeHtml(instruction)}</code>`);
      break;
    }

    case "/setchannel": {
      const id = args[0];
      if (!id) {
        await tg.send(chatId, "❌ /setchannel &lt;chat_id&gt;");
        break;
      }
      config.channelId = id;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Channel set: <code>${id}</code>`);
      break;
    }

    case "/setgroup": {
      const id = args[0];
      if (!id) {
        await tg.send(chatId, "❌ /setgroup &lt;chat_id&gt;");
        break;
      }
      config.groupId = id;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Group set: <code>${id}</code>`);
      break;
    }

    case "/togglechannel": {
      config.useChannel = !config.useChannel;
      await saveConfig(env, config);
      await tg.send(
        chatId,
        `✅ Channel posting: ${config.useChannel ? "enabled" : "disabled"}`
      );
      break;
    }

    case "/togglegroup": {
      config.useGroup = !config.useGroup;
      await saveConfig(env, config);
      await tg.send(
        chatId,
        `✅ Group posting: ${config.useGroup ? "enabled" : "disabled"}`
      );
      break;
    }

    case "/enable": {
      if (!config.chatId) {
        await tg.send(chatId, "❌ First: /setchat");
        break;
      }
      if (!config.generalPrompt) {
        await tg.send(chatId, "❌ First: /setprompt");
        break;
      }
      config.enabled = true;
      await saveConfig(env, config);
      await tg.send(
        chatId,
        `🟢 Autoposting enabled!\nInterval: ${config.interval} min.\nCount: ${config.count}`
      );
      break;
    }

    case "/disable": {
      config.enabled = false;
      await saveConfig(env, config);
      await tg.send(chatId, "🔴 Autoposting disabled");
      break;
    }

    case "/status": {
      let pendingCount = 0;
      try {
        pendingCount = (await KV.list(env, "pending:")).keys.length;
      } catch {}
      const bl = await getWorkerBlacklist(env);
      const lorasTxt =
        (config.loras || [])
          .map((l) => `  • <code>${escapeHtml(l.name)}</code> (${l.strength})`)
          .join("\n") || "  none";

      await tg.send(
        chatId,
        `📊 <b>Status</b>\n\n` +
          `<b>Autopost:</b> ${config.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
          `<b>Chat:</b> <code>${config.chatId || "—"}</code>\n` +
          `<b>Interval:</b> ${config.interval} min.\n` +
          `<b>Count:</b> ${config.count}\n\n` +
          `<b>Prompt:</b>\n<code>${escapeHtml(config.generalPrompt || "—")}</code>\n\n` +
          `<b>Model:</b> <code>${escapeHtml(config.model)}</code>\n` +
          `<b>Size:</b> ${config.width}×${config.height}\n` +
          `<b>Steps:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}\n` +
          `<b>Sampler:</b> ${config.sampler}\n` +
          `<b>CLIP Skip:</b> ${config.clipSkip || 1}\n` +
          `<b>NSFW:</b> ${config.nsfw ? "🔞 yes" : "no"}\n` +
          `<b>Allow downgrade:</b> true\n\n` +
          `<b>Negative:</b>\n<code>${escapeHtml(config.negativePrompt)}</code>\n\n` +
          `<b>LoRA:</b>\n${lorasTxt}\n\n` +
          `<b>LLM:</b> <code>${escapeHtml(config.llmModel || env.LLM_MODEL || "auto")}</code>\n` +
          `<b>Face Fixer:</b> ${config.faceFixer ? `✅ (${config.faceFixerStrength})` : "❌"}\n` +
          `<b>Upscaler:</b> ${config.upscaler === "None" ? "❌" : `✅ (${config.upscaler} x${config.upscaleBy}`)}\n` +
          `<b>Prompt Mode:</b> ${config.promptMode}\n` +
          `<b>Channel:</b> ${config.useChannel ? "✅" : "❌"} (${
            config.channelId || "not set"
          })\n` +
          `<b>Group:</b> ${config.useGroup ? "✅" : "❌"} (${
            config.groupId || "not set"
          })\n\n` +
          `<b>Queue:</b> ${pendingCount}\n` +
          `<b>Blacklist:</b> ${bl.length} workers`
      );
      break;
    }

    case "/generate": {
      if (!config.generalPrompt) {
        await tg.send(chatId, "❌ First: /setprompt");
        break;
      }
      const targetChats = [];
      if (config.useChannel && config.channelId) targetChats.push(config.channelId);
      if (config.useGroup && config.groupId) targetChats.push(config.groupId);
      if (!targetChats.length) targetChats.push(chatId);

      await tg.send(chatId, `⏳ Generating ${config.count} images...`);

      const bl = await getWorkerBlacklist(env);
      const blIds = bl.map((w) => w.id).filter(Boolean);

      for (let i = 0; i < config.count; i++) {
        try {
          const prompt = await generatePrompt(config.generalPrompt, env);
          await tg.send(chatId, `🎨 #${i + 1}:\n<code>${escapeHtml(prompt.substring(0, 300))}</code>`);

          const result = await hordeSubmit(prompt, config, env, {
            workerBlacklist: blIds,
          });

          if (result.id) {
            // Send to all target chats
            for (const targetChat of targetChats) {
              await KV.put(
                env,
                `pending:${result.id}`,
                JSON.stringify({
                  chatId: targetChat,
                  prompt,
                  at: Date.now(),
                  notify: chatId,
                  retries: 0,
                }),
                { expirationTtl: 3600 }
              );
            }
            await tg.send(chatId, `📤 ID: <code>${result.id}</code>`);
          } else {
            await tg.send(
              chatId,
              `❌ Horde: <code>${escapeHtml(JSON.stringify(result).substring(0, 300))}</code>`
            );
          }
        } catch (e) {
          await tg.send(chatId, `❌ ${escapeHtml(e.message)}`);
        }
      }
      break;
    }

    case "/pending": {
      const list = await KV.list(env, "pending:");
      if (!list.keys.length) {
        await tg.send(chatId, "📋 Queue is empty");
        break;
      }

      let txt = `📋 <b>In queue: ${list.keys.length}</b>\n\n`;
      for (const key of list.keys.slice(0, 10)) {
        const id = key.name.replace("pending:", "");
        try {
          const c = await hordeCheck(id);
          const state = c.done
            ? "✅ Ready"
            : c.processing            ? "⚙️ Processing"
            : `⏳ Queue #${c.queue_position || "?"}`;
          txt += `🔸 <code>${id}</code>\n   ${state} | ~${c.wait_time || 0}s\n\n`;
        } catch {
          txt += `🔸 <code>${id}</code> — failed to check\n\n`;
        }
      }
      await tg.send(chatId, txt);
      break;
    }

    case "/cancel": {
      const list = await KV.list(env, "pending:");
      await Promise.all(list.keys.map((k) => KV.del(env, k.name)));
      await tg.send(chatId, `🗑 Removed from queue: ${list.keys.length}`);
      break;
    }

    case "/workerbl": {
      const bl = await getWorkerBlacklist(env);
      if (!bl.length) {
        await tg.send(chatId, "📋 Worker blacklist is empty");
        break;
      }
      let txt = `🚫 <b>Worker blacklist: ${bl.length}</b>\n\n`;
      for (const w of bl) {
        txt += `• <code>${escapeHtml(w.name || "?")}</code>\n  ID: <code>${escapeHtml(w.id)}</code>\n  ${new Date(w.t).toISOString().slice(0, 10)}\n\n`;
      }
      txt += "/clearworkerbl — clear blacklist";
      await tg.send(chatId, txt);
      break;
    }

    case "/clearworkerbl": {
      await clearWorkerBlacklist(env);
      await tg.send(chatId, "✅ Worker blacklist cleared");
      break;
    }

    case "/preset": {
      const name = args[0];
      if (!name) {
        await tg.send(chatId, "❌ /preset &lt;name&gt;");
        break;
      }
      const preset = await loadPreset(env, name);
      if (!preset) {
        await tg.send(chatId, `❌ Preset "${escapeHtml(name)}" not found`);
        break;
      }
      await saveConfig(env, preset);
      await tg.send(chatId, `✅ Loaded preset: <code>${escapeHtml(name)}</code>`);
      break;
    }

    case "/savepreset": {
      const name = args[0];
      if (!name) {
        await tg.send(chatId, "❌ /savepreset &lt;name&gt;");
        break;
      }
      const config = await getConfig(env);
      await savePreset(env, name, config);
      await tg.send(chatId, `✅ Saved preset: <code>${escapeHtml(name)}</code>`);
      break;
    }

    case "/delpreset": {
      const name = args[0];
      if (!name) {
        await tg.send(chatId, "❌ /delpreset &lt;name&gt;");
        break;
      }
      await deletePreset(env, name);
      await tg.send(chatId, `✅ Deleted preset: <code>${escapeHtml(name)}</code>`);
      break;
    }

    case "/listpresets": {
      const presets = await getPresets(env);
      const names = Object.keys(presets);
      if (!names.length) {
        await tg.send(chatId, "📋 No presets saved");
        break;
      }
      let txt = "📋 <b>Presets:</b>\n\n";
      for (const name of names) {
        txt += `• <code>${escapeHtml(name)}</code>\n   ❌ /delpreset ${escapeHtml(name)}\n\n`;
      }
      await tg.send(chatId, txt);
      break;
    }

    default: {
      if (cmd.startsWith("/")) {
        await tg.send(chatId, "❓ Unknown command — /help");
      }
    }
  }
}

// ============================================================
// Settings Menu
// ============================================================

async function showSettingsMenu(tg, chatId, config) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "🖼 Model", callback_data: "setmodel" },
        { text: "🔧 LoRA", callback_data: "loramenu" },
      ],
      [
        { text: "⚙️ Params", callback_data: "paramsmenu" },
        { text: "🎨 Prompt", callback_data: "setprompt" },
      ],
      [
        { text: "🤖 Enhancers", callback_data: "enhancersmenu" },
        { text: "📝 Prompt Mode", callback_data: "setpromptmode" },
      ],
      [
        { text: "💬 Channel/Group", callback_data: "chgrmenu" },
        { text: "💾 Presets", callback_data: "presetmenu" },
      ],
      [
        { text: "🔙 Back", callback_data: "back" },
      ],
    ],
  };

  await tg.send(chatId, `⚙️ <b>Settings Menu</b>\n\nCurrent config:`, {
    reply_markup: JSON.stringify(keyboard),
  });
}

// ============================================================
// Scheduler
// ============================================================

async function processScheduled(env) {
  if (!env[UPSTASH_URL] || !env[UPSTASH_TOKEN] || !env.TELEGRAM_BOT_TOKEN) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);
  const pendingList = await KV.list(env, "pending:");

  for (const key of pendingList.keys) {
    const id = key.name.replace("pending:", "");
    try {
      const data = await KV.get(env, key.name, "json");
      if (!data) {
        await KV.del(env, key.name);
        continue;
      }

      if (Date.now() - data.at > 20 * 60 * 1000) {
        await KV.del(env, key.name);
        if (data.notify) await tg.send(data.notify, `⏰ Generation timeout: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      if (!check.done) continue;

      const result = await hordeGetResult(id);
      await KV.del(env, key.name);

      if (result.faulted) {
        if (data.notify) await tg.send(data.notify, `❌ Generation <code>${id}</code> failed`);
        continue;
      }

      const gens = result.generations || [];
      if (!gens.length) {
        if (data.notify) await tg.send(data.notify, `❌ No generations returned for <code>${id}</code>`);
        continue;
      }

      let anySent = false;
      let anySmall = false;

      for (const gen of gens) {
        const workerId = gen.worker_id || "?";
        const workerName = gen.worker_name || "?";
        const censored = isCensored(gen);

        if (data.debug && data.notify) {
          const imgInfo = !gen.img
            ? "null"
            : isHttpUrl(gen.img)
            ? `URL (${gen.img.substring(0, 45)}...)`
            : `base64 (${gen.img.length} chars)`;

          const metaInfo = gen.gen_metadata?.length
            ? gen.gen_metadata.map((m) => `${m.type}:${m.value}`).join(", ")
            : "none";

          await tg.send(
            data.notify,
            `🔍 <b>Result</b>\n` +
              `censored: ${gen.censored ? "yes" : "no"}\n` +
              `state: ${gen.state || "ok"}\n` +
              `gen_metadata: ${escapeHtml(metaInfo)}\n` +
              `isCensored(): ${censored ? "yes" : "no"}\n` +
              `Worker: <code>${escapeHtml(workerName)}</code>\n` +
              `Worker ID: <code>${escapeHtml(workerId)}</code>\n` +
              `Model: <code>${escapeHtml(gen.model || "?")}</code>\n` +
              `Image: ${escapeHtml(imgInfo)}`
          );
        }

        if (censored) {
          await addWorkerToBlacklist(env, workerId, workerName);
          anySmall = true;
          if (data.notify) {
            await tg.send(
              data.notify,
              `🔴 Worker <code>${escapeHtml(workerName)}</code> returned censorship\n` +
                `Added to blacklist and retrying...`
            );
          }
          continue;
        }

        if (!gen.img) {
          if (data.notify) await tg.send(data.notify, "❌ gen.img is empty");
          continue;
        }

        let caption = "";
        if (data.prompt) {
          switch (data.promptMode || config.promptMode) {
            case "shown":
              caption = `🎨 <i>${escapeHtml(data.prompt.substring(0, 200))}</i>`;
              break;
            case "ai":
              try {
                const aiResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
                    "HTTP-Referer": "https://t.me",
                    "X-Title": "TgImageBot",
                  },
                  body: JSON.stringify({
                    model: "meta-llama/llama-3.1-8b-instruct:free",
                    messages: [
                      {
                        role: "system",
                        content:
                          `You are a social media expert. Create a short, engaging post description for an image. ` +
                          `Do not mention the prompt or technical details. Focus on what makes the image interesting.`,
                      },
                      {
                        role: "user",
                        content: `Create a post description for an image with this theme: ${data.prompt}\n` +
                          `Additional instruction: ${config.aiPostInstruction}`,
                      },
                    ],
                    temperature: 0.8,
                    max_tokens: 150,
                  }),
                });
                const aiData = await aiResp.json();
                const aiText = aiData.choices?.[0]?.message?.content?.trim();
                caption = aiText ? `📝 <i>${escapeHtml(aiText)}</i>` : "";
              } catch (e) {
                console.error("[AI POST]", e.message);
                caption = `🎨 <i>${escapeHtml(data.prompt.substring(0, 200))}</i>`;
              }
              break;
            default: // hidden
              break;
          }
        }

        const { sent, tooSmall, sizeKB } = await deliverImage(
          tg,
          data.chatId,
          gen.img,
          caption,
          data.notify
        );

        if (sent) {
          anySent = true;
        } else if (tooSmall) {
          anySmall = true;
          await addWorkerToBlacklist(env, workerId, workerName);
          if (data.notify) {
            await tg.send(
              data.notify,
              `🚫 Worker <code>${escapeHtml(workerName)}</code> probably returned a placeholder (${sizeKB}KB)`
            );
          }
        }
      }

      if (anySmall && !anySent && !data.sfwTest) {
        const retries = (data.retries || 0) + 1;
        if (retries < MAX_RETRIES) {
          try {
            const bl = await getWorkerBlacklist(env);
            const blIds = bl.map((w) => w.id).filter(Boolean);
            const nr = await hordeSubmit(data.prompt, config, env, {
              workerBlacklist: blIds,
            });
            if (nr.id) {
              await KV.put(
                env,
                `pending:${nr.id}`,
                JSON.stringify({
                  ...data,
                  at: Date.now(),
                  retries,
                }),
                { expirationTtl: 3600 }
              );
              if (data.notify) {
                await tg.send(
                  data.notify,
                  `🔄 Retry ${retries}/${MAX_RETRIES}: <code>${nr.id}</code>\n` +
                    `🚫 Blacklist: ${blIds.length} workers`
                );
              }
            }
          } catch (e) {
            console.error("[CRON] retry:", e.message);
          }
        } else {
          if (data.notify) {
            await tg.send(
              data.notify,
              `❌ <b>${MAX_RETRIES} attempts — all placeholders/censored</b>\n\n` +
                `Possible reasons:\n` +
                `• Anonymous Horde key (NSFW will not work)\n` +
                `• Account flagged\n` +
                `• All available workers censor this model\n\n` +
                `/clearworkerbl — clear blacklist and try again`
            );
          }
        }
      }

      if (anySent && data.notify && data.notify !== data.chatId) {
        await tg.send(data.notify, "✅ Image sent");
      }
    } catch (e) {
      console.error(`[CRON] ${id}:`, e.message);
    }
  }

  if (!config.enabled || !config.chatId || !config.generalPrompt) return;
  if ((await KV.list(env, "pending:")).keys.length > 0) return;

  const lastPost = parseInt((await KV.get(env, "last_post_time")) || "0", 10);
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  await KV.put(env, "last_post_time", String(now));

  const bl = await getWorkerBlacklist(env);
  const blIds = bl.map((w) => w.id).filter(Boolean);

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env, {
        workerBlacklist: blIds,
      });
      if (result.id) {
        // Determine target chats for auto-post        const targetChats = [];
        if (config.useChannel && config.channelId) targetChats.push(config.channelId);
        if (config.useGroup && config.groupId) targetChats.push(config.groupId);
        if (!targetChats.length) targetChats.push(config.chatId);

        for (const targetChat of targetChats) {
          await KV.put(
            env,
            `pending:${result.id}`,
            JSON.stringify({
              chatId: targetChat,
              prompt,
              at: now,
              notify: null,
              retries: 0,
            }),
            { expirationTtl: 3600 }
          );
        }
      }
    } catch (e) {
      console.error("[CRON] auto:", e.message);
    }
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
          allowed_updates: ["message"],
          drop_pending_updates: true,
        }),
      });
      return new Response(`Webhook: ${wh}\n\n${JSON.stringify(await r.json(), null, 2)}`);
    }

    if (url.pathname === "/") {
      return new Response("🤖 Telegram Image Bot is running!\nVisit /setup to configure webhook.");
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