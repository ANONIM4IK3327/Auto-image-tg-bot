// ============================================================
//  Telegram Image Bot v10
//  Fix: r2:true + immediate download before URL expires
//  Restored: formatting, all commands, proper /pending
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

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_AGENT = { "Client-Agent": "TgImageBot:10.0:tg" };
const MAX_RETRIES = 3;
const MIN_IMAGE_KB = 20;

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

  async sendPhoto(chatId, arrayBuffer, caption = "") {
    console.log("[TG] sendPhoto bytes:", arrayBuffer.byteLength);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([arrayBuffer], { type: "image/png" }), "image.png");
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
    const res = await r.json();
    if (!res.ok) console.error("[TG] sendPhoto:", JSON.stringify(res).substring(0, 200));
    return res;
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

  const body = {
    prompt: config.negativePrompt
      ? `${prompt} ### ${config.negativePrompt}`
      : prompt,
    params,
    nsfw: true,
    censor_nsfw: false,
    trusted_workers: true,
    models: [config.model],
    r2: true,
    replacement_filter: false,
    shared: false,
    slow_workers: false,
    allow_downgrade: true,
    dry_run: false,
  };

  console.log("[HORDE] key:", key === "0000000000" ? "ANON!" : key.substring(0, 8) + "...");
  console.log("[HORDE] body:", JSON.stringify(body).substring(0, 600));

  const resp = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, ...HORDE_AGENT },
    body: JSON.stringify(body),
  });
  const result = await resp.json();
  console.log("[HORDE] response:", JSON.stringify(result).substring(0, 300));
  return result;
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
//  r2:true → URL → мгновенно скачиваем → отправляем buffer
// ══════════════════════════════════════

async function downloadImage(url) {
  console.log("[IMG] Downloading:", url.substring(0, 80));
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error("[IMG] HTTP", resp.status);
    return null;
  }
  const buf = await resp.arrayBuffer();
  console.log("[IMG] Downloaded:", buf.byteLength, "bytes =", Math.round(buf.byteLength / 1024), "KB");
  return buf;
}

async function deliverImage(tg, chatId, imageUrl, caption, notifyChat) {
  if (!imageUrl) {
    if (notifyChat) await tg.send(notifyChat, "❌ Нет ссылки на картинку");
    return { sent: false, tooSmall: false };
  }

  // Шаг 1: Скачиваем картинку СЕЙЧАС (до протухания URL)
  const buf = await downloadImage(imageUrl);

  if (!buf) {
    if (notifyChat) await tg.send(notifyChat, "❌ Не удалось скачать картинку с Horde");
    return { sent: false, tooSmall: false };
  }

  const sizeKB = Math.round(buf.byteLength / 1024);

  // Шаг 2: Проверяем размер (< 20KB = заглушка/цензура)
  if (sizeKB < MIN_IMAGE_KB) {
    console.warn("[IMG] Too small:", sizeKB, "KB");
    if (notifyChat) {
      await tg.send(notifyChat,
        `🚫 <b>Заглушка!</b> Размер: ${sizeKB}KB (нормальная картинка >20KB)\n` +
        `Воркер вернул пустышку вместо реальной картинки.`
      );
    }
    return { sent: false, tooSmall: true };
  }

  // Шаг 3: Отправляем в Telegram как файл
  const res = await tg.sendPhoto(chatId, buf, caption);

  if (res.ok) {
    console.log("[IMG] ✅ Sent!", sizeKB, "KB");
    return { sent: true, tooSmall: false };
  }

  // Фолбэк: пробуем URL напрямую (вдруг Telegram сможет)
  console.log("[IMG] Buffer failed, trying URL directly...");
  const res2 = await tg.sendPhotoUrl(chatId, imageUrl, caption);
  if (res2.ok) {
    console.log("[IMG] ✅ URL fallback worked!");
    return { sent: true, tooSmall: false };
  }

  if (notifyChat) {
    await tg.send(notifyChat, `❌ Отправка не удалась: ${res.description || "?"}`);
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

  console.log(`[CMD] ${userId} ${cmd}`);

  // ─────── Команды без KV ───────

  if (cmd === "/ping") {
    const k = getApiKey(env);
    await tg.send(chatId,
      `🏓 <b>Pong! v10</b>\n\n` +
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
    let t = `🔧 <b>Диагностика v10</b>\n\n`;
    t += `💾 KV: ${env.BOT_KV ? "✅" : "❌ НЕ ПРИВЯЗАН"}\n`;
    t += `🔑 Horde: ${k === "0000000000" ? "❌ анонимный" : "✅ " + k.substring(0, 8) + "..."}\n`;
    t += `🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}\n\n`;
    t += `⚙️ r2: true (URL + мгновенная загрузка)\n`;
    t += `⚙️ trusted_workers: true\n`;
    t += `⚙️ Мин. размер: ${MIN_IMAGE_KB}KB\n`;
    if (k === "0000000000") {
      t += `\n🔴 <b>Нужен API ключ Horde!</b>\n`;
      t += `https://stablehorde.net/register\n`;
      t += `Workers → Secrets → <code>HORDE_API_KEY</code>`;
    }
    await tg.send(chatId, t);
    return;
  }

  if (cmd === "/checkkey") {
    await tg.send(chatId, "🔑 Проверяю ключ...");
    const info = await hordeCheckKey(env);
    if (!info.ok) {
      await tg.send(chatId,
        `❌ <b>Ключ невалидный!</b>\n\n${info.err || ""}\n\n` +
        `1. https://stablehorde.net/register\n` +
        `2. Скопируй API key\n` +
        `3. Workers → Secrets → <code>HORDE_API_KEY</code>`
      );
    } else {
      await tg.send(chatId,
        `${info.anon ? "🔴" : "✅"} <b>${info.user}</b>\n\n` +
        `💎 Kudos: ${info.kudos}\n` +
        `🛡 Trusted: ${info.trusted ? "да" : "нет"}\n` +
        `🚩 Flagged: ${info.flagged ? "⚠️ ДА" : "нет"}\n\n` +
        (info.anon ? "🔴 <b>Анонимный ключ — NSFW будет чёрным!</b>" :
         info.flagged ? "⚠️ Аккаунт помечен — возможна цензура" :
         "✅ Всё в порядке, NSFW должен работать")
      );
    }
    return;
  }

  if (cmd === "/testimg") {
    await tg.send(chatId, "🧪 <b>Тест отправки картинок</b>\n\n1️⃣ URL метод...");
    const r1 = await tg.sendPhotoUrl(chatId, "https://picsum.photos/512/512", "✅ URL метод работает");
    await tg.send(chatId, r1.ok ? "✅ URL ОК!\n\n2️⃣ Buffer метод..." : `❌ URL: ${r1.description}\n\n2️⃣ Buffer метод...`);
    try {
      const resp = await fetch("https://picsum.photos/256/256");
      const buf = await resp.arrayBuffer();
      const r2 = await tg.sendPhoto(chatId, buf, "✅ Buffer метод работает");
      await tg.send(chatId, r2.ok ? "✅ <b>Оба метода работают!</b>\nПроблема в генерации, не в отправке." : `❌ Buffer: ${r2.description}`);
    } catch (e) {
      await tg.send(chatId, `❌ ${e.message}`);
    }
    return;
  }

  if (cmd === "/testsfw") {
    if (!env.BOT_KV) { await tg.send(chatId, "❌ KV!"); return; }
    const config = await getConfig(env);
    await tg.send(chatId,
      `🧪 <b>SFW тест генерации</b>\n\n` +
      `🖼 Пейзаж (0% NSFW)\n` +
      `📦 Модель: <code>${config.model}</code>\n` +
      `⚙️ nsfw:true censor_nsfw:false\n\n` +
      `Если пейзаж нормальный → проблема в NSFW\n` +
      `Если тоже пустой → проблема в модели/воркере`
    );

    const sfwPrompt = "beautiful mountain landscape, crystal clear lake, sunset sky with orange and pink clouds, pine trees, snow capped peaks, nature photography, national geographic, 4k, masterpiece, best quality, highly detailed, sharp focus";

    try {
      const result = await hordeSubmit(sfwPrompt, config, env, { skipLoras: true });
      if (result.id) {
        await KV.put(env, `pending:${result.id}`, JSON.stringify({
          chatId, prompt: sfwPrompt, at: Date.now(), notify: chatId,
          debug: true, retries: 99, sfwTest: true,
        }), { expirationTtl: 3600 });
        await tg.send(chatId, `📤 ID: <code>${result.id}</code>\n⏳ Ожидай результат...`);
      } else {
        await tg.send(chatId, `❌ ${JSON.stringify(result).substring(0, 400)}`);
      }
    } catch (e) { await tg.send(chatId, `❌ ${e.message}`); }
    return;
  }

  // ─────── Нужен KV ───────

  if (!env.BOT_KV) { await tg.send(chatId, "❌ KV не привязан! /diagnostic"); return; }

  let config = await getConfig(env);

  // Первый = админ
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
`🤖 <b>Image Generator Bot v10</b>

<b>🔍 Диагностика:</b>
/ping — статус бота
/diagnostic — проверка компонентов
/checkkey — проверка API ключа
/testimg — тест отправки фото
/testsfw — тест генерации (пейзаж)
/debuggen — тест с полным дебагом

<b>📌 Настройка:</b>
/setchat — текущий чат для постинга
/setprompt &lt;текст&gt; — общая тема
/setinterval &lt;мин&gt; — интервал постинга
/setcount &lt;1-10&gt; — картинок за раз

<b>🎨 Модель и LoRA:</b>
/setmodel &lt;имя&gt; — выбрать модель
/listmodels — список доступных
/searchlora &lt;запрос&gt; — поиск LoRA
/addlora &lt;id&gt; [сила] [clip] — добавить
/removelora &lt;id&gt; — удалить
/listloras — показать

<b>⚙️ Параметры:</b>
/setsize &lt;W&gt; &lt;H&gt; — размер
/setsteps &lt;1-50&gt; — шаги
/setcfg &lt;1-30&gt; — CFG Scale
/setsampler — сэмплер
/setneg &lt;текст&gt; — негативный промпт
/nsfw on|off — NSFW режим
/setclipskip &lt;1-4&gt; — CLIP Skip
/hiresfix on|off — HiRes Fix
/karras on|off — Karras
/setllm &lt;model&gt; — LLM модель

<b>▶️ Управление:</b>
/enable — вкл автопостинг
/disable — выкл
/generate — сгенерировать сейчас
/status — все настройки
/pending — очередь генерации
/cancel — очистить очередь
/censorlog — лог цензуры
/clearcensorlog — очистить лог
/resetadmin — сбросить админа`
      );
      break;
    }

    case "/resetadmin": {
      config.adminId = userId;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Админ: <code>${userId}</code>`);
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
      if (!p) { await tg.send(chatId, "❌ /setprompt &lt;ваша тема&gt;\n\nПример:\n<code>/setprompt beautiful anime girl in fantasy world</code>"); break; }
      config.generalPrompt = p;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Промпт:\n<code>${p}</code>`);
      break;
    }

    case "/setinterval": {
      const m = parseInt(args[0]);
      if (isNaN(m) || m < 1) { await tg.send(chatId, "❌ /setinterval &lt;минуты&gt; (мин. 1)"); break; }
      config.interval = m;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Интервал: ${m} мин.`);
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
      if (!name) { await tg.send(chatId, "❌ /setmodel &lt;название&gt;\nИспользуй /listmodels"); break; }
      config.model = name;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Модель: <code>${name}</code>`);
      break;
    }

    case "/listmodels": {
      await tg.send(chatId, "⏳ Загружаю список моделей...");
      try {
        const models = await hordeGetModels();
        const sorted = models.filter(m => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 30);
        let txt = "📋 <b>Модели (топ-30):</b>\n\n";
        for (const m of sorted) {
          const tag = (m.name.includes("XL") || m.name.includes("SDXL") || m.name.includes("Pony")) ? "🟢" : "⚪";
          txt += `${tag} <code>${m.name}</code> (${m.count} воркеров)\n`;
        }
        txt += "\n🟢 SDXL/Pony  ⚪ SD1.5\nКопируй: /setmodel &lt;название&gt;";
        await tg.send(chatId, txt);
      } catch (e) { await tg.send(chatId, `❌ ${e.message}`); }
      break;
    }

    case "/searchlora": {
      const q = args.join(" ");
      if (!q) { await tg.send(chatId, "❌ /searchlora &lt;запрос на английском&gt;"); break; }
      await tg.send(chatId, "🔍 Ищу на CivitAI...");
      try {
        const resp = await fetch(`https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(q)}&limit=8&sort=Highest%20Rated&nsfw=true`);
        const data = await resp.json();
        if (!data.items?.length) { await tg.send(chatId, "😕 Ничего не найдено"); break; }
        let txt = `🔍 <b>LoRA: "${q}"</b>\n\n`;
        data.items.forEach(item => {
          const ver = item.modelVersions?.[0];
          txt += `${item.nsfw ? "🔞" : "✅"} <b>${item.name}</b> [${ver?.baseModel || "?"}]\n`;
          txt += `   ➕ <code>/addlora ${ver?.id || "?"} 0.8</code>\n\n`;
        });
        await tg.send(chatId, txt);
      } catch (e) { await tg.send(chatId, `❌ ${e.message}`); }
      break;
    }

    case "/addlora": {
      const id = args[0], str = parseFloat(args[1]) || 0.8, clip = parseFloat(args[2]) || 1;
      if (!id) { await tg.send(chatId, "❌ /addlora &lt;version_id&gt; [strength] [clip]\nНайди через /searchlora"); break; }
      config.loras = (config.loras || []).filter(l => String(l.name) !== String(id));
      config.loras.push({ name: id, strength: str, clip });
      await saveConfig(env, config);
      await tg.send(chatId, `✅ LoRA <code>${id}</code> (strength: ${str}, clip: ${clip})`);
      break;
    }

    case "/removelora": {
      if (!args[0]) { await tg.send(chatId, "❌ /removelora &lt;id&gt;"); break; }
      config.loras = (config.loras || []).filter(l => String(l.name) !== String(args[0]));
      await saveConfig(env, config);
      await tg.send(chatId, `✅ LoRA <code>${args[0]}</code> удалена`);
      break;
    }

    case "/listloras": {
      const loras = config.loras || [];
      if (!loras.length) { await tg.send(chatId, "📋 Нет добавленных LoRA\nИспользуй /searchlora для поиска"); break; }
      let txt = "📋 <b>Ваши LoRA:</b>\n\n";
      loras.forEach(l => {
        txt += `• <code>${l.name}</code> (str: ${l.strength}, clip: ${l.clip})\n  ❌ /removelora ${l.name}\n\n`;
      });
      await tg.send(chatId, txt);
      break;
    }

    case "/setsize": {
      const w = parseInt(args[0]), h = parseInt(args[1]);
      if (isNaN(w) || isNaN(h) || w < 256 || h < 256 || w > 2048 || h > 2048) {
        await tg.send(chatId, "❌ /setsize &lt;W&gt; &lt;H&gt; (256-2048)\n\n<code>/setsize 704 1024</code> — портрет\n<code>/setsize 1024 1024</code> — квадрат\n<code>/setsize 1216 832</code> — ландшафт");
        break;
      }
      config.width = Math.round(w / 64) * 64;
      config.height = Math.round(h / 64) * 64;
      await saveConfig(env, config);
      await tg.send(chatId, `✅ Размер: ${config.width}×${config.height}`);
      break;
    }

    case "/setsteps": { const s = parseInt(args[0]); if (isNaN(s) || s < 1 || s > 50) { await tg.send(chatId, "❌ /setsteps &lt;1-50&gt;"); break; } config.steps = s; await saveConfig(env, config); await tg.send(chatId, `✅ Шаги: ${s}`); break; }
    case "/setcfg": { const c = parseFloat(args[0]); if (isNaN(c) || c < 1 || c > 30) { await tg.send(chatId, "❌ /setcfg &lt;1-30&gt;"); break; } config.cfgScale = c; await saveConfig(env, config); await tg.send(chatId, `✅ CFG: ${c}`); break; }

    case "/setsampler": {
      const samplers = ["k_euler","k_euler_a","k_lms","k_heun","k_dpm_2","k_dpm_2_a","k_dpmpp_2s_a","k_dpmpp_2m","k_dpmpp_sde","DDIM"];
      if (!args[0] || !samplers.includes(args[0])) {
        await tg.send(chatId, `⚙️ <b>Сэмплеры:</b>\n${samplers.map(s => `<code>${s}</code>`).join("\n")}`);
        break;
      }
      config.sampler = args[0]; await saveConfig(env, config);
      await tg.send(chatId, `✅ Сэмплер: ${args[0]}`); break;
    }

    case "/setneg": { config.negativePrompt = args.join(" ") || DEFAULT_CONFIG.negativePrompt; await saveConfig(env, config); await tg.send(chatId, `✅ Негативный промпт обновлён`); break; }

    case "/nsfw": {
      if (args[0] !== "on" && args[0] !== "off") { await tg.send(chatId, "❌ /nsfw on или /nsfw off"); break; }
      config.nsfw = args[0] === "on"; await saveConfig(env, config);
      let w = config.nsfw && getApiKey(env) === "0000000000" ? "\n\n⚠️ Нужен HORDE_API_KEY! /checkkey" : "";
      await tg.send(chatId, `✅ NSFW: ${config.nsfw ? "🔞 ВКЛ" : "ВЫКЛ"}${w}`); break;
    }

    case "/setclipskip": { const cs = parseInt(args[0]); if (isNaN(cs) || cs < 1 || cs > 4) { await tg.send(chatId, "❌ /setclipskip &lt;1-4&gt;"); break; } config.clipSkip = cs; await saveConfig(env, config); await tg.send(chatId, `✅ CLIP Skip: ${cs}`); break; }
    case "/hiresfix": { if (args[0] !== "on" && args[0] !== "off") { await tg.send(chatId, `/hiresfix on|off [denoising]\nСейчас: ${config.hiresFix?"ON":"OFF"} (${config.hiresFixDenoising||0.65})`); break; } config.hiresFix = args[0] === "on"; if (args[1]) config.hiresFixDenoising = parseFloat(args[1]) || 0.65; await saveConfig(env, config); await tg.send(chatId, `✅ HiRes Fix: ${config.hiresFix?"ON":"OFF"} (${config.hiresFixDenoising||0.65})`); break; }
    case "/karras": { if (args[0] !== "on" && args[0] !== "off") { await tg.send(chatId, `/karras on|off (сейчас: ${config.karras !== false?"ON":"OFF"})`); break; } config.karras = args[0] === "on"; await saveConfig(env, config); await tg.send(chatId, `✅ Karras: ${config.karras?"ON":"OFF"}`); break; }

    case "/setllm": {
      const l = args.join(" ");
      if (!l) { await tg.send(chatId, `📎 Текущая: <code>${config.llmModel || "auto"}</code>\n\n<b>Бесплатные:</b>\n<code>meta-llama/llama-3.1-8b-instruct:free</code>\n<code>google/gemma-2-9b-it:free</code>\n<code>mistralai/mistral-7b-instruct:free</code>`); break; }
      config.llmModel = l; await saveConfig(env, config);
      await tg.send(chatId, `✅ LLM: <code>${l}</code>`); break;
    }

    case "/enable": {
      if (!config.chatId) { await tg.send(chatId, "❌ Сначала /setchat"); break; }
      if (!config.generalPrompt) { await tg.send(chatId, "❌ Сначала /setprompt"); break; }
      config.enabled = true; await saveConfig(env, config);
      await tg.send(chatId, `🟢 <b>Автопостинг включён!</b>\n\n⏱ Интервал: ${config.interval} мин.\n📸 По ${config.count} шт.`);
      break;
    }

    case "/disable": {
      config.enabled = false; await saveConfig(env, config);
      await tg.send(chatId, "🔴 Автопостинг выключен");
      break;
    }

    case "/status": {
      const key = getApiKey(env);
      const pending = await KV.list(env, "pending:");
      const clog = await getCensorLog(env);
      const lorasTxt = (config.loras || []).map(l => `  • <code>${l.name}</code> (${l.strength})`).join("\n") || "  нет";

      await tg.send(chatId,
`📊 <b>Статус v10</b>

<b>Автопост:</b> ${config.enabled ? "🟢 ВКЛ" : "🔴 ВЫКЛ"}
<b>Чат:</b> <code>${config.chatId || "не задан"}</code>
<b>Интервал:</b> ${config.interval} мин. × ${config.count} шт.

<b>Промпт:</b>
<code>${config.generalPrompt || "не задан"}</code>

<b>Модель:</b> <code>${config.model}</code>
<b>Размер:</b> ${config.width}×${config.height}
<b>Шаги:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}
<b>Сэмплер:</b> ${config.sampler}
<b>CLIP Skip:</b> ${config.clipSkip || 2}
<b>Karras:</b> ${config.karras !== false ? "✅" : "❌"} | <b>HiRes:</b> ${config.hiresFix ? "✅" : "❌"}
<b>NSFW:</b> ${config.nsfw ? "🔞 да" : "нет"}

<b>Horde:</b> ${key === "0000000000" ? "❌ анонимный" : "✅ " + key.substring(0, 8) + "..."}

<b>LoRA:</b>
${lorasTxt}

<b>LLM:</b> <code>${config.llmModel || env.LLM_MODEL || "auto"}</code>
<b>Цензура:</b> ${clog.length} случаев
<b>В очереди:</b> ${pending.keys.length}`
      );
      break;
    }

    case "/debuggen": {
      await tg.send(chatId, `🧪 <b>Debug генерация</b>\n\n⚙️ Модель: <code>${config.model}</code>\n⚙️ r2: true (URL + download)\n\nЗапуск...`);
      const prompt = "beautiful woman, elegant dress, professional studio photo, soft lighting, detailed face, masterpiece, best quality, highly detailed";
      try {
        const result = await hordeSubmit(prompt, config, env);
        if (result.id) {
          await KV.put(env, `pending:${result.id}`, JSON.stringify({
            chatId, prompt, at: Date.now(), notify: chatId, debug: true, retries: 0,
          }), { expirationTtl: 3600 });
          await tg.send(chatId, `📤 ID: <code>${result.id}</code>\n⏳ Ожидай отчёт...` + (result.message ? `\n⚠️ ${result.message}` : ""));
        } else { await tg.send(chatId, `❌ ${JSON.stringify(result).substring(0, 400)}`); }
      } catch (e) { await tg.send(chatId, `❌ ${e.message}`); }
      break;
    }

    case "/generate": {
      if (!config.generalPrompt) { await tg.send(chatId, "❌ Сначала /setprompt"); break; }
      const target = config.chatId || chatId;
      await tg.send(chatId, `⏳ Генерирую ${config.count} изображений...`);
      for (let i = 0; i < config.count; i++) {
        try {
          const prompt = await generatePrompt(config.generalPrompt, env);
          await tg.send(chatId, `🎨 #${i + 1}: <code>${prompt.substring(0, 200)}</code>`);
          const result = await hordeSubmit(prompt, config, env);
          if (result.id) {
            await KV.put(env, `pending:${result.id}`, JSON.stringify({
              chatId: target, prompt, at: Date.now(), notify: chatId, retries: 0,
            }), { expirationTtl: 3600 });
            await tg.send(chatId, `📤 ID: <code>${result.id}</code>`);
          } else { await tg.send(chatId, `❌ ${JSON.stringify(result).substring(0, 300)}`); }
        } catch (e) { await tg.send(chatId, `❌ ${e.message}`); }
      }
      break;
    }

    case "/pending": {
      const list = await KV.list(env, "pending:");
      if (!list.keys.length) { await tg.send(chatId, "📋 Очередь пуста"); break; }
      let txt = `📋 <b>В очереди: ${list.keys.length}</b>\n\n`;
      for (const key of list.keys.slice(0, 10)) {
        const id = key.name.replace("pending:", "");
        try {
          const check = await hordeCheck(id);
          const status = check.done ? "✅ Готово" : check.processing ? "⚙️ Генерируется" : `⏳ Очередь #${check.queue_position}`;
          txt += `🔸 <code>${id}</code>\n   ${status} | ~${check.wait_time}с\n\n`;
        } catch {
          txt += `🔸 <code>${id}</code> — не удалось проверить\n\n`;
        }
      }
      await tg.send(chatId, txt);
      break;
    }

    case "/cancel": {
      const list = await KV.list(env, "pending:");
      for (const key of list.keys) await KV.del(env, key.name);
      await tg.send(chatId, `🗑 Удалено из очереди: ${list.keys.length}`);
      break;
    }

    case "/censorlog": {
      const log = await getCensorLog(env);
      if (!log.length) { await tg.send(chatId, "📋 Лог цензуры пуст"); break; }
      let txt = `🚫 <b>Лог цензуры: ${log.length}</b>\n\n`;
      log.slice(-10).forEach(entry => {
        txt += `• <code>${entry.w}</code> [${entry.r}]\n  ${new Date(entry.t).toISOString().substring(0, 16)}\n\n`;
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

    default: {
      if (cmd.startsWith("/")) await tg.send(chatId, "❓ Неизвестная команда — /help");
    }
  }
}

// ══════════════════════════════════════
//  CRON — Проверка очереди каждую минуту
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

      // Таймаут 20 мин
      if (Date.now() - data.at > 20 * 60 * 1000) {
        await KV.del(env, key.name);
        if (data.notify) await tg.send(data.notify, `⏰ Таймаут генерации: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      console.log(`[CRON] ${id}: done=${check.done} proc=${check.processing} q=${check.queue_position}`);

      if (!check.done) continue;

      // ═══ ГОТОВО! ═══
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
        if (data.notify) await tg.send(data.notify, `⚠️ Нет результатов генерации`);
        continue;
      }

      let anySent = false;
      let anySmall = false;

      for (const gen of gens) {
        const worker = gen.worker_name || "?";

        // Debug — подробный отчёт
        if (data.debug && data.notify) {
          let imgInfo = "null";
          if (gen.img) {
            imgInfo = gen.img.startsWith("http")
              ? `URL (${gen.img.substring(0, 60)}...)`
              : `base64 (${gen.img.length} chars)`;
          }
          await tg.send(data.notify,
            `🔍 <b>Результат:</b>\n` +
            `   Censored флаг: ${gen.censored ? "🔴 да" : "✅ нет"}\n` +
            `   Worker: <code>${worker}</code>\n` +
            `   Model: <code>${gen.model || "?"}</code>\n` +
            `   Seed: ${gen.seed || "?"}\n` +
            `   Image: ${imgInfo}`
          );
        }

        if (!gen.img) {
          if (data.notify) await tg.send(data.notify, `⚠️ Нет данных картинки`);
          continue;
        }

        // ── ОТПРАВЛЯЕМ (игнорируем censored флаг, проверяем только размер) ──
        if (data.notify) await tg.send(data.notify, `📨 Скачиваю и отправляю...`);

        const caption = data.prompt ? `🎨 <i>${data.prompt.substring(0, 150)}</i>` : "";
        const { sent, tooSmall } = await deliverImage(tg, data.chatId, gen.img, caption, data.notify);

        if (sent) {
          anySent = true;
        } else if (tooSmall) {
          anySmall = true;
          await addCensorLog(env, worker, tooSmall ? "small" : "fail");
        }
      }

      await KV.del(env, key.name);

      // ── Авто-retry при маленьких картинках ──
      if (anySmall && !anySent && !data.sfwTest) {
        const retries = (data.retries || 0) + 1;
        if (retries < MAX_RETRIES) {
          try {
            const nr = await hordeSubmit(data.prompt, config, env);
            if (nr.id) {
              await KV.put(env, `pending:${nr.id}`, JSON.stringify({
                ...data, at: Date.now(), retries,
              }), { expirationTtl: 3600 });
              if (data.notify) await tg.send(data.notify, `🔄 Повтор ${retries}/${MAX_RETRIES}: <code>${nr.id}</code>`);
            }
          } catch (e) { console.error("[CRON] retry:", e.message); }
        } else {
          if (data.notify) await tg.send(data.notify,
            `❌ <b>${MAX_RETRIES} попытки — все заглушки!</b>\n\n` +
            `Попробуй:\n` +
            `1. /testsfw — работает ли генерация вообще\n` +
            `2. /checkkey — валиден ли ключ\n` +
            `3. /setmodel — другую модель\n` +
            `4. /censorlog — какие воркеры блокируют`
          );
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

  console.log("[CRON] Auto-posting!");
  await KV.put(env, "last_post_time", String(now));

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env);
      if (result.id) {
        await KV.put(env, `pending:${result.id}`, JSON.stringify({
          chatId: config.chatId, prompt, at: now, notify: null, retries: 0,
        }), { expirationTtl: 3600 });
        console.log("[CRON] Queued:", result.id);
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
        catch (e) {
          console.error("[WH]", e.message, e.stack);
          try { new Telegram(env.TELEGRAM_BOT_TOKEN).send(upd.message.chat.id, `💥 <code>${e.message}</code>`); } catch {}
        }
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
      const key = getApiKey(env);
      return new Response(
        `Webhook: ${wh}\n\n${JSON.stringify(res, null, 2)}\n\n` +
        `KV: ${env.BOT_KV ? "OK" : "MISSING!"}\n` +
        `Horde: ${key === "0000000000" ? "ANONYMOUS!" : "OK (" + key.substring(0, 8) + "...)"}\n` +
        `OpenRouter: ${env.OPENROUTER_API_KEY ? "OK" : "not set"}\n` +
        `Mode: r2=true + immediate download`,
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        kv: !!env.BOT_KV,
        telegram: !!env.TELEGRAM_BOT_TOKEN,
        horde: getApiKey(env) !== "0000000000",
        openrouter: !!env.OPENROUTER_API_KEY,
        version: 10,
      }, null, 2));
    }

    return new Response("🤖 Image Bot v10\n/setup — настроить webhook\n/health — проверить статус");
  },

  async scheduled(event, env, ctx) {
    try { await processScheduled(env); }
    catch (e) { console.error("[CRON] CRASH:", e.message, e.stack); }
  },
};