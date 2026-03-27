const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:15.0:tg" };
const MIN_IMAGE_KB = 10;
const MAX_RETRIES = 3;
const OPENROUTER_FREE_MODEL = "google/gemma-2-9b-it:free";

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
  cfgScale: 6,
  sampler: "k_dpmpp_2m",
  clipSkip: 2,
  karras: true,
  nsfw: true,
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",

  hiresFix: false,
  hiresFixDenoising: 0.65,

  postProcessing: [],
  faceFix: false,
  upscale: null,

  captionMode: 1, // 0 = none, 1 = prompt, 2 = AI text
  captionPrompt: "Сделай короткую красивую подпись для телеграм-поста на русском языке.",
  llmModel: OPENROUTER_FREE_MODEL,

  // optional helpers
  promptRewriteMode: false,
  promptRewriteInstruction: "",
};

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toInt(v, fallback = 0) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(v, fallback = 0) {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

function isHttpUrl(v) {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

function normalize64(n) {
  return clamp(Math.round(n / 64) * 64, 256, 2048);
}

function unique(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function parseArgs(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

async function jsonOrText(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  return await res.text();
}

class Telegram {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async api(method, body) {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  }

  async send(chatId, text, extra = {}) {
    return await this.api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async sendPhotoUrl(chatId, url, caption = "") {
    return await this.api("sendPhoto", {
      chat_id: chatId,
      photo: url,
      caption: caption ? caption.substring(0, 1024) : undefined,
      parse_mode: caption ? "HTML" : undefined,
    });
  }

  async sendPhotoBuffer(chatId, buffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    form.append("photo", new Blob([buffer], { type: "image/webp" }), "image.webp");
    const res = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
    return await res.json();
  }

  async sendDocumentBuffer(chatId, buffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    form.append("document", new Blob([buffer], { type: "image/webp" }), "image.webp");
    const res = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form });
    return await res.json();
  }
}

async function redisCall(env, command, args = []) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Upstash Redis env vars are missing");
  }
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command: [command, ...args] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

const KV = {
  async get(env, key, type = "json") {
    try {
      if (env.BOT_KV?.get) return await env.BOT_KV.get(key, type);
      const raw = await redisCall(env, "GET", [key]);
      if (raw == null) return null;
      if (type === "text") return raw;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    } catch {
      return null;
    }
  },

  async put(env, key, value, opts = {}) {
    if (env.BOT_KV?.put) return await env.BOT_KV.put(key, value, opts);
    const args = [key, String(value)];
    if (opts.expirationTtl) {
      await redisCall(env, "SETEX", [key, String(opts.expirationTtl), String(value)]);
      return;
    }
    await redisCall(env, "SET", args);
  },

  async del(env, key) {
    if (env.BOT_KV?.delete) return await env.BOT_KV.delete(key);
    return await redisCall(env, "DEL", [key]);
  },

  async list(env, prefix) {
    if (env.BOT_KV?.list) return await env.BOT_KV.list({ prefix });
    const keys = await redisCall(env, "KEYS", [`${prefix}*`]);
    return { keys: (keys || []).map((name) => ({ name })) };
  },
};

async function getConfig(env) {
  const cfg = await KV.get(env, "config", "json");
  return { ...DEFAULT_CONFIG, ...(cfg || {}) };
}

async function saveConfig(env, cfg) {
  await KV.put(env, "config", cfg);
}

async function getWorkerBlacklist(env) {
  return (await KV.get(env, "worker_blacklist", "json")) || [];
}

async function addWorkerToBlacklist(env, id, name) {
  if (!id || id === "?" || String(id).length < 8) return;
  const list = await getWorkerBlacklist(env);
  if (!list.some((w) => w.id === id)) {
    list.push({ id, name: name || "?", t: Date.now() });
    while (list.length > 30) list.shift();
    await KV.put(env, "worker_blacklist", list);
  }
}

async function clearWorkerBlacklist(env) {
  await KV.put(env, "worker_blacklist", []);
}

function getApiKey(env) {
  return (env.HORDE_API_KEY || "").trim() || "0000000000";
}

function isCensored(gen) {
  if (!gen) return true;
  if (gen.censored === true) return true;
  if (String(gen.state || "").toLowerCase() === "censored") return true;
  if (Array.isArray(gen.gen_metadata)) {
    if (gen.gen_metadata.some((m) => String(m?.type || "").toLowerCase() === "censorship")) return true;
  }
  return false;
}

async function hordeCheckKey(env) {
  const key = getApiKey(env);
  try {
    const res = await fetch(`${HORDE_API}/find_user`, {
      headers: { apikey: key, ...HORDE_HEADERS },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, anon: key === "0000000000", err: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return {
      ok: true,
      anon: key === "0000000000",
      user: data.username,
      kudos: data.kudos,
      trusted: data.trusted,
      flagged: data.flagged,
    };
  } catch (e) {
    return { ok: false, anon: key === "0000000000", err: e.message };
  }
}

async function hordeGetModels() {
  const res = await fetch(`${HORDE_API}/status/models?type=image`, { headers: HORDE_HEADERS });
  return await res.json();
}

async function hordeCheck(id) {
  const res = await fetch(`${HORDE_API}/generate/check/${id}`, { headers: HORDE_HEADERS });
  return await res.json();
}

async function hordeGetResult(id) {
  const res = await fetch(`${HORDE_API}/generate/status/${id}`, { headers: HORDE_HEADERS });
  return await res.json();
}

function parsePromptCommands(prompt, cfg) {
  const out = { ...cfg, postProcessing: [...(cfg.postProcessing || [])] };
  let text = String(prompt || "");

  const matches = [...text.matchAll(/\[(.*?)\]/g)].map((m) => m[1].trim());
  text = text.replace(/\[(.*?)\]/g, "").trim();

  for (const raw of matches) {
    const cmd = raw.trim();
    const lower = cmd.toLowerCase();

    if (lower.startsWith("model:")) out.model = cmd.slice(6).trim();
    else if (lower.startsWith("cfg:")) out.cfgScale = toFloat(cmd.slice(4), out.cfgScale);
    else if (lower.startsWith("steps:")) out.steps = toInt(cmd.slice(6), out.steps);
    else if (lower.startsWith("sampler:")) out.sampler = cmd.slice(8).trim();
    else if (lower.startsWith("width:")) out.width = normalize64(toInt(cmd.slice(6), out.width));
    else if (lower.startsWith("height:")) out.height = normalize64(toInt(cmd.slice(7), out.height));
    else if (lower.startsWith("size:")) {
      const m = cmd.slice(5).trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
      if (m) {
        out.width = normalize64(toInt(m[1], out.width));
        out.height = normalize64(toInt(m[2], out.height));
      }
    } else if (lower.startsWith("clip:")) out.clipSkip = toInt(cmd.slice(5), out.clipSkip);
    else if (lower === "facefix") out.faceFix = true;
    else if (lower === "nofacefix") out.faceFix = false;
    else if (lower === "hires") out.hiresFix = true;
    else if (lower === "nohires") out.hiresFix = false;
    else if (lower.startsWith("denoise:")) out.hiresFixDenoising = clamp(toFloat(cmd.slice(8), out.hiresFixDenoising), 0.05, 1);
    else if (lower.startsWith("upscale:")) out.upscale = cmd.slice(8).trim();
    else if (lower.startsWith("pp:")) {
      const vals = cmd.slice(3).split(",").map((s) => s.trim()).filter(Boolean);
      out.postProcessing = unique(vals);
    } else if (lower.startsWith("no:")) {
      const n = cmd.slice(3).trim();
      if (n) out.negativePrompt = [out.negativePrompt, n].filter(Boolean).join(", ");
    } else if (lower.startsWith("neg:")) {
      out.negativePrompt = cmd.slice(4).trim();
    }
  }

  return { prompt: text, cfg: out };
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.arrayBuffer();
}

function base64ToBuffer(b64) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  } catch {
    return null;
  }
}

function bufferSizeKB(buf) {
  return Math.round(buf.byteLength / 1024);
}

async function deliverImage(tg, chatId, img, caption = "", notifyChatId = null) {
  if (!img) {
    if (notifyChatId) await tg.send(notifyChatId, "❌ Нет данных картинки от воркера");
    return { sent: false, tooSmall: false, sizeKB: 0 };
  }

  let buffer = null;
  const isUrl = isHttpUrl(img);

  if (isUrl) {
    buffer = await downloadImage(img);
  } else {
    buffer = base64ToBuffer(img);
  }

  if (!buffer) {
    if (isUrl) {
      const r = await tg.sendPhotoUrl(chatId, img, caption);
      return { sent: !!r.ok, tooSmall: false, sizeKB: 0 };
    }
    return { sent: false, tooSmall: false, sizeKB: 0 };
  }

  const kb = bufferSizeKB(buffer);
  if (kb < MIN_IMAGE_KB) {
    if (notifyChatId) {
      await tg.send(notifyChatId, `🚫 <b>Похоже на заглушку/цензуру</b>\nРазмер: <code>${kb} KB</code>`);
    }
    return { sent: false, tooSmall: true, sizeKB: kb };
  }

  let res = await tg.sendPhotoBuffer(chatId, buffer, caption);
  if (!res.ok) {
    res = await tg.sendDocumentBuffer(chatId, buffer, caption);
  }
  if (!res.ok && isUrl) {
    res = await tg.sendPhotoUrl(chatId, img, caption);
  }
  if (!res.ok && notifyChatId) {
    await tg.send(notifyChatId, `❌ Не удалось отправить изображение: <code>${esc(res.description || "unknown error")}</code>`);
  }
  return { sent: !!res.ok, tooSmall: false, sizeKB: kb };
}

function choose(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function chooseN(arr, n) {
  const copy = [...arr].sort(() => Math.random() - 0.5);
  return copy.slice(0, n);
}

const PROMPT_BANK = {
  angle: ["from above", "low angle", "eye level", "dutch angle", "bird's-eye view", "over the shoulder"],
  light: ["golden hour sunlight", "blue hour twilight", "soft overcast light", "neon cyberpunk glow", "studio rim lighting", "moonlit night"],
  style: ["photorealistic photography", "digital concept art", "anime cel shading", "dark fantasy illustration", "hyperrealistic render", "cinematic film still"],
  mood: ["serene and peaceful", "intense and dramatic", "mysterious and enigmatic", "vibrant and energetic", "ethereal and dreamlike", "warm and intimate"],
  detail: ["intricate details", "crisp focus", "beautiful bokeh", "reflections and refractions", "weathered texture", "dynamic motion"],
};

function templatePrompt(base) {
  return [
    base,
    choose(PROMPT_BANK.angle),
    choose(PROMPT_BANK.light),
    choose(PROMPT_BANK.style),
    choose(PROMPT_BANK.mood),
    ...chooseN(PROMPT_BANK.detail, 2),
    "masterpiece",
    "best quality",
    "highly detailed",
  ].join(", ");
}

async function llmRewrite(env, task, userPrompt, cfg) {
  if (!env.OPENROUTER_API_KEY) return templatePrompt(userPrompt);

  const model = cfg.llmModel || OPENROUTER_FREE_MODEL;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://t.me",
        "X-Title": "TgImageBot",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: task,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        temperature: 1.1,
        max_tokens: 220,
      }),
    });

    const data = await res.json();
    const out = data.choices?.[0]?.message?.content?.trim();
    if (out && out.length > 5) return out.replace(/^["'`]+|["'`]+$/g, "");
  } catch (e) {
    console.error("[LLM]", e.message);
  }

  return templatePrompt(userPrompt);
}

async function buildPrompt(env, cfg, basePrompt) {
  const parsed = parsePromptCommands(basePrompt, cfg);
  let prompt = parsed.prompt;
  const nextCfg = parsed.cfg;

  if (nextCfg.promptRewriteMode && env.OPENROUTER_API_KEY) {
    const task =
      nextCfg.promptRewriteInstruction?.trim() ||
      "You are a prompt engineer for image generation. Rewrite the prompt, applying all requested changes, keeping it concise and effective. Output only the final prompt, no explanations.";
    prompt = await llmRewrite(env, task, prompt, nextCfg);
  } else if (env.OPENROUTER_API_KEY) {
    prompt = await llmRewrite(
      env,
      "You are a Stable Diffusion prompt engineer. Expand the prompt into a better image-generation prompt. Output only descriptive phrases, comma-separated, no markdown.",
      prompt,
      nextCfg
    );
  } else {
    prompt = templatePrompt(prompt);
  }

  return { prompt, cfg: nextCfg };
}

function modelListToText(list, q = "") {
  const query = q.trim().toLowerCase();
  const items = (Array.isArray(list) ? list : [])
    .filter((m) => !query || String(m.name || "").toLowerCase().includes(query))
    .sort((a, b) => (b.count || 0) - (a.count || 0));

  let text = `📋 <b>Models</b>${query ? ` for <code>${esc(q)}</code>` : ""}\n\n`;
  for (const m of items.slice(0, 30)) {
    const name = m.name || "?";
    const count = m.count ?? 0;
    const type = /sdxl|xl/i.test(name) ? "🟢" : "⚪";
    text += `${type} <code>${esc(name)}</code> — <b>${count}</b>\n`;
  }
  return text + "\nИспользуй /setmodel <name> или /pickmodel <query>";
}

async function searchLoras(query) {
  const url = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(query)}&limit=10&sort=Highest%20Rated&nsfw=true`;
  const res = await fetch(url);
  return await res.json();
}

async function hordeSubmit(prompt, cfg, env, opts = {}) {
  const key = getApiKey(env);
  const payload = {
    prompt: cfg.negativePrompt ? `${prompt} ### ${cfg.negativePrompt}` : prompt,
    params: {
      sampler_name: cfg.sampler,
      cfg_scale: cfg.cfgScale,
      width: cfg.width,
      height: cfg.height,
      steps: cfg.steps,
      clip_skip: cfg.clipSkip || 2,
      karras: cfg.karras !== false,
      tiling: false,
      post_processing: [...(cfg.postProcessing || [])],
      n: 1,
    },
    nsfw: cfg.nsfw !== false,
    censor_nsfw: false,
    trusted_workers: false,
    replacement_filter: true,
    models: [cfg.model],
    shared: false,
    r2: true,
    allow_downgrade: true,
  };

  if (cfg.hiresFix) {
    payload.params.hires_fix = true;
    payload.params.hires_fix_denoising_strength = clamp(cfg.hiresFixDenoising ?? 0.65, 0.05, 1);
  }

  if (cfg.faceFix) payload.params.post_processing = unique([...(payload.params.post_processing || []), "GFPGAN"]);
  if (cfg.upscale) payload.params.post_processing = unique([...(payload.params.post_processing || []), cfg.upscale]);

  if (!opts.skipLoras && cfg.loras?.length) {
    payload.loras = cfg.loras.map((l) => ({
      name: String(l.name),
      model: l.strength ?? 1,
      clip: l.clip ?? 1,
      inject_trigger: "any",
      is_version: true,
    }));
  }

  if (opts.workerBlacklist?.length) {
    payload.workers = opts.workerBlacklist.slice(0, 5);
    payload.worker_blacklist = true;
  }

  const res = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      ...HORDE_HEADERS,
    },
    body: JSON.stringify(payload),
  });

  return await res.json();
}

function commandHelp() {
  return `
🤖 <b>Image Bot</b>

<b>База:</b>
/setchat — группа для автопостов
/setchannel — канал для автопостов
/clearchannel — отвязать канал
/setprompt <text> — основной промпт
/setinterval <min> — интервал
/setcount <1-10> — количество
/enable | /disable — автопостинг
/generate — генерация вручную

<b>Модели и LoRA:</b>
/listmodels — список моделей
/searchmodels <query> — поиск моделей
/setmodel <name> — выбрать модель
/searchlora <query> — поиск LoRA
/addlora <version_id> [strength] [clip]
/removelora <id> | /listloras

<b>Параметры:</b>
/setsize <W> <H>
/setsteps <N>
/setcfg <N>
/setsampler <name>
/setneg <text>
/setclipskip <1-4>
/setllm <model_id>
/setcaptionmode <0|1|2>
/setcaptionprompt <text>
/setrewrite <text>
/togglepromptrewrite

<b>Horde extras:</b>
/setfacefix <on|off>
/setupscale <name|off>
/addpp <name>
/delpp <name>
/listpp
/sethires <on|off> [denoise]

<b>Управление:</b>
/status | /pending | /cancel
/workerbl | /clearworkerbl
/checkkey | /diagnostic | /testimg | /testsfw

<b>Bracket-команды в промпте:</b>
<code>[model:...][/model]</code> <code>[cfg:7]</code> <code>[steps:30]</code> <code>[sampler:k_dpmpp_2m]</code>
<code>[size:1024x1536]</code> <code>[facefix]</code> <code>[hires]</code> <code>[no:blurry]</code> <code>[pp:GFPGAN,RealESRGAN_x4plus]</code>
`.trim();
}

async function handleCommand(update, env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const msg = update.message || update.edited_message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text.trim();
  const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const args = parseArgs(text).slice(1);

  let cfg = await getConfig(env);

  if (!cfg.adminId) {
    cfg.adminId = userId;
    await saveConfig(env, cfg);
    await tg.send(chatId, `👑 Вы назначены админом.\nID: <code>${userId}</code>`);
  }

  if (cfg.adminId !== userId) {
    await tg.send(chatId, `🔒 Только админ.\nID: <code>${cfg.adminId}</code>`);
    return;
  }

  try {
    if (cmd === "/start" || cmd === "/help") {
      await tg.send(chatId, commandHelp());
      return;
    }

    if (cmd === "/ping") {
      const info = await hordeCheckKey(env);
      await tg.send(
        chatId,
        `🏓 <b>Pong</b>\n\nChat: <code>${chatId}</code>\nUser: <code>${userId}</code>\nKV: ${env.UPSTASH_REDIS_REST_URL ? "Upstash" : env.BOT_KV ? "KV" : "none"}\nHorde: ${info.anon ? "anonymous" : "key"}\nOpenRouter: ${env.OPENROUTER_API_KEY ? "yes" : "no"}`
      );
      return;
    }

    if (cmd === "/diagnostic") {
      const bl = await getWorkerBlacklist(env);
      const pending = await KV.list(env, "pending:");
      await tg.send(
        chatId,
        `🔧 <b>Diagnostics</b>\n\nChat: <code>${chatId}</code>\nAdmin: <code>${cfg.adminId}</code>\nPending: <b>${pending.keys.length}</b>\nBlacklist: <b>${bl.length}</b>\nChannel: <code>${cfg.channelId || "—"}</code>\nGroup: <code>${cfg.chatId || "—"}</code>\nOpenRouter: ${env.OPENROUTER_API_KEY ? "yes" : "no"}`
      );
      return;
    }

    if (cmd === "/checkkey") {
      await tg.send(chatId, "🔑 Checking Horde key...");
      const info = await hordeCheckKey(env);
      if (!info.ok) {
        await tg.send(chatId, `❌ <b>Invalid key</b>\n<code>${esc(info.err || "unknown")}</code>`);
        return;
      }
      await tg.send(
        chatId,
        `${info.anon ? "🔴" : "✅"} <b>${esc(info.user || "anonymous")}</b>\n\nKudos: <b>${info.kudos || 0}</b>\nTrusted: <b>${info.trusted ? "yes" : "no"}</b>\nFlagged: <b>${info.flagged ? "yes" : "no"}</b>`
      );
      return;
    }

    if (cmd === "/setchat") {
      cfg.chatId = chatId;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Group chat set: <code>${chatId}</code>`);
      return;
    }

    if (cmd === "/setchannel") {
      const v = args[0];
      if (!v) {
        await tg.send(chatId, "❌ /setchannel <channel_id|@channel_username>");
        return;
      }
      cfg.channelId = v;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Channel set: <code>${esc(v)}</code>`);
      return;
    }

    if (cmd === "/clearchannel") {
      cfg.channelId = null;
      await saveConfig(env, cfg);
      await tg.send(chatId, "✅ Channel detached");
      return;
    }

    if (cmd === "/setprompt") {
      const prompt = text.replace(/^\/setprompt(@\w+)?\s*/i, "").trim();
      if (!prompt) {
        await tg.send(chatId, "❌ /setprompt <text>");
        return;
      }
      cfg.generalPrompt = prompt;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Prompt saved:\n<code>${esc(prompt)}</code>`);
      return;
    }

    if (cmd === "/setrewrite") {
      cfg.promptRewriteInstruction = text.replace(/^\/setrewrite(@\w+)?\s*/i, "").trim();
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Rewrite instruction:\n<code>${esc(cfg.promptRewriteInstruction || "—")}</code>`);
      return;
    }

    if (cmd === "/togglepromptrewrite") {
      cfg.promptRewriteMode = !cfg.promptRewriteMode;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Prompt rewrite mode: <b>${cfg.promptRewriteMode ? "ON" : "OFF"}</b>`);
      return;
    }

    if (cmd === "/setinterval") {
      const n = toInt(args[0], 0);
      if (n < 1) {
        await tg.send(chatId, "❌ /setinterval <minutes> (min 1)");
        return;
      }
      cfg.interval = n;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Interval: <b>${n}</b> min`);
      return;
    }

    if (cmd === "/setcount") {
      const n = toInt(args[0], 0);
      if (n < 1 || n > 10) {
        await tg.send(chatId, "❌ /setcount <1-10>");
        return;
      }
      cfg.count = n;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Count: <b>${n}</b>`);
      return;
    }

    if (cmd === "/setmodel") {
      const model = text.replace(/^\/setmodel(@\w+)?\s*/i, "").trim();
      if (!model) {
        await tg.send(chatId, "❌ /setmodel <name>\nUse /listmodels or /searchmodels");
        return;
      }
      cfg.model = model;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Model: <code>${esc(model)}</code>`);
      return;
    }

    if (cmd === "/listmodels" || cmd === "/searchmodels") {
      await tg.send(chatId, "⏳ Loading models...");
      const data = await hordeGetModels();
      const list = Array.isArray(data) ? data : (data.models || []);
      const q = cmd === "/searchmodels" ? text.replace(/^\/searchmodels(@\w+)?\s*/i, "").trim() : "";
      await tg.send(chatId, modelListToText(list, q));
      return;
    }

    if (cmd === "/searchlora") {
      const q = text.replace(/^\/searchlora(@\w+)?\s*/i, "").trim();
      if (!q) {
        await tg.send(chatId, "❌ /searchlora <query>");
        return;
      }
      await tg.send(chatId, "🔍 Searching LoRA...");
      const data = await searchLoras(q);
      const items = data.items || [];
      if (!items.length) {
        await tg.send(chatId, "😕 Nothing found");
        return;
      }
      let out = `🔍 <b>LoRA search: ${esc(q)}</b>\n\n`;
      for (const item of items.slice(0, 10)) {
        const ver = item.modelVersions?.[0];
        out += `${item.nsfw ? "🔞" : "✅"} <b>${esc(item.name)}</b>\n`;
        out += `Base: <code>${esc(ver?.baseModel || "?")}</code>\n`;
        out += `Version ID: <code>${esc(ver?.id || "?")}</code>\n`;
        out += `Add: <code>/addlora ${esc(ver?.id || "?")} 0.8 1</code>\n\n`;
      }
      await tg.send(chatId, out);
      return;
    }

    if (cmd === "/addlora") {
      const id = args[0];
      if (!id) {
        await tg.send(chatId, "❌ /addlora <version_id> [strength=0.8] [clip=1]");
        return;
      }
      const strength = clamp(toFloat(args[1], 0.8), 0.1, 2);
      const clip = clamp(toFloat(args[2], 1), 0, 2);
      cfg.loras = (cfg.loras || []).filter((l) => String(l.name) !== String(id));
      cfg.loras.push({ name: id, strength, clip });
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ LoRA added:\n<code>${esc(id)}</code>\nstrength: <b>${strength}</b>\nclip: <b>${clip}</b>`);
      return;
    }

    if (cmd === "/removelora") {
      const id = args[0];
      if (!id) {
        await tg.send(chatId, "❌ /removelora <id>");
        return;
      }
      cfg.loras = (cfg.loras || []).filter((l) => String(l.name) !== String(id));
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ LoRA removed: <code>${esc(id)}</code>`);
      return;
    }

    if (cmd === "/listloras") {
      const list = cfg.loras || [];
      if (!list.length) {
        await tg.send(chatId, "📋 LoRA list is empty");
        return;
      }
      let out = "📋 <b>Your LoRA</b>\n\n";
      for (const l of list) {
        out += `• <code>${esc(l.name)}</code> — str: <b>${l.strength}</b>, clip: <b>${l.clip}</b>\n`;
      }
      await tg.send(chatId, out);
      return;
    }

    if (cmd === "/setsize") {
      const w = toInt(args[0], 0);
      const h = toInt(args[1], 0);
      if (w < 256 || h < 256 || w > 2048 || h > 2048) {
        await tg.send(chatId, "❌ /setsize <W> <H> (256-2048)");
        return;
      }
      cfg.width = normalize64(w);
      cfg.height = normalize64(h);
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Size: <b>${cfg.width}×${cfg.height}</b>`);
      return;
    }

    if (cmd === "/setsteps") {
      const n = toInt(args[0], 0);
      if (n < 1 || n > 150) {
        await tg.send(chatId, "❌ /setsteps <1-150>");
        return;
      }
      cfg.steps = n;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Steps: <b>${n}</b>`);
      return;
    }

    if (cmd === "/setcfg") {
      const n = toFloat(args[0], 0);
      if (n < 1 || n > 30) {
        await tg.send(chatId, "❌ /setcfg <1-30>");
        return;
      }
      cfg.cfgScale = n;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ CFG: <b>${n}</b>`);
      return;
    }

    if (cmd === "/setsampler") {
      const sampler = args[0];
      const samplers = ["k_euler", "k_euler_a", "k_lms", "k_heun", "k_dpm_2", "k_dpm_2_a", "k_dpmpp_2s_a", "k_dpmpp_2m", "k_dpmpp_sde", "DDIM"];
      if (!sampler || !samplers.includes(sampler)) {
        await tg.send(chatId, `❌ Available samplers:\n${samplers.map((s) => `<code>${s}</code>`).join("\n")}`);
        return;
      }
      cfg.sampler = sampler;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Sampler: <code>${esc(sampler)}</code>`);
      return;
    }

    if (cmd === "/setneg") {
      cfg.negativePrompt = text.replace(/^\/setneg(@\w+)?\s*/i, "").trim() || DEFAULT_CONFIG.negativePrompt;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Negative:\n<code>${esc(cfg.negativePrompt)}</code>`);
      return;
    }

    if (cmd === "/setclipskip") {
      const n = toInt(args[0], 0);
      if (n < 1 || n > 4) {
        await tg.send(chatId, "❌ /setclipskip <1-4>");
        return;
      }
      cfg.clipSkip = n;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ CLIP Skip: <b>${n}</b>`);
      return;
    }

    if (cmd === "/setllm") {
      const model = text.replace(/^\/setllm(@\w+)?\s*/i, "").trim();
      if (!model) {
        await tg.send(
          chatId,
          `❌ /setllm <model_id>\n\nFree examples:\n<code>google/gemma-2-9b-it:free</code>\n<code>meta-llama/llama-3.1-8b-instruct:free</code>\n<code>mistralai/mistral-7b-instruct:free</code>\n<code>qwen/qwen-2-7b-instruct:free</code>`
        );
        return;
      }
      cfg.llmModel = model;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ LLM: <code>${esc(model)}</code>`);
      return;
    }

    if (cmd === "/setcaptionmode") {
      const n = toInt(args[0], -1);
      if (![0, 1, 2].includes(n)) {
        await tg.send(chatId, "❌ /setcaptionmode <0|1|2>\n0 = no caption\n1 = prompt\n2 = AI text");
        return;
      }
      cfg.captionMode = n;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Caption mode: <b>${n}</b>`);
      return;
    }

    if (cmd === "/setcaptionprompt") {
      const v = text.replace(/^\/setcaptionprompt(@\w+)?\s*/i, "").trim();
      if (!v) {
        await tg.send(chatId, "❌ /setcaptionprompt <text>");
        return;
      }
      cfg.captionPrompt = v;
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Caption prompt saved:\n<code>${esc(v)}</code>`);
      return;
    }

    if (cmd === "/setfacefix") {
      const v = (args[0] || "").toLowerCase();
      cfg.faceFix = ["on", "1", "true", "yes", "enable"].includes(v);
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Face fix: <b>${cfg.faceFix ? "ON" : "OFF"}</b>`);
      return;
    }

    if (cmd === "/setupscale") {
      const v = args[0];
      if (!v || v.toLowerCase() === "off") {
        cfg.upscale = null;
      } else {
        cfg.upscale = v;
      }
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Upscale: <b>${esc(cfg.upscale || "OFF")}</b>`);
      return;
    }

    if (cmd === "/sethires") {
      const v = (args[0] || "").toLowerCase();
      cfg.hiresFix = ["on", "1", "true", "yes", "enable"].includes(v);
      if (args[1]) cfg.hiresFixDenoising = clamp(toFloat(args[1], cfg.hiresFixDenoising), 0.05, 1);
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Hires fix: <b>${cfg.hiresFix ? "ON" : "OFF"}</b>\nDenoise: <b>${cfg.hiresFixDenoising}</b>`);
      return;
    }

    if (cmd === "/addpp") {
      const name = args.join(" ").trim();
      if (!name) {
        await tg.send(chatId, "❌ /addpp <postprocessing_name>");
        return;
      }
      cfg.postProcessing = unique([...(cfg.postProcessing || []), name]);
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Added PP: <code>${esc(name)}</code>`);
      return;
    }

    if (cmd === "/delpp") {
      const name = args.join(" ").trim();
      if (!name) {
        await tg.send(chatId, "❌ /delpp <postprocessing_name>");
        return;
      }
      cfg.postProcessing = (cfg.postProcessing || []).filter((x) => String(x) !== String(name));
      await saveConfig(env, cfg);
      await tg.send(chatId, `✅ Removed PP: <code>${esc(name)}</code>`);
      return;
    }

    if (cmd === "/listpp") {
      const list = cfg.postProcessing || [];
      await tg.send(chatId, `📋 <b>Post-processing</b>\n\n${list.length ? list.map((x) => `• <code>${esc(x)}</code>`).join("\n") : "empty"}`);
      return;
    }

    if (cmd === "/enable") {
      if (!cfg.chatId) {
        await tg.send(chatId, "❌ First set group: /setchat");
        return;
      }
      if (!cfg.generalPrompt) {
        await tg.send(chatId, "❌ First set prompt: /setprompt");
        return;
      }
      cfg.enabled = true;
      await saveConfig(env, cfg);
      await tg.send(chatId, `🟢 Autoposting enabled\nInterval: <b>${cfg.interval}</b> min\nCount: <b>${cfg.count}</b>`);
      return;
    }

    if (cmd === "/disable") {
      cfg.enabled = false;
      await saveConfig(env, cfg);
      await tg.send(chatId, "🔴 Autoposting disabled");
      return;
    }

    if (cmd === "/status") {
      const pending = await KV.list(env, "pending:");
      const bl = await getWorkerBlacklist(env);
      const loras = (cfg.loras || []).map((l) => `• <code>${esc(l.name)}</code> (str: ${l.strength}, clip: ${l.clip})`).join("\n") || "none";
      const pps = (cfg.postProcessing || []).map((x) => `• <code>${esc(x)}</code>`).join("\n") || "none";
      await tg.send(
        chatId,
        `📊 <b>Status</b>\n\nAutopost: <b>${cfg.enabled ? "ON" : "OFF"}</b>\nGroup: <code>${esc(cfg.chatId || "—")}</code>\nChannel: <code>${esc(cfg.channelId || "—")}</code>\nInterval: <b>${cfg.interval}</b> min\nCount: <b>${cfg.count}</b>\n\nPrompt:\n<code>${esc(cfg.generalPrompt || "—")}</code>\n\nModel: <code>${esc(cfg.model)}</code>\nSize: <b>${cfg.width}×${cfg.height}</b>\nSteps: <b>${cfg.steps}</b> | CFG: <b>${cfg.cfgScale}</b>\nSampler: <code>${esc(cfg.sampler)}</code>\nCLIP Skip: <b>${cfg.clipSkip}</b>\nNSFW: <b>${cfg.nsfw ? "yes" : "no"}</b>\nHires: <b>${cfg.hiresFix ? "yes" : "no"}</b>\nFaceFix: <b>${cfg.faceFix ? "yes" : "no"}</b>\nUpscale: <code>${esc(cfg.upscale || "—")}</code>\nCaption mode: <b>${cfg.captionMode}</b>\nLLM: <code>${esc(cfg.llmModel || "—")}</code>\n\nLoRA:\n${loras}\n\nPP:\n${pps}\n\nPending: <b>${pending.keys.length}</b>\nBlacklist: <b>${bl.length}</b>`
      );
      return;
    }

    if (cmd === "/pending") {
      const pending = await KV.list(env, "pending:");
      if (!pending.keys.length) {
        await tg.send(chatId, "📋 Queue is empty");
        return;
      }
      let out = `📋 <b>In queue: ${pending.keys.length}</b>\n\n`;
      for (const k of pending.keys.slice(0, 10)) {
        const id = k.name.replace("pending:", "");
        try {
          const chk = await hordeCheck(id);
          out += `🔸 <code>${esc(id)}</code>\n   ${chk.done ? "✅ Ready" : chk.processing ? "⚙️ Processing" : `⏳ Queue #${chk.queue_position || "?"}`}\n\n`;
        } catch {
          out += `🔸 <code>${esc(id)}</code> — failed to check\n\n`;
        }
      }
      await tg.send(chatId, out);
      return;
    }

    if (cmd === "/cancel") {
      const pending = await KV.list(env, "pending:");
      for (const k of pending.keys) {
        await KV.del(env, k.name);
      }
      await tg.send(chatId, `🗑 Removed from queue: <b>${pending.keys.length}</b>`);
      return;
    }

    if (cmd === "/workerbl") {
      const bl = await getWorkerBlacklist(env);
      if (!bl.length) {
        await tg.send(chatId, "📋 Worker blacklist is empty");
        return;
      }
      let out = `🚫 <b>Worker blacklist: ${bl.length}</b>\n\n`;
      for (const w of bl) {
        out += `• <code>${esc(w.name || "?")}</code>\n  ID: <code>${esc(w.id)}</code>\n  ${new Date(w.t).toISOString().slice(0, 10)}\n\n`;
      }
      await tg.send(chatId, out);
      return;
    }

    if (cmd === "/clearworkerbl") {
      await clearWorkerBlacklist(env);
      await tg.send(chatId, "✅ Worker blacklist cleared");
      return;
    }

    if (cmd === "/testimg") {
      await tg.send(chatId, "🧪 Testing image sending...");
      const urlRes = await tg.sendPhotoUrl(chatId, "https://picsum.photos/512/512", "URL test");
      await tg.send(chatId, urlRes.ok ? "✅ URL photo works" : `❌ URL test failed: <code>${esc(urlRes.description || "")}</code>`);
      try {
        const res = await fetch("https://picsum.photos/256/256");
        const buf = await res.arrayBuffer();
        const photo = await tg.sendPhotoBuffer(chatId, buf, "Buffer test");
        await tg.send(chatId, photo.ok ? "✅ Buffer photo works" : `❌ Buffer test failed: <code>${esc(photo.description || "")}</code>`);
      } catch (e) {
        await tg.send(chatId, `❌ ${esc(e.message)}`);
      }
      return;
    }

    if (cmd === "/testsfw") {
      const safePrompt = "beautiful mountain landscape, crystal clear lake, sunset sky, orange and pink clouds, pine trees, snow capped peaks, nature photography, 4k, masterpiece, best quality, highly detailed, sharp focus";
      await tg.send(chatId, "🧪 Sending SFW test generation to Horde...");
      const gen = await hordeSubmit(safePrompt, cfg, env, { skipLoras: true });
      if (!gen.id) {
        await tg.send(chatId, `❌ Horde: <code>${esc(JSON.stringify(gen).slice(0, 400))}</code>`);
        return;
      }
      await KV.put(env, `pending:${gen.id}`, {
        chatId,
        prompt: safePrompt,
        at: Date.now(),
        notify: chatId,
        debug: true,
        retries: 0,
        sfwTest: true,
      }, { expirationTtl: 3600 });
      await tg.send(chatId, `📤 ID: <code>${esc(gen.id)}</code>\n⏳ Wait for cron...`);
      return;
    }

    if (cmd === "/generate") {
      if (!cfg.generalPrompt) {
        await tg.send(chatId, "❌ First set prompt: /setprompt");
        return;
      }
      await tg.send(chatId, `⏳ Generating ${cfg.count} image(s)...`);
      const targetChat = cfg.chatId || chatId;
      const bl = (await getWorkerBlacklist(env)).map((w) => w.id).filter(Boolean);

      for (let i = 0; i < cfg.count; i++) {
        const { prompt, cfg: nextCfg } = await buildPrompt(env, cfg, cfg.generalPrompt);
        await tg.send(chatId, `🎨 #${i + 1}\n<code>${esc(prompt.slice(0, 350))}</code>`);
        const gen = await hordeSubmit(prompt, nextCfg, env, { workerBlacklist: bl });
        if (!gen.id) {
          await tg.send(chatId, `❌ Horde: <code>${esc(JSON.stringify(gen).slice(0, 300))}</code>`);
          continue;
        }
        await KV.put(env, `pending:${gen.id}`, {
          chatId: targetChat,
          prompt,
          at: Date.now(),
          notify: chatId,
          retries: 0,
        }, { expirationTtl: 3600 });
        await tg.send(chatId, `📤 ID: <code>${esc(gen.id)}</code>`);
      }
      return;
    }

    await tg.send(chatId, "❓ Unknown command — /help");
  } catch (e) {
    console.error("[CMD]", e);
    await tg.send(chatId, `❌ Error: <code>${esc(e.message)}</code>`);
  }
}

async function processScheduled(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const cfg = await getConfig(env);

  const pending = await KV.list(env, "pending:");
  for (const entry of pending.keys) {
    const id = entry.name.replace("pending:", "");
    try {
      const job = await KV.get(env, entry.name, "json");
      if (!job) {
        await KV.del(env, entry.name);
        continue;
      }

      if (Date.now() - job.at > 12 * 60 * 1000) {
        await KV.del(env, entry.name);
        if (job.notify) await tg.send(job.notify, `⏰ Generation timeout: <code>${esc(id)}</code>`);
        continue;
      }

      const chk = await hordeCheck(id);
      if (!chk.done) continue;

      const result = await hordeGetResult(id);
      await KV.del(env, entry.name);

      if (result.faulted) {
        if (job.notify) await tg.send(job.notify, `❌ Generation <code>${esc(id)}</code> failed`);
        continue;
      }

      const gens = result.generations || [];
      if (!gens.length) {
        if (job.notify) await tg.send(job.notify, `❌ No generations returned for <code>${esc(id)}</code>`);
        continue;
      }

      let sent = false;
      let flaggedBad = false;

      for (const g of gens) {
        const workerId = g.worker_id || "?";
        const workerName = g.worker_name || "?";
        const censored = isCensored(g);

        if (job.debug && job.notify) {
          await tg.send(
            job.notify,
            `🔍 <b>Result</b>\nWorker: <code>${esc(workerName)}</code>\nWorker ID: <code>${esc(workerId)}</code>\nModel: <code>${esc(g.model || "?")}</code>\nState: <code>${esc(g.state || "ok")}</code>\nCensored: <b>${censored ? "yes" : "no"}</b>`
          );
        }

        if (censored) {
          flaggedBad = true;
          await addWorkerToBlacklist(env, workerId, workerName);
          if (job.notify) {
            await tg.send(job.notify, `🔴 Worker <code>${esc(workerName)}</code> returned censorship and was blacklisted`);
          }
          continue;
        }

        if (!g.img) continue;

        const caption =
          cfg.captionMode === 1
            ? `<i>${esc(job.prompt.slice(0, 300))}</i>`
            : cfg.captionMode === 2
              ? await llmRewrite(
                  env,
                  cfg.captionPrompt || "Make a short Telegram caption.",
                  job.prompt,
                  cfg
                )
              : "";

        const targets = unique([job.chatId, cfg.channelId].filter(Boolean));
        for (const target of targets) {
          const resultSend = await deliverImage(tg, target, g.img, caption, job.notify);
          if (resultSend.sent) sent = true;
        }
      }

      if (flaggedBad && !sent && !job.sfwTest) {
        const retries = (job.retries || 0) + 1;
        if (retries < MAX_RETRIES) {
          const bl = (await getWorkerBlacklist(env)).map((w) => w.id).filter(Boolean);
          const retry = await hordeSubmit(job.prompt, cfg, env, { workerBlacklist: bl });
          if (retry.id) {
            await KV.put(env, `pending:${retry.id}`, {
              ...job,
              retries,
              at: Date.now(),
            }, { expirationTtl: 3600 });
            if (job.notify) await tg.send(job.notify, `🔄 Retry ${retries}/${MAX_RETRIES}: <code>${esc(retry.id)}</code>`);
          }
        } else if (job.notify) {
          await tg.send(
            job.notify,
            "❌ <b>3 attempts — all placeholders/censored</b>\n\nPossible reasons:\n• Anonymous Horde key\n• Account flagged\n• Workers censor this model\n\n/clearworkerbl — clear blacklist"
          );
        }
      }
    } catch (e) {
      console.error(`[CRON pending ${id}]`, e.message);
    }
  }

  // auto-post only when queue is empty
  const pendingAfter = await KV.list(env, "pending:");
  if (pendingAfter.keys.length) return;

  if (!cfg.enabled || !cfg.chatId || !cfg.generalPrompt) return;

  const lastPost = toInt((await KV.get(env, "last_post_time", "text")) || "0", 0);
  const now = Date.now();
  if (now - lastPost < cfg.interval * 60 * 1000) return;

  await KV.put(env, "last_post_time", String(now));

  const bl = (await getWorkerBlacklist(env)).map((w) => w.id).filter(Boolean);

  for (let i = 0; i < cfg.count; i++) {
    try {
      const { prompt, cfg: nextCfg } = await buildPrompt(env, cfg, cfg.generalPrompt);
      const gen = await hordeSubmit(prompt, nextCfg, env, { workerBlacklist: bl });
      if (!gen.id) continue;

      await KV.put(env, `pending:${gen.id}`, {
        chatId: cfg.chatId,
        prompt,
        at: now,
        notify: null,
        retries: 0,
      }, { expirationTtl: 3600 });
    } catch (e) {
      console.error("[CRON auto]", e.message);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      try {
        const update = await request.json();
        if (update.message?.text || update.edited_message?.text) {
          await handleCommand(update, env);
        }
      } catch (e) {
        console.error("[WEBHOOK]", e.message);
      }
      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TELEGRAM_BOT_TOKEN", { status: 500 });
      const webhook = `${url.origin}/webhook`;
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhook,
          allowed_updates: ["message", "edited_message"],
          drop_pending_updates: true,
        }),
      });
      const data = await res.json();
      return new Response(`Webhook: ${webhook}\n\n${JSON.stringify(data, null, 2)}`);
    }

    if (url.pathname === "/") {
      return new Response("🤖 Telegram Image Bot is running!\nUse /setup to configure webhook.");
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env) {
    try {
      await processScheduled(env);
    } catch (e) {
      console.error("[SCHEDULED]", e.message);
    }
  },
};