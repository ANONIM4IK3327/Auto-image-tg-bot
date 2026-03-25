// ============================================================
//  Telegram Image Bot v5 — Anti-censorship edition
//  - Auto-blacklist censoring workers
//  - Auto-retry up to 3 times
//  - API key validation
//  - Full debug logging
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
};

const HORDE = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:5.0:tg" };
const MAX_RETRIES = 3;

// ──────────── TELEGRAM ────────────

class Telegram {
  constructor(token) {
    this.api = `https://api.telegram.org/bot${token}`;
  }
  async call(method, body) {
    const r = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await r.json();
    if (!res.ok) console.error(`[TG] ${method} ERR:`, JSON.stringify(res));
    return res;
  }
  msg(chatId, text) {
    return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  }
  sendPhotoUrl(chatId, url, caption = "") {
    return this.call("sendPhoto", {
      chat_id: chatId, photo: url,
      caption: caption.substring(0, 1024), parse_mode: "HTML",
    });
  }
  async sendPhotoBlob(chatId, blob, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", blob, "image.webp");
    if (caption) { form.append("caption", caption.substring(0, 1024)); form.append("parse_mode", "HTML"); }
    const r = await fetch(`${this.api}/sendPhoto`, { method: "POST", body: form });
    const res = await r.json();
    if (!res.ok) console.error("[TG] sendBlob ERR:", JSON.stringify(res));
    return res;
  }
}

// ──────────── KV ────────────

async function kvGet(env, key, type = "text") {
  if (!env.BOT_KV) return null;
  try { return await env.BOT_KV.get(key, type); } catch { return null; }
}
async function kvPut(env, key, val, opts = {}) {
  if (!env.BOT_KV) throw new Error("KV не привязан!");
  await env.BOT_KV.put(key, val, opts);
}
async function kvDel(env, key) { if (env.BOT_KV) await env.BOT_KV.delete(key); }
async function kvList(env, prefix) {
  if (!env.BOT_KV) return { keys: [] };
  return env.BOT_KV.list({ prefix });
}
async function getConfig(env) {
  const s = await kvGet(env, "config", "json");
  return { ...DEFAULT_CONFIG, ...(s || {}) };
}
async function saveConfig(env, c) { await kvPut(env, "config", JSON.stringify(c)); }

// ──────────── WORKER BLACKLIST ────────────

async function getBlacklist(env) {
  return (await kvGet(env, "worker_blacklist", "json")) || [];
}

async function addToBlacklist(env, workerId, workerName) {
  const bl = await getBlacklist(env);
  if (bl.find(w => w.id === workerId)) return bl;
  bl.push({ id: workerId, name: workerName || "unknown", ts: Date.now() });
  while (bl.length > 100) bl.shift();
  await kvPut(env, "worker_blacklist", JSON.stringify(bl));
  console.log(`[BL] Blacklisted worker: ${workerName} (${workerId})`);
  return bl;
}

async function clearBlacklist(env) {
  await kvPut(env, "worker_blacklist", JSON.stringify([]));
}

// ──────────── HORDE API ────────────

function getApiKey(env) {
  const key = (env.HORDE_API_KEY || "").trim();
  return key || "0000000000";
}

async function checkHordeKey(env) {
  const key = getApiKey(env);
  const isAnon = key === "0000000000";

  try {
    const resp = await fetch(`${HORDE}/find_user`, {
      headers: { apikey: key, ...HORDE_HEADERS },
    });

    if (resp.status === 401 || resp.status === 403) {
      return { valid: false, anonymous: isAnon, error: `HTTP ${resp.status} — ключ невалидный!` };
    }

    const data = await resp.json();
    return {
      valid: true,
      anonymous: isAnon,
      username: data.username,
      id: data.id,
      kudos: data.kudos,
      trusted: data.trusted,
      flagged: data.flagged,
      workerCount: data.worker_count || 0,
      keyFirstChars: key.substring(0, 6) + "...",
    };
  } catch (e) {
    return { valid: false, anonymous: isAnon, error: e.message };
  }
}

async function hordeSubmit(prompt, config, env) {
  const apiKey = getApiKey(env);

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

  if (config.loras?.length > 0) {
    params.loras = config.loras.map(l => ({
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
    trusted_workers: config.nsfw,
    models: [config.model],
    r2: true,
    replacement_filter: false,
    shared: false,
    slow_workers: true,
    allow_downgrade: true,
    dry_run: false,
  };

  console.log("[HORDE] Key:", apiKey === "0000000000" ? "ANON!" : apiKey.substring(0, 6) + "...");
  console.log("[HORDE] trusted_workers:", body.trusted_workers);
  console.log("[HORDE] Body:", JSON.stringify(body));

  const resp = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
      ...HORDE_HEADERS,
    },
    body: JSON.stringify(body),
  });

  const result = await resp.json();
  console.log("[HORDE] Response:", JSON.stringify(result));
  return result;
}

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

async function hordeSubmit(prompt, config, env) {
  const apiKey = getApiKey(env);

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

  if (config.loras?.length > 0) {
    params.loras = config.loras.map(l => ({
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
    trusted_workers: config.nsfw,
    models: [config.model],
    r2: true,
    replacement_filter: false,
    shared: false,
    slow_workers: true,
    allow_downgrade: true,
    dry_run: false,
  };


  if (config.hiresFix) {
    params.hires_fix = true;
    params.hires_fix_denoising_strength = config.hiresFixDenoising || 0.65;
  }

  if (config.loras?.length > 0) {
    params.loras = config.loras.map(l => ({
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
    workers: [],
    worker_blacklist: blacklist.map(w => w.id),
    models: [config.model],
    r2: true,
    replacement_filter: false,
    shared: false,
    slow_workers: true,
    allow_downgrade: true,
    dry_run: false,
  };

  console.log("[HORDE] Key:", apiKey === "0000000000" ? "ANONYMOUS!" : apiKey.substring(0, 6) + "...");
  console.log("[HORDE] Blacklisted workers:", blacklist.length);
  console.log("[HORDE] Body:", JSON.stringify(body));

  const resp = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
      ...HORDE_HEADERS,
    },
    body: JSON.stringify(body),
  });

  const result = await resp.json();
  console.log("[HORDE] Submit response:", JSON.stringify(result));

  if (result.message) {
    console.warn("[HORDE] Message:", result.message);
  }

  return result;
}

async function hordeCheck(id) {
  const r = await fetch(`${HORDE}/generate/check/${id}`, { headers: HORDE_HEADERS });
  return r.json();
}

async function hordeStatus(id) {
  const r = await fetch(`${HORDE}/generate/status/${id}`, { headers: HORDE_HEADERS });
  return r.json();
}

async function hordeModels() {
  const r = await fetch(`${HORDE}/status/models?type=image`, { headers: HORDE_HEADERS });
  return r.json();
}

// ──────────── IMAGE DOWNLOAD ────────────

async function fetchBlob(src) {
  if (!src) return null;
  if (src.startsWith("http")) {
    try {
      const r = await fetch(src);
      if (!r.ok) { console.error("[IMG] HTTP", r.status); return null; }
      const b = await r.blob();
      console.log("[IMG] size:", b.size);
      return b;
    } catch (e) { console.error("[IMG]", e.message); return null; }
  }
  try {
    const clean = src.replace(/^data:image\/\w+;base64,/, "");
    const bin = atob(clean);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: "image/webp" });
  } catch (e) { console.error("[IMG] b64:", e.message); return null; }
}

// ──────────── PROMPTS ────────────

const VA = ["from above","low angle","eye level","dutch angle","bird's eye","close-up","wide shot","portrait","three-quarter","profile","from behind","over shoulder"];
const VL = ["golden hour","blue twilight","chiaroscuro","soft overcast","neon glow","moonlit","rim lighting","dappled light","harsh shadows","candlelit","god rays","backlit"];
const VS = ["photorealistic","concept art","oil painting","watercolor","anime","dark fantasy","hyperrealistic","noir","surrealist","pop art","renaissance","vaporwave"];
const VM = ["serene","dramatic","mysterious","vibrant","ethereal","dark","intimate","epic","melancholic","playful","suspenseful","romantic"];
const VD = ["intricate details","rough textures","smooth finish","baroque","clean lines","aged patina","sharp focus","bokeh","particles","reflections"];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function templatePrompt(base) {
  return [base, pick(VA), pick(VL), pick(VS), pick(VM), pick(VD), pick(VD), "masterpiece", "best quality", "highly detailed"].join(", ");
}

async function llmPrompt(instr, apiKey, model) {
  const dirs = ["unusual perspective","dramatic lighting","unexpected environment","intricate textures","bold colors","dynamic motion","atmospheric","extreme framing","cinematic","weather effects","reflections","futuristic"];
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://t.me",
        "X-Title": "ImgBot",
      },
      body: JSON.stringify({
        model: model || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          { role: "system", content: `Stable Diffusion prompt engineer. Output ONLY comma-separated phrases. No quotes/markdown. Under 100 words. Direction: ${pick(dirs)}` },
          { role: "user", content: `Unique image prompt for: ${instr}` },
        ],
        temperature: 1.3, max_tokens: 200,
      }),
    });
    const d = await r.json();
    if (d.choices?.[0]?.message?.content) {
      let p = d.choices[0].message.content.trim().replace(/^["'`*]+|["'`*]+$/g, "");
      if (p.length > 10) return p;
    }
  } catch (e) { console.error("[LLM]", e.message); }
  return templatePrompt(instr);
}

async function makePrompt(instr, env) {
  if (env.OPENROUTER_API_KEY) {
    const c = await getConfig(env);
    return llmPrompt(instr, env.OPENROUTER_API_KEY, c.llmModel || env.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free");
  }
  return templatePrompt(instr);
}

// ──────────── SEND IMAGE ────────────

async function sendImage(tg, chatId, src, caption, notify) {
  const blob = await fetchBlob(src);
  if (!blob || blob.size < 1000) {
    if (notify) await tg.msg(notify, "⚠️ Картинка пустая/повреждённая");
    return false;
  }
  const res = await tg.sendPhotoBlob(chatId, blob, caption);
  if (res.ok) return true;
  if (src.startsWith("http")) {
    const res2 = await tg.sendPhotoUrl(chatId, src, caption);
    if (res2.ok) return true;
  }
  if (notify) await tg.msg(notify, `❌ Отправка: ${res.description || "error"}`);
  return false;
}

// ──────────── COMMANDS ────────────

async function handleCommand(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text || "";
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  console.log(`[CMD] ${userId} "${cmd}" ${JSON.stringify(args)}`);

  // ── Без KV ──

  if (cmd === "/ping") {
    const key = getApiKey(env);
    await tg.msg(chatId,
      `🏓 Pong!\nChat: <code>${chatId}</code>\nUser: <code>${userId}</code>\n` +
      `KV: ${env.BOT_KV ? "✅" : "❌"}\n` +
      `Horde key: ${key === "0000000000" ? "❌ АНОНИМНЫЙ — NSFW заблокирован!" : "✅ " + key.substring(0, 6) + "..."}\n` +
      `OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}`
    );
    return;
  }

  if (cmd === "/diagnostic") {
    const key = getApiKey(env);
    let t = "🔧 <b>Диагностика v5</b>\n\n";
    t += `KV: ${env.BOT_KV ? "✅" : "❌"}\n`;
    t += `TOKEN: ${env.TELEGRAM_BOT_TOKEN ? "✅" : "❌"}\n`;
    t += `HORDE_API_KEY: ${key === "0000000000" ? "❌ АНОНИМНЫЙ" : "✅ " + key.substring(0, 6) + "..."}\n`;
    t += `OPENROUTER: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}\n`;

    if (key === "0000000000") {
      t += "\n🔴 <b>КРИТИЧНО: нет API ключа Horde!</b>\n";
      t += "Анонимные запросы ВСЕГДА цензурируют NSFW.\n";
      t += "Это чёрный квадрат.\n\n";
      t += "1. Иди на https://stablehorde.net/register\n";
      t += "2. Зарегистрируйся → получи API key\n";
      t += "3. Workers → Settings → Secrets → добавь:\n";
      t += "   <code>HORDE_API_KEY</code> = твой ключ\n";
      t += "4. Проверь: /checkkey";
    } else {
      t += "\nИспользуй /checkkey для проверки ключа";
    }

    await tg.msg(chatId, t);
    return;
  }

  // ── Проверка ключа Horde ──

  if (cmd === "/checkkey") {
    await tg.msg(chatId, "🔑 Проверяю ключ...");
    const info = await checkHordeKey(env);

    if (!info.valid) {
      await tg.msg(chatId,
        `❌ <b>Ключ невалидный!</b>\n\n` +
        `Ошибка: ${info.error}\n` +
        `Анонимный: ${info.anonymous ? "да" : "нет"}\n\n` +
        `🔴 Анонимные запросы ВСЕГДА получают чёрную картинку для NSFW.\n\n` +
        `Исправление:\n` +
        `1. https://stablehorde.net/register\n` +
        `2. Зарегистрируйся (бесплатно)\n` +
        `3. Скопируй API key\n` +
        `4. Cloudflare → Workers → Settings → Secrets\n` +
        `5. Добавь: <code>HORDE_API_KEY</code> = твой ключ\n` +
        `6. Сделай /checkkey снова`
      );
    } else {
      await tg.msg(chatId,
        `✅ <b>Ключ валидный!</b>\n\n` +
        `👤 Username: <b>${info.username}</b>\n` +
        `🆔 ID: ${info.id}\n` +
        `💎 Kudos: ${info.kudos}\n` +
        `🛡 Trusted: ${info.trusted ? "да" : "нет"}\n` +
        `🚩 Flagged: ${info.flagged ? "⚠️ ДА!" : "нет"}\n` +
        `⚙️ Workers: ${info.workerCount}\n` +
        `🔑 Key: <code>${info.keyFirstChars}</code>\n\n` +
        (info.flagged ? "⚠️ Аккаунт помечен! Это может вызывать цензуру.\n" : "") +
        (info.anonymous ? "🔴 Это анонимный ключ! NSFW будет цензурирован!\n" : "✅ NSFW должен работать\n") +
        `\nЧёрный список воркеров: /blacklist`
      );
    }
    return;
  }

  if (!env.BOT_KV) {
    await tg.msg(chatId, "❌ KV не привязан! /diagnostic");
    return;
  }

  let config = await getConfig(env);

  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(env, config);
    await tg.msg(chatId, `👑 Админ: <code>${userId}</code>`);
  }

  if (config.adminId !== userId) {
    await tg.msg(chatId, `🔒 Админ: ${config.adminId}`);
    return;
  }

  switch (cmd) {

  case "/start": case "/help":
    await tg.msg(chatId,
`🤖 <b>Image Bot v5</b>

/ping /diagnostic /checkkey

<b>Настройка:</b>
/setchat /setprompt /setinterval /setcount

<b>Модель:</b>
/setmodel /listmodels
/searchlora /addlora /removelora /listloras

<b>Параметры:</b>
/setsize /setsteps /setcfg /setsampler
/setneg /nsfw /setclipskip /setllm
/hiresfix /karras

<b>Управление:</b>
/enable /disable /generate
/status /pending /cancel
/blacklist /clearblacklist
/debuggen — тест с дебагом
/resetadmin`);
    break;

  case "/blacklist": {
    const bl = await getBlacklist(env);
    if (!bl.length) {
      await tg.msg(chatId, "📋 Чёрный список воркеров пуст.\n\nКогда воркер цензурит картинку, он автоматически попадает сюда.");
      break;
    }
    let t = `📋 <b>Заблокированные воркеры: ${bl.length}</b>\n\n`;
    bl.slice(-20).forEach(w => {
      t += `• <code>${w.name}</code>\n  ID: <code>${w.id}</code>\n  ${new Date(w.ts).toLocaleString()}\n\n`;
    });
    t += "/clearblacklist — очистить";
    await tg.msg(chatId, t);
    break;
  }

  case "/clearblacklist":
    await clearBlacklist(env);
    await tg.msg(chatId, "✅ Чёрный список очищен");
    break;

  case "/resetadmin":
    config.adminId = userId; await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${userId}`); break;

  case "/setchat":
    config.chatId = chatId; await saveConfig(env, config);
    await tg.msg(chatId, `✅ <code>${chatId}</code>`); break;

  case "/setprompt": {
    const p = args.join(" ");
    if (!p) { await tg.msg(chatId, "❌ /setprompt &lt;тема&gt;"); break; }
    config.generalPrompt = p; await saveConfig(env, config);
    await tg.msg(chatId, `✅ <code>${p}</code>`); break;
  }

  case "/setinterval": {
    const m = parseInt(args[0]);
    if (isNaN(m) || m < 1) { await tg.msg(chatId, "❌ /setinterval мин"); break; }
    config.interval = m; await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${m}м`); break;
  }

  case "/setcount": {
    const n = parseInt(args[0]);
    if (isNaN(n) || n < 1 || n > 10) { await tg.msg(chatId, "❌ 1-10"); break; }
    config.count = n; await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${n}`); break;
  }

  case "/setmodel": {
    const nm = args.join(" ");
    if (!nm) { await tg.msg(chatId, "❌ /setmodel имя\n/listmodels"); break; }
    config.model = nm; await saveConfig(env, config);
    await tg.msg(chatId, `✅ <code>${nm}</code>`); break;
  }

  case "/listmodels": {
    await tg.msg(chatId, "⏳...");
    const models = await hordeModels();
    const top = models.filter(m => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 30);
    let t = "📋 <b>Модели:</b>\n\n";
    top.forEach(m => {
      const tag = (m.name.includes("XL") || m.name.includes("SDXL") || m.name.includes("Pony")) ? "🟢" : "⚪";
      t += `${tag} <code>${m.name}</code> (${m.count}w)\n`;
    });
    t += "\n/setmodel имя";
    await tg.msg(chatId, t);
    break;
  }

  case "/searchlora": {
    const q = args.join(" ");
    if (!q) { await tg.msg(chatId, "❌ /searchlora запрос"); break; }
    await tg.msg(chatId, "🔍...");
    const r = await fetch(`https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(q)}&limit=8&sort=Highest%20Rated&nsfw=true`);
    const d = await r.json();
    if (!d.items?.length) { await tg.msg(chatId, "😕 Нет"); break; }
    let t = `🔍 "${q}":\n\n`;
    d.items.forEach(i => {
      const v = i.modelVersions?.[0];
      t += `${i.nsfw?"🔞":"✅"} <b>${i.name}</b> [${v?.baseModel||"?"}]\n➕ <code>/addlora ${v?.id||"?"} 0.8</code>\n\n`;
    });
    await tg.msg(chatId, t); break;
  }

  case "/addlora": {
    const id = args[0], str = parseFloat(args[1]) || 0.8, cl = parseFloat(args[2]) || 1;
    if (!id) { await tg.msg(chatId, "❌ /addlora id [str] [clip]"); break; }
    config.loras = (config.loras || []).filter(l => String(l.name) !== String(id));
    config.loras.push({ name: id, strength: str, clip: cl });
    await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${id} (${str}/${cl})`); break;
  }

  case "/removelora": {
    if (!args[0]) { await tg.msg(chatId, "❌ /removelora id"); break; }
    config.loras = (config.loras || []).filter(l => String(l.name) !== String(args[0]));
    await saveConfig(env, config);
    await tg.msg(chatId, `✅ Удалено`); break;
  }

  case "/listloras": {
    const ll = config.loras || [];
    if (!ll.length) { await tg.msg(chatId, "Нет LoRA. /searchlora"); break; }
    let t = "📋 LoRA:\n\n";
    ll.forEach(l => { t += `• <code>${l.name}</code> (${l.strength}/${l.clip})\n  /removelora ${l.name}\n\n`; });
    await tg.msg(chatId, t); break;
  }

  case "/setsize": {
    const w = parseInt(args[0]), h = parseInt(args[1]);
    if (isNaN(w)||isNaN(h)||w<256||h<256||w>2048||h>2048) {
      await tg.msg(chatId, "❌ /setsize W H\n<code>/setsize 704 1024</code>\n<code>/setsize 1024 1024</code>"); break;
    }
    config.width = Math.round(w/64)*64; config.height = Math.round(h/64)*64;
    await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${config.width}×${config.height}`); break;
  }

  case "/setsteps": {
    const s = parseInt(args[0]);
    if (isNaN(s)||s<1||s>50) { await tg.msg(chatId, "❌ 1-50"); break; }
    config.steps = s; await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${s}`); break;
  }

  case "/setcfg": {
    const c = parseFloat(args[0]);
    if (isNaN(c)||c<1||c>30) { await tg.msg(chatId, "❌ 1-30"); break; }
    config.cfgScale = c; await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${c}`); break;
  }

  case "/setsampler": {
    const sl = ["k_euler","k_euler_a","k_lms","k_heun","k_dpm_2","k_dpm_2_a","k_dpmpp_2s_a","k_dpmpp_2m","k_dpmpp_sde","DDIM"];
    if (!args[0]||!sl.includes(args[0])) { await tg.msg(chatId, `${sl.map(s=>`<code>${s}</code>`).join("\n")}`); break; }
    config.sampler = args[0]; await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${args[0]}`); break;
  }

  case "/setneg":
    config.negativePrompt = args.join(" ") || DEFAULT_CONFIG.negativePrompt;
    await saveConfig(env, config);
    await tg.msg(chatId, `✅ <code>${config.negativePrompt.substring(0,150)}</code>`); break;

  case "/nsfw": {
    if (args[0]!=="on"&&args[0]!=="off") { await tg.msg(chatId, "/nsfw on|off"); break; }
    config.nsfw = args[0]==="on"; await saveConfig(env, config);
    let w = "";
    if (config.nsfw && getApiKey(env)==="0000000000") w = "\n🔴 НЕТ API КЛЮЧА! /checkkey";
    await tg.msg(chatId, `✅ ${config.nsfw?"🔞 ON":"OFF"}${w}`); break;
  }

  case "/setclipskip": {
    const cs = parseInt(args[0]);
    if (isNaN(cs)||cs<1||cs>4) { await tg.msg(chatId, "❌ 1-4"); break; }
    config.clipSkip = cs; await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${cs}`); break;
  }

  case "/setllm": {
    const l = args.join(" ");
    if (!l) { await tg.msg(chatId, `<code>${config.llmModel||"auto"}</code>\n\n<code>meta-llama/llama-3.1-8b-instruct:free</code>\n<code>google/gemma-2-9b-it:free</code>`); break; }
    config.llmModel = l; await saveConfig(env, config);
    await tg.msg(chatId, `✅ <code>${l}</code>`); break;
  }

  case "/hiresfix": {
    if (args[0]!=="on"&&args[0]!=="off") { await tg.msg(chatId, `${config.hiresFix?"ON":"OFF"} (${config.hiresFixDenoising})\n/hiresfix on|off [0-1]`); break; }
    config.hiresFix = args[0]==="on";
    if (args[1]) config.hiresFixDenoising = Math.max(0, Math.min(1, parseFloat(args[1])||0.65));
    await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${config.hiresFix?"ON":"OFF"} (${config.hiresFixDenoising||0.65})`); break;
  }

  case "/karras": {
    if (args[0]!=="on"&&args[0]!=="off") { await tg.msg(chatId, `/karras on|off (сейчас: ${config.karras!==false?"ON":"OFF"})`); break; }
    config.karras = args[0]==="on"; await saveConfig(env, config);
    await tg.msg(chatId, `✅ ${config.karras?"ON":"OFF"}`); break;
  }

  case "/enable": {
    if (!config.chatId) { await tg.msg(chatId, "❌ /setchat"); break; }
    if (!config.generalPrompt) { await tg.msg(chatId, "❌ /setprompt"); break; }
    config.enabled = true; await saveConfig(env, config);
    const key = getApiKey(env);
    let w = key==="0000000000" ? "\n🔴 NSFW будет чёрным без API ключа!" : "";
    await tg.msg(chatId, `🟢 ${config.interval}м × ${config.count}шт${w}`); break;
  }

  case "/disable":
    config.enabled = false; await saveConfig(env, config);
    await tg.msg(chatId, "🔴 ВЫКЛ"); break;

  case "/status": {
    const key = getApiKey(env);
    const bl = await getBlacklist(env);
    const pend = await kvList(env, "pending:");
    const loras = (config.loras||[]).map(l=>`  • ${l.name} (${l.strength})`).join("\n")||"  нет";
    await tg.msg(chatId,
`📊 <b>v5</b> ${config.enabled?"🟢":"🔴"}

Чат: <code>${config.chatId||"—"}</code>
${config.interval}м × ${config.count}шт

Промпт: <code>${config.generalPrompt||"—"}</code>

Модель: <code>${config.model}</code>
${config.width}×${config.height} | Steps:${config.steps} | CFG:${config.cfgScale}
Sampler: ${config.sampler} | CLIP:${config.clipSkip||2}
Karras: ${config.karras!==false?"✅":"❌"} | HiRes: ${config.hiresFix?"✅":"❌"}
NSFW: ${config.nsfw?"🔞":"нет"}
Horde key: ${key==="0000000000"?"❌ АНОНИМНЫЙ":"✅ "+key.substring(0,6)+"..."}

LoRA:
${loras}

LLM: <code>${config.llmModel||env.LLM_MODEL||"auto"}</code>
Чёрный список: ${bl.length} воркеров
Очередь: ${pend.keys.length}`);
    break;
  }

  // ── DEBUG GENERATE ──
  case "/debuggen": {
    const key = getApiKey(env);
    await tg.msg(chatId,
      `🧪 <b>Debug генерация</b>\n\n` +
      `Key: ${key==="0000000000"?"❌ АНОНИМНЫЙ":"✅ "+key.substring(0,6)+"..."}\n` +
      `Модель: ${config.model}\n` +
      `Запускаю...`
    );

    const testPrompt = "beautiful woman, studio photo, elegant, soft lighting, masterpiece, best quality, highly detailed";

    try {
      const result = await hordeSubmit(testPrompt, config, env);

      if (result.id) {
        await kvPut(env, `pending:${result.id}`, JSON.stringify({
          chatId, prompt: testPrompt, submittedAt: Date.now(),
          notifyChat: chatId, debug: true, retryCount: 0,
        }), { expirationTtl: 3600 });

        await tg.msg(chatId,
          `📤 <code>${result.id}</code>\n\n` +
          `Ожидай результат. Когда картинка придёт, бот покажет:\n` +
          `• Был ли censored\n` +
          `• Какой воркер обработал\n` +
          `• Модель\n\n` +
          (result.message ? `⚠️ Horde message: ${result.message}\n` : "") +
          (result.warnings ? `⚠️ Warnings: ${JSON.stringify(result.warnings)}\n` : "")
        );
      } else {
        await tg.msg(chatId, `❌ ${JSON.stringify(result).substring(0,500)}`);
      }
    } catch (e) {
      await tg.msg(chatId, `❌ ${e.message}`);
    }
    break;
  }

  case "/generate": {
    if (!config.generalPrompt) { await tg.msg(chatId, "❌ /setprompt"); break; }
    const target = config.chatId || chatId;
    await tg.msg(chatId, `⏳ ${config.count}шт...`);

    for (let i = 0; i < config.count; i++) {
      try {
        const prompt = await makePrompt(config.generalPrompt, env);
        await tg.msg(chatId, `🎨 #${i+1}: <code>${prompt.substring(0,200)}</code>`);

        const result = await hordeSubmit(prompt, config, env);

        if (result.id) {
          await kvPut(env, `pending:${result.id}`, JSON.stringify({
            chatId: target, prompt, submittedAt: Date.now(),
            notifyChat: chatId, retryCount: 0,
          }), { expirationTtl: 3600 });
          await tg.msg(chatId, `📤 <code>${result.id}</code>`);
        } else {
          await tg.msg(chatId, `❌ ${JSON.stringify(result).substring(0,300)}`);
        }
      } catch (e) { await tg.msg(chatId, `❌ ${e.message}`); }
    }
    break;
  }

  case "/pending": {
    const list = await kvList(env, "pending:");
    if (!list.keys.length) { await tg.msg(chatId, "📋 Пусто"); break; }
    let t = `📋 ${list.keys.length}:\n\n`;
    for (const k of list.keys.slice(0, 10)) {
      const id = k.name.replace("pending:", "");
      try {
        const ch = await hordeCheck(id);
        t += `• <code>${id}</code> ${ch.done?"✅":ch.processing?"⚙️":`⏳#${ch.queue_position}`} ~${ch.wait_time}с\n`;
      } catch { t += `• <code>${id}</code> ?\n`; }
    }
    await tg.msg(chatId, t); break;
  }

  case "/cancel": {
    const list = await kvList(env, "pending:");
    for (const k of list.keys) await kvDel(env, k.name);
    await tg.msg(chatId, `🗑 ${list.keys.length}`); break;
  }

  default:
    if (cmd.startsWith("/")) await tg.msg(chatId, "❓ /help");
  }
}

// ──────────── CRON ────────────

async function processScheduled(env) {
  if (!env.BOT_KV || !env.TELEGRAM_BOT_TOKEN) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);
  const pendingList = await kvList(env, "pending:");

  console.log(`[CRON] Pending: ${pendingList.keys.length}`);

  for (const key of pendingList.keys) {
    const id = key.name.replace("pending:", "");

    try {
      const data = await kvGet(env, key.name, "json");
      if (!data) { await kvDel(env, key.name); continue; }

      // Таймаут
      if (Date.now() - data.submittedAt > 20 * 60 * 1000) {
        await kvDel(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `⏰ Таймаут: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      console.log(`[CRON] ${id}: done=${check.done} proc=${check.processing} q=${check.queue_position}`);
      if (!check.done) continue;

      // ── Готово! ──
      const result = await hordeStatus(id);

      if (result.faulted) {
        await kvDel(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `❌ Faulted: <code>${id}</code>`);
        continue;
      }

      const gens = result.generations || [];
      if (!gens.length) {
        await kvDel(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `⚠️ Пусто: <code>${id}</code>`);
        continue;
      }

      let anySent = false;
      let anyCensored = false;

      for (const gen of gens) {
        const workerName = gen.worker_name || "unknown";
        const workerId = gen.worker_id || "";
        const genModel = gen.model || config.model;

        console.log(`[CRON] gen: censored=${gen.censored} worker=${workerName} model=${genModel} img=${gen.img ? "yes" : "no"}`);

        // ── Debug mode ──
        if (data.debug && data.notifyChat) {
          await tg.msg(data.notifyChat,
            `🔍 <b>Debug результат:</b>\n\n` +
            `Censored: ${gen.censored ? "🔴 ДА!" : "✅ нет"}\n` +
            `Worker: <code>${workerName}</code>\n` +
            `Worker ID: <code>${workerId}</code>\n` +
            `Model: <code>${genModel}</code>\n` +
            `Seed: ${gen.seed || "?"}\n` +
            `Img: ${gen.img ? gen.img.substring(0, 80) + "..." : "отсутствует"}\n` +
            `State: ${gen.state || "?"}`
          );
        }

        // ── ЦЕНЗУРА ──
        if (gen.censored) {
          anyCensored = true;
          console.warn(`[CRON] CENSORED by ${workerName} (${workerId})`);

          // Автоматически блеклистим воркера
          await addToBlacklist(env, workerId, workerName);

          if (data.notifyChat) {
            const retries = data.retryCount || 0;
            await tg.msg(data.notifyChat,
              `🚫 <b>Цензура!</b> Воркер <code>${workerName}</code> заблокировал NSFW.\n` +
              `Воркер добавлен в чёрный список.\n` +
              `Попытка ${retries + 1}/${MAX_RETRIES}` +
              (retries < MAX_RETRIES - 1 ? " — перегенерирую..." : " — последняя!")
            );
          }
          continue;
        }

        if (!gen.img) {
          if (data.notifyChat) await tg.msg(data.notifyChat, `⚠️ Нет img: <code>${id}</code>`);
          continue;
        }

        const caption = data.prompt ? `🎨 <i>${data.prompt.substring(0, 150)}</i>` : "";
        const sent = await sendImage(tg, data.chatId, gen.img, caption, data.notifyChat);
        if (sent) anySent = true;
      }

      // Удаляем из очереди
      await kvDel(env, key.name);

      // ── АВТО-RETRY при цензуре ──
      if (anyCensored && !anySent) {
        const retryCount = (data.retryCount || 0) + 1;

        if (retryCount < MAX_RETRIES) {
          console.log(`[CRON] Retrying (${retryCount}/${MAX_RETRIES})...`);

          try {
            const newResult = await hordeSubmit(data.prompt, config, env);
            if (newResult.id) {
              await kvPut(env, `pending:${newResult.id}`, JSON.stringify({
                ...data,
                submittedAt: Date.now(),
                retryCount,
              }), { expirationTtl: 3600 });
              console.log(`[CRON] Retry queued: ${newResult.id}`);
            }
          } catch (e) {
            console.error("[CRON] Retry error:", e.message);
          }
        } else {
          if (data.notifyChat) {
            const bl = await getBlacklist(env);
            await tg.msg(data.notifyChat,
              `❌ <b>${MAX_RETRIES} попытки — все зацензурены!</b>\n\n` +
              `Заблокировано воркеров: ${bl.length}\n\n` +
              `Что делать:\n` +
              `1. /checkkey — проверь ключ\n` +
              `2. Попробуй другую модель (/listmodels)\n` +
              `3. /clearblacklist + попробуй снова\n` +
              `4. Попробуй менее NSFW промпт`
            );
          }
        }
      }

      if (anySent && data.notifyChat && data.notifyChat !== data.chatId) {
        await tg.msg(data.notifyChat, "✅ Отправлено!");
      }

    } catch (e) {
      console.error(`[CRON] ${id}:`, e.message);
    }
  }

  // ── Автопостинг ──
  if (!config.enabled || !config.chatId || !config.generalPrompt) return;

  const curr = await kvList(env, "pending:");
  if (curr.keys.length > 0) return;

  const lastPost = parseInt((await kvGet(env, "last_post_time")) || "0");
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  console.log("[CRON] Auto-post!");
  await kvPut(env, "last_post_time", String(now));

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await makePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env);
      if (result.id) {
        await kvPut(env, `pending:${result.id}`, JSON.stringify({
          chatId: config.chatId, prompt, submittedAt: now,
          notifyChat: null, retryCount: 0,
        }), { expirationTtl: 3600 });
      }
    } catch (e) { console.error("[CRON] Auto:", e.message); }
  }
}

// ──────────── ENTRY ────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("POST", { status: 405 });
      let upd;
      try { upd = await request.json(); } catch { return new Response("Bad", { status: 400 }); }
      console.log("[WH]", JSON.stringify(upd).substring(0, 300));

      if (upd.message?.text) {
        try { await handleCommand(upd.message, env); }
        catch (e) {
          console.error("[WH] CRASH:", e.message, e.stack);
          try { const tg = new Telegram(env.TELEGRAM_BOT_TOKEN); await tg.msg(upd.message.chat.id, `💥 <code>${e.message}</code>`); } catch {}
        }
      }
      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TOKEN!", { status: 500 });
      const wh = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: wh, allowed_updates: ["message"], drop_pending_updates: true }),
      });
      const res = await r.json();
      const key = getApiKey(env);
      return new Response(
        `Webhook: ${wh}\n${JSON.stringify(res, null, 2)}\n\nKV:${env.BOT_KV?"OK":"MISSING"}\nHorde key:${key==="0000000000"?"ANONYMOUS — NSFW WILL BE CENSORED!":"OK ("+key.substring(0,6)+"...)"}\nOpenRouter:${env.OPENROUTER_API_KEY?"OK":"no"}`,
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    if (url.pathname === "/health") {
      const key = getApiKey(env);
      return new Response(JSON.stringify({
        kv: !!env.BOT_KV, tg: !!env.TELEGRAM_BOT_TOKEN,
        horde_key: key !== "0000000000", openrouter: !!env.OPENROUTER_API_KEY,
      }, null, 2));
    }

    return new Response("Bot v5. /setup /health");
  },

  async scheduled(event, env, ctx) {
    try { await processScheduled(env); }
    catch (e) { console.error("[CRON] CRASH:", e.message, e.stack); }
  },
};