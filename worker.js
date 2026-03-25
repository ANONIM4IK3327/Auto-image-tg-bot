// ============================================================
//  Telegram Image Bot — Cloudflare Workers v4
//  FIX: trusted_workers:true, r2:true, censored detection,
//        hires_fix support, matching working Horde params
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
  cfgScale: 7,
  sampler: "k_euler_a",
  nsfw: true,
  negativePrompt:
    "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "",
  clipSkip: 2,
  trustedWorkers: true,
  hiresFix: false,
  hiresFixDenoising: 0.65,
  karras: true,
  allowDowngrade: true,
};

const HORDE = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:4.0:github" };

// ──────────── TELEGRAM ────────────

class Telegram {
  constructor(token) {
    this.api = `https://api.telegram.org/bot${token}`;
  }

  async call(method, body) {
    console.log(`[TG] ${method}`);
    const r = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await r.json();
    if (!result.ok) {
      console.error(`[TG] ${method} FAILED:`, JSON.stringify(result));
    }
    return result;
  }

  msg(chatId, text) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    });
  }

  sendPhotoUrl(chatId, url, caption = "") {
    return this.call("sendPhoto", {
      chat_id: chatId,
      photo: url,
      caption: caption.substring(0, 1024),
      parse_mode: "HTML",
    });
  }

  async sendPhotoBlob(chatId, blob, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", blob, "image.webp");
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.api}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    const result = await r.json();
    if (!result.ok) {
      console.error("[TG] sendPhotoBlob FAILED:", JSON.stringify(result));
    }
    return result;
  }
}

// ──────────── KV ────────────

async function kvGet(env, key, type = "text") {
  if (!env.BOT_KV) return null;
  try {
    return await env.BOT_KV.get(key, type);
  } catch (e) {
    console.error(`[KV] GET "${key}":`, e.message);
    return null;
  }
}

async function kvPut(env, key, value, options = {}) {
  if (!env.BOT_KV) throw new Error("KV не привязан!");
  await env.BOT_KV.put(key, value, options);
}

async function kvDelete(env, key) {
  if (!env.BOT_KV) return;
  await env.BOT_KV.delete(key);
}

async function kvList(env, prefix) {
  if (!env.BOT_KV) return { keys: [] };
  return await env.BOT_KV.list({ prefix });
}

async function getConfig(env) {
  const stored = await kvGet(env, "config", "json");
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function saveConfig(env, config) {
  await kvPut(env, "config", JSON.stringify(config));
}

// ──────────── AI HORDE ────────────

async function hordeSubmit(prompt, config, apiKey) {
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

  // HiRes Fix
  if (config.hiresFix) {
    params.hires_fix = true;
    params.hires_fix_denoising_strength = config.hiresFixDenoising || 0.65;
  }

  // LoRA
  if (config.loras?.length > 0) {
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
    nsfw: true,                                    // всегда true — разрешаем NSFW контент
    censor_nsfw: false,                            // не цензурировать
    trusted_workers: config.trustedWorkers !== false, // КРИТИЧНО: только проверенные воркеры
    models: [config.model],
    r2: true,                                      // R2 URL (стабильнее чем base64)
    replacement_filter: false,                     // не заменять слова в промпте
    shared: false,
    slow_workers: false,                           // быстрые воркеры
    allow_downgrade: config.allowDowngrade !== false,
    dry_run: false,
  };

  console.log("[HORDE] Submit:", JSON.stringify(body));

  const resp = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey || "0000000000",
      ...HORDE_HEADERS,
    },
    body: JSON.stringify(body),
  });

  const result = await resp.json();
  console.log("[HORDE] Response:", JSON.stringify(result));
  return result;
}

async function hordeCheck(id) {
  const r = await fetch(`${HORDE}/generate/check/${id}`, {
    headers: HORDE_HEADERS,
  });
  return r.json();
}

async function hordeResult(id) {
  const r = await fetch(`${HORDE}/generate/status/${id}`, {
    headers: HORDE_HEADERS,
  });
  return r.json();
}

async function hordeModels() {
  const r = await fetch(`${HORDE}/status/models?type=image`, {
    headers: HORDE_HEADERS,
  });
  return r.json();
}

// ──────────── СКАЧАТЬ КАРТИНКУ ────────────

async function fetchImageBlob(imgSource) {
  if (!imgSource) return null;

  // URL (R2 или другой)
  if (imgSource.startsWith("http")) {
    try {
      const resp = await fetch(imgSource);
      if (!resp.ok) {
        console.error("[IMG] fetch failed:", resp.status, resp.statusText);
        return null;
      }
      const blob = await resp.blob();
      console.log("[IMG] fetched URL, size:", blob.size);
      return blob;
    } catch (e) {
      console.error("[IMG] fetch error:", e.message);
      return null;
    }
  }

  // Base64 (fallback)
  try {
    const clean = imgSource.replace(/^data:image\/\w+;base64,/, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "image/webp" });
    console.log("[IMG] decoded base64, size:", blob.size);
    return blob;
  } catch (e) {
    console.error("[IMG] base64 error:", e.message);
    return null;
  }
}

// ──────────── ПРОМПТЫ ────────────

const V_ANGLES = [
  "from above", "low angle looking up", "eye level",
  "dutch angle", "bird's eye view", "over the shoulder",
  "close-up", "wide shot", "portrait framing",
  "three-quarter view", "profile view", "from behind",
];
const V_LIGHT = [
  "golden hour sunlight", "blue hour twilight", "chiaroscuro lighting",
  "soft overcast light", "neon glow", "moonlit night",
  "rim lighting", "dappled light", "harsh shadows",
  "candlelit ambiance", "god rays", "backlit silhouette",
];
const V_STYLE = [
  "photorealistic", "concept art", "oil painting",
  "watercolor", "anime", "dark fantasy", "hyperrealistic 8k",
  "noir", "surrealist", "pop art", "renaissance", "vaporwave",
];
const V_MOOD = [
  "serene", "dramatic", "mysterious", "vibrant",
  "ethereal", "dark", "intimate", "epic",
  "melancholic", "playful", "suspenseful", "romantic",
];
const V_DETAIL = [
  "intricate details", "rough textures", "smooth finish",
  "baroque decoration", "clean lines", "aged patina",
  "sharp focus", "bokeh", "particle effects", "reflections",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function templatePrompt(base) {
  return [
    base, pick(V_ANGLES), pick(V_LIGHT), pick(V_STYLE),
    pick(V_MOOD), pick(V_DETAIL), pick(V_DETAIL),
    "masterpiece", "best quality", "highly detailed",
  ].join(", ");
}

async function generatePromptLLM(instruction, apiKey, model) {
  const directives = [
    "unusual perspective", "dramatic lighting", "unexpected environment",
    "intricate textures", "bold colors", "dynamic motion",
    "atmospheric scene", "extreme framing", "cinematic composition",
    "weather effects", "reflections", "futuristic aesthetic",
  ];

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://telegram-image-bot.workers.dev",
        "X-Title": "TelegramImageBot",
      },
      body: JSON.stringify({
        model: model || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          {
            role: "system",
            content: `You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases for image generation. No explanations, no quotes, no markdown, no numbering. Under 100 words. Creative direction: ${pick(directives)}`,
          },
          {
            role: "user",
            content: `Create a unique detailed image prompt for: ${instruction}`,
          },
        ],
        temperature: 1.3,
        max_tokens: 200,
      }),
    });

    const data = await resp.json();
    if (data.choices?.[0]?.message?.content) {
      let p = data.choices[0].message.content.trim();
      p = p.replace(/^["'`*]+|["'`*]+$/g, "").trim();
      if (p.length > 10) return p;
    }
  } catch (e) {
    console.error("[LLM] Error:", e.message);
  }

  return templatePrompt(instruction);
}

async function generatePrompt(instruction, env) {
  if (env.OPENROUTER_API_KEY) {
    const config = await getConfig(env);
    const model =
      config.llmModel || env.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
    return generatePromptLLM(instruction, env.OPENROUTER_API_KEY, model);
  }
  return templatePrompt(instruction);
}

// ──────────── ОТПРАВКА КАРТИНКИ В TELEGRAM ────────────

async function sendGeneratedImage(tg, chatId, imgSource, caption, notifyChat) {
  // Сначала скачиваем
  const blob = await fetchImageBlob(imgSource);

  if (!blob || blob.size < 1000) {
    // Слишком маленький = вероятно чёрный квадрат или ошибка
    console.warn("[SEND] Blob too small or null:", blob?.size);
    if (notifyChat) {
      await tg.msg(
        notifyChat,
        "⚠️ Получена пустая/повреждённая картинка. Возможно цензура воркера."
      );
    }
    return false;
  }

  // Отправляем как файл (blob)
  const sent = await tg.sendPhotoBlob(chatId, blob, caption);

  if (sent.ok) {
    console.log("[SEND] OK, size:", blob.size);
    return true;
  }

  // Фолбэк: пробуем URL напрямую (если это URL)
  if (imgSource.startsWith("http")) {
    console.log("[SEND] Blob failed, trying direct URL...");
    const sent2 = await tg.sendPhotoUrl(chatId, imgSource, caption);
    if (sent2.ok) return true;
  }

  if (notifyChat) {
    await tg.msg(notifyChat, `❌ Не удалось отправить: ${sent.description || "unknown error"}`);
  }
  return false;
}

// ──────────── ОБРАБОТКА КОМАНД ────────────

async function handleCommand(message, env) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = message.text || "";

  console.log(`[CMD] user=${userId} chat=${chatId} "${text}"`);

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("[CMD] No TELEGRAM_BOT_TOKEN!");
    return;
  }

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  // ─── Команды без KV ───

  if (cmd === "/ping") {
    await tg.msg(
      chatId,
      `🏓 Pong!\n\nChat: <code>${chatId}</code>\nUser: <code>${userId}</code>\nKV: ${env.BOT_KV ? "✅" : "❌"}\nHorde key: ${env.HORDE_API_KEY ? "✅" : "❌ NSFW не будет работать!"}\nOpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️ шаблоны"}`
    );
    return;
  }

  if (cmd === "/diagnostic") {
    let txt = "🔧 <b>Диагностика v4</b>\n\n";
    txt += `BOT_KV: ${env.BOT_KV ? "✅" : "❌"}\n`;
    txt += `TOKEN: ${env.TELEGRAM_BOT_TOKEN ? "✅" : "❌"}\n`;
    txt += `HORDE_KEY: ${env.HORDE_API_KEY ? "✅" : "❌ НЕОБХОДИМ для NSFW!"}\n`;
    txt += `OPENROUTER: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}\n`;
    txt += `\nChat: <code>${chatId}</code> | User: <code>${userId}</code>\n`;

    if (!env.HORDE_API_KEY) {
      txt += `\n🔴 <b>HORDE_API_KEY отсутствует!</b>\n`;
      txt += `Без него NSFW картинки будут чёрными.\n`;
      txt += `1. Иди на https://stablehorde.net/register\n`;
      txt += `2. Получи API key\n`;
      txt += `3. Добавь в Workers → Settings → Secrets\n`;
      txt += `   Имя: <code>HORDE_API_KEY</code>`;
    }

    if (env.BOT_KV) {
      try {
        await env.BOT_KV.put("_test", "ok");
        const val = await env.BOT_KV.get("_test");
        txt += `\nKV: ${val === "ok" ? "✅" : "❌"}`;
      } catch (e) {
        txt += `\nKV: ❌ ${e.message}`;
      }
    }

    await tg.msg(chatId, txt);
    return;
  }

  // ─── Все остальные требуют KV ───

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
    await tg.msg(chatId, `🔒 Админ: ${config.adminId} | Вы: ${userId}`);
    return;
  }

  switch (cmd) {
    case "/start":
    case "/help": {
      await tg.msg(
        chatId,
        `🤖 <b>Image Bot v4</b>

<b>Тест:</b> /ping /diagnostic

<b>Настройка:</b>
/setchat — чат для постинга
/setprompt &lt;текст&gt; — тема
/setinterval &lt;мин&gt;
/setcount &lt;1-10&gt;

<b>Модель:</b>
/setmodel &lt;имя&gt; | /listmodels
/searchlora &lt;запрос&gt;
/addlora &lt;id&gt; [str] [clip]
/removelora &lt;id&gt; | /listloras

<b>Параметры:</b>
/setsize &lt;W&gt; &lt;H&gt;
/setsteps /setcfg /setsampler
/setneg &lt;текст&gt;
/nsfw on|off
/setclipskip &lt;1-4&gt;
/setllm &lt;model&gt;
/trusted on|off
/hiresfix on|off [denoising]
/karras on|off

<b>Управление:</b>
/enable /disable
/generate — сейчас
/status /pending /cancel
/resetadmin
/testnsfw — тест NSFW`
      );
      break;
    }

    case "/resetadmin": {
      config.adminId = userId;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Админ: <code>${userId}</code>`);
      break;
    }

    case "/setchat": {
      config.chatId = chatId;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Чат: <code>${chatId}</code>`);
      break;
    }

    case "/setprompt": {
      const prompt = args.join(" ");
      if (!prompt) {
        await tg.msg(chatId, "❌ /setprompt &lt;тема&gt;\nПример: <code>/setprompt anime girl fantasy</code>");
        break;
      }
      config.generalPrompt = prompt;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Промпт: <code>${prompt}</code>`);
      break;
    }

    case "/setinterval": {
      const m = parseInt(args[0]);
      if (isNaN(m) || m < 1) { await tg.msg(chatId, "❌ /setinterval &lt;минуты&gt;"); break; }
      config.interval = m;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ ${m} мин`);
      break;
    }

    case "/setcount": {
      const n = parseInt(args[0]);
      if (isNaN(n) || n < 1 || n > 10) { await tg.msg(chatId, "❌ /setcount 1-10"); break; }
      config.count = n;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ ${n} шт`);
      break;
    }

    case "/setmodel": {
      const name = args.join(" ");
      if (!name) { await tg.msg(chatId, "❌ /setmodel &lt;имя&gt;\n/listmodels"); break; }
      config.model = name;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ <code>${name}</code>`);
      break;
    }

    case "/listmodels": {
      await tg.msg(chatId, "⏳...");
      try {
        const models = await hordeModels();
        const sorted = models.filter((m) => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 30);
        let txt = "📋 <b>Модели:</b>\n\n";
        for (const m of sorted) {
          const xl = (m.name.includes("XL") || m.name.includes("SDXL") || m.name.includes("Pony")) ? "🟢" : "⚪";
          txt += `${xl} <code>${m.name}</code> (${m.count}w)\n`;
        }
        txt += "\n🟢 SDXL/Pony ⚪ SD1.5\n/setmodel &lt;имя&gt;";
        await tg.msg(chatId, txt);
      } catch (e) {
        await tg.msg(chatId, `❌ ${e.message}`);
      }
      break;
    }

    case "/searchlora": {
      const query = args.join(" ");
      if (!query) { await tg.msg(chatId, "❌ /searchlora &lt;запрос&gt;"); break; }
      await tg.msg(chatId, "🔍...");
      try {
        const url = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(query)}&limit=8&sort=Highest%20Rated&nsfw=true`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!data.items?.length) { await tg.msg(chatId, "😕 Не найдено"); break; }
        let txt = `🔍 "${query}":\n\n`;
        for (const item of data.items) {
          const ver = item.modelVersions?.[0];
          const vid = ver?.id || "?";
          const base = ver?.baseModel || "?";
          txt += `${item.nsfw ? "🔞" : "✅"} <b>${item.name}</b> [${base}]\n➕ <code>/addlora ${vid} 0.8</code>\n\n`;
        }
        await tg.msg(chatId, txt);
      } catch (e) { await tg.msg(chatId, `❌ ${e.message}`); }
      break;
    }

    case "/addlora": {
      const id = args[0];
      const str = parseFloat(args[1]) || 0.8;
      const clip = parseFloat(args[2]) || 1;
      if (!id) { await tg.msg(chatId, "❌ /addlora &lt;id&gt; [str] [clip]"); break; }
      config.loras = (config.loras || []).filter((l) => String(l.name) !== String(id));
      config.loras.push({ name: id, strength: str, clip });
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ LoRA ${id} (str:${str} clip:${clip})`);
      break;
    }

    case "/removelora": {
      const rid = args[0];
      if (!rid) { await tg.msg(chatId, "❌ /removelora &lt;id&gt;"); break; }
      config.loras = (config.loras || []).filter((l) => String(l.name) !== String(rid));
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Удалено ${rid}`);
      break;
    }

    case "/listloras": {
      const ll = config.loras || [];
      if (!ll.length) { await tg.msg(chatId, "Нет LoRA. /searchlora"); break; }
      let txt = "📋 LoRA:\n\n";
      ll.forEach((l) => { txt += `• <code>${l.name}</code> (str:${l.strength} clip:${l.clip})\n  /removelora ${l.name}\n\n`; });
      await tg.msg(chatId, txt);
      break;
    }

    case "/setsize": {
      const w = parseInt(args[0]), h = parseInt(args[1]);
      if (isNaN(w) || isNaN(h) || w < 256 || h < 256 || w > 2048 || h > 2048) {
        await tg.msg(chatId, "❌ /setsize W H (256-2048)\n<code>/setsize 1024 1024</code>\n<code>/setsize 704 1024</code>\n<code>/setsize 832 1216</code>");
        break;
      }
      config.width = Math.round(w / 64) * 64;
      config.height = Math.round(h / 64) * 64;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ ${config.width}×${config.height}`);
      break;
    }

    case "/setsteps": {
      const s = parseInt(args[0]);
      if (isNaN(s) || s < 1 || s > 50) { await tg.msg(chatId, "❌ 1-50"); break; }
      config.steps = s; await saveConfig(env, config);
      await tg.msg(chatId, `✅ ${s}`); break;
    }

    case "/setcfg": {
      const c = parseFloat(args[0]);
      if (isNaN(c) || c < 1 || c > 30) { await tg.msg(chatId, "❌ 1-30"); break; }
      config.cfgScale = c; await saveConfig(env, config);
      await tg.msg(chatId, `✅ CFG ${c}`); break;
    }

    case "/setsampler": {
      const list = ["k_euler","k_euler_a","k_lms","k_heun","k_dpm_2","k_dpm_2_a","k_dpmpp_2s_a","k_dpmpp_2m","k_dpmpp_sde","DDIM"];
      if (!args[0] || !list.includes(args[0])) {
        await tg.msg(chatId, `Сэмплеры:\n${list.map(s=>`<code>${s}</code>`).join("\n")}`);
        break;
      }
      config.sampler = args[0]; await saveConfig(env, config);
      await tg.msg(chatId, `✅ ${args[0]}`); break;
    }

    case "/setneg": {
      config.negativePrompt = args.join(" ") || DEFAULT_CONFIG.negativePrompt;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ <code>${config.negativePrompt.substring(0,200)}</code>`);
      break;
    }

    case "/nsfw": {
      if (args[0] !== "on" && args[0] !== "off") { await tg.msg(chatId, "/nsfw on|off"); break; }
      config.nsfw = args[0] === "on";
      await saveConfig(env, config);
      let w = "";
      if (config.nsfw && !env.HORDE_API_KEY) w = "\n⚠️ Нужен HORDE_API_KEY!";
      if (config.nsfw && !config.trustedWorkers) w += "\n⚠️ trusted_workers выключен! /trusted on";
      await tg.msg(chatId, `✅ NSFW ${config.nsfw?"🔞 ON":"OFF"}${w}`);
      break;
    }

    case "/trusted": {
      if (args[0] !== "on" && args[0] !== "off") {
        await tg.msg(chatId, `trusted_workers: ${config.trustedWorkers !== false ? "✅ ON" : "❌ OFF"}\n\n/trusted on — только проверенные воркеры (NSFW работает)\n/trusted off — все воркеры (NSFW может быть заблокирован!)`);
        break;
      }
      config.trustedWorkers = args[0] === "on";
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ trusted_workers: ${config.trustedWorkers ? "ON ✅" : "OFF ⚠️"}`);
      break;
    }

    case "/hiresfix": {
      if (args[0] !== "on" && args[0] !== "off") {
        await tg.msg(chatId, `hires_fix: ${config.hiresFix?"ON":"OFF"} (denoising: ${config.hiresFixDenoising||0.65})\n/hiresfix on [0.0-1.0]\n/hiresfix off`);
        break;
      }
      config.hiresFix = args[0] === "on";
      if (args[1]) config.hiresFixDenoising = Math.max(0, Math.min(1, parseFloat(args[1]) || 0.65));
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ hires_fix: ${config.hiresFix?"ON":"OFF"} (${config.hiresFixDenoising||0.65})`);
      break;
    }

    case "/karras": {
      if (args[0] !== "on" && args[0] !== "off") {
        await tg.msg(chatId, `karras: ${config.karras !== false?"ON":"OFF"}\n/karras on|off`);
        break;
      }
      config.karras = args[0] === "on";
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ karras: ${config.karras?"ON":"OFF"}`);
      break;
    }

    case "/setclipskip": {
      const cs = parseInt(args[0]);
      if (isNaN(cs) || cs < 1 || cs > 4) { await tg.msg(chatId, "❌ 1-4"); break; }
      config.clipSkip = cs; await saveConfig(env, config);
      await tg.msg(chatId, `✅ CLIP Skip: ${cs}`); break;
    }

    case "/setllm": {
      const llm = args.join(" ");
      if (!llm) {
        await tg.msg(chatId, `Текущая: <code>${config.llmModel||env.LLM_MODEL||"auto"}</code>\n\nБесплатные:\n<code>meta-llama/llama-3.1-8b-instruct:free</code>\n<code>google/gemma-2-9b-it:free</code>\n<code>mistralai/mistral-7b-instruct:free</code>`);
        break;
      }
      config.llmModel = llm; await saveConfig(env, config);
      await tg.msg(chatId, `✅ <code>${llm}</code>`); break;
    }

    case "/enable": {
      if (!config.chatId) { await tg.msg(chatId, "❌ /setchat"); break; }
      if (!config.generalPrompt) { await tg.msg(chatId, "❌ /setprompt"); break; }
      config.enabled = true;
      await saveConfig(env, config);
      let w = "";
      if (!env.HORDE_API_KEY) w = "\n⚠️ Нет HORDE_API_KEY — NSFW чёрный!";
      await tg.msg(chatId, `🟢 Каждые ${config.interval}м по ${config.count}шт${w}`);
      break;
    }

    case "/disable": {
      config.enabled = false;
      await saveConfig(env, config);
      await tg.msg(chatId, "🔴 ВЫКЛ");
      break;
    }

    case "/status": {
      const loras = (config.loras||[]).map(l=>`  • ${l.name} (${l.strength})`).join("\n") || "  нет";
      const pend = await kvList(env, "pending:");
      await tg.msg(chatId,
`📊 <b>v4</b> ${config.enabled?"🟢":"🔴"}

Чат: <code>${config.chatId||"—"}</code>
${config.interval}м × ${config.count}шт

Промпт: <code>${config.generalPrompt||"—"}</code>

Модель: <code>${config.model}</code>
${config.width}×${config.height} | Steps:${config.steps} | CFG:${config.cfgScale}
Sampler: ${config.sampler} | CLIP:${config.clipSkip||2}
Karras: ${config.karras!==false?"✅":"❌"} | HiRes: ${config.hiresFix?"✅":"❌"}
NSFW: ${config.nsfw?"🔞":"нет"} | Trusted: ${config.trustedWorkers!==false?"✅":"❌"}
Horde key: ${env.HORDE_API_KEY?"✅":"❌"}

Neg: <code>${(config.negativePrompt||"").substring(0,100)}</code>

LoRA:
${loras}

LLM: <code>${config.llmModel||env.LLM_MODEL||"auto"}</code>
Очередь: ${pend.keys.length}`);
      break;
    }

    // ─── Тест NSFW ───
    case "/testnsfw": {
      await tg.msg(chatId, "🧪 Тестовая генерация NSFW...");

      const testPrompt = "beautiful woman, professional studio photo, elegant pose, detailed face, soft lighting, masterpiece, best quality";

      const testConfig = {
        ...config,
        width: 512,
        height: 768,
        steps: 15,
        loras: [],
      };

      try {
        const result = await hordeSubmit(testPrompt, testConfig, env.HORDE_API_KEY);

        if (result.id) {
          await kvPut(env, `pending:${result.id}`, JSON.stringify({
            chatId,
            prompt: "[NSFW TEST] " + testPrompt,
            submittedAt: Date.now(),
            notifyChat: chatId,
          }), { expirationTtl: 3600 });

          let info = `📤 <code>${result.id}</code>\n\n`;
          info += `nsfw: true\ncensor_nsfw: false\ntrusted_workers: ${testConfig.trustedWorkers !== false}\n`;
          info += `Horde key: ${env.HORDE_API_KEY ? "✅ есть" : "❌ нет!"}\n\n`;
          info += `Если картинка будет чёрная → проблема с воркерами или ключом.`;
          await tg.msg(chatId, info);
        } else {
          await tg.msg(chatId, `❌ ${JSON.stringify(result).substring(0,300)}`);
        }
      } catch (e) {
        await tg.msg(chatId, `❌ ${e.message}`);
      }
      break;
    }

    case "/generate": {
      if (!config.generalPrompt) { await tg.msg(chatId, "❌ /setprompt"); break; }
      const target = config.chatId || chatId;
      await tg.msg(chatId, `⏳ Генерирую ${config.count}...`);

      for (let i = 0; i < config.count; i++) {
        try {
          const prompt = await generatePrompt(config.generalPrompt, env);
          await tg.msg(chatId, `🎨 #${i+1}: <code>${prompt.substring(0,200)}</code>`);

          const result = await hordeSubmit(prompt, config, env.HORDE_API_KEY);

          if (result.id) {
            await kvPut(env, `pending:${result.id}`, JSON.stringify({
              chatId: target, prompt, submittedAt: Date.now(), notifyChat: chatId,
            }), { expirationTtl: 3600 });
            await tg.msg(chatId, `📤 <code>${result.id}</code>`);
          } else {
            await tg.msg(chatId, `❌ ${JSON.stringify(result).substring(0,300)}`);
          }
        } catch (e) {
          await tg.msg(chatId, `❌ ${e.message}`);
        }
      }
      break;
    }

    case "/pending": {
      const list = await kvList(env, "pending:");
      if (!list.keys.length) { await tg.msg(chatId, "📋 Пусто"); break; }
      let txt = `📋 ${list.keys.length}:\n\n`;
      for (const key of list.keys.slice(0, 10)) {
        const id = key.name.replace("pending:", "");
        try {
          const ch = await hordeCheck(id);
          txt += `• <code>${id}</code> ${ch.done?"✅":ch.processing?"⚙️":`⏳#${ch.queue_position}`} ~${ch.wait_time}с\n`;
        } catch { txt += `• <code>${id}</code> ?\n`; }
      }
      await tg.msg(chatId, txt);
      break;
    }

    case "/cancel": {
      const list = await kvList(env, "pending:");
      for (const k of list.keys) await kvDelete(env, k.name);
      await tg.msg(chatId, `🗑 ${list.keys.length}`);
      break;
    }

    default: {
      if (cmd.startsWith("/")) await tg.msg(chatId, "❓ /help");
    }
  }
}

// ──────────── CRON ────────────

async function processScheduled(env) {
  if (!env.BOT_KV || !env.TELEGRAM_BOT_TOKEN) {
    console.error("[CRON] Missing env");
    return;
  }

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);
  const pendingList = await kvList(env, "pending:");

  console.log(`[CRON] Pending: ${pendingList.keys.length}`);

  for (const key of pendingList.keys) {
    const id = key.name.replace("pending:", "");

    try {
      const data = await kvGet(env, key.name, "json");
      if (!data) { await kvDelete(env, key.name); continue; }

      // Таймаут
      if (Date.now() - data.submittedAt > 20 * 60 * 1000) {
        await kvDelete(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `⏰ Таймаут: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      console.log(`[CRON] ${id}: done=${check.done} proc=${check.processing} q=${check.queue_position}`);

      if (!check.done) continue;

      // Готово — забираем
      const result = await hordeResult(id);

      if (result.faulted) {
        await kvDelete(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `❌ Faulted: <code>${id}</code>`);
        continue;
      }

      const generations = result.generations || [];
      if (!generations.length) {
        await kvDelete(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `⚠️ Пусто: <code>${id}</code>`);
        continue;
      }

      let anySent = false;

      for (const gen of generations) {
        // ─── ПРОВЕРКА ЦЕНЗУРЫ ───
        if (gen.censored) {
          console.warn(`[CRON] CENSORED: ${id}`);
          if (data.notifyChat) {
            await tg.msg(
              data.notifyChat,
              `🚫 <b>Картинка зацензурена воркером!</b>\nID: <code>${id}</code>\nWorker: <code>${gen.worker_name || "?"}</code>\nModel: <code>${gen.model || "?"}</code>\n\n` +
              `Что делать:\n` +
              `1. /trusted on — только проверенные воркеры\n` +
              `2. Проверь HORDE_API_KEY\n` +
              `3. Попробуй другую модель`
            );
          }
          continue;
        }

        if (!gen.img) {
          console.warn(`[CRON] No img: ${id}`);
          if (data.notifyChat) await tg.msg(data.notifyChat, `⚠️ Пустая картинка: <code>${id}</code>`);
          continue;
        }

        const caption = data.prompt
          ? `🎨 <i>${data.prompt.substring(0, 150)}</i>`
          : "";

        const sent = await sendGeneratedImage(tg, data.chatId, gen.img, caption, data.notifyChat);
        if (sent) anySent = true;
      }

      // Удаляем из KV после обработки
      await kvDelete(env, key.name);

      if (anySent && data.notifyChat && data.notifyChat !== data.chatId) {
        await tg.msg(data.notifyChat, "✅ Отправлено!");
      }

    } catch (e) {
      console.error(`[CRON] ${id}:`, e.message);
    }
  }

  // ─── Автопостинг ───
  if (!config.enabled || !config.chatId || !config.generalPrompt) return;

  const currentPending = await kvList(env, "pending:");
  if (currentPending.keys.length > 0) return;

  const lastPost = parseInt((await kvGet(env, "last_post_time")) || "0");
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  console.log("[CRON] Auto-post!");
  await kvPut(env, "last_post_time", String(now));

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env.HORDE_API_KEY);
      if (result.id) {
        await kvPut(env, `pending:${result.id}`, JSON.stringify({
          chatId: config.chatId, prompt, submittedAt: now, notifyChat: null,
        }), { expirationTtl: 3600 });
        console.log(`[CRON] Queued: ${result.id}`);
      }
    } catch (e) {
      console.error("[CRON] Auto error:", e.message);
    }
  }
}

// ──────────── ENTRY ────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });

      let update;
      try { update = await request.json(); }
      catch { return new Response("Bad JSON", { status: 400 }); }

      console.log("[WH]", JSON.stringify(update).substring(0, 300));

      if (update.message?.text) {
        // Синхронно, но с catch
        try {
          await handleCommand(update.message, env);
        } catch (e) {
          console.error("[WH] CRASH:", e.message, e.stack);
          try {
            const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
            await tg.msg(update.message.chat.id, `💥 <code>${e.message}</code>`);
          } catch {}
        }
      }

      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TOKEN!", { status: 500 });
      const wh = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: wh, allowed_updates: ["message"], drop_pending_updates: true }),
      });
      const res = await r.json();
      return new Response(`Webhook: ${wh}\n${JSON.stringify(res, null, 2)}\n\nKV:${env.BOT_KV?"OK":"MISSING"} Horde:${env.HORDE_API_KEY?"OK":"MISSING!"} OR:${env.OPENROUTER_API_KEY?"OK":"no"}`, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ kv:!!env.BOT_KV, tg:!!env.TELEGRAM_BOT_TOKEN, horde:!!env.HORDE_API_KEY, or:!!env.OPENROUTER_API_KEY }, null, 2));
    }

    return new Response("Bot v4. /setup /health");
  },

  async scheduled(event, env, ctx) {
    try { await processScheduled(env); }
    catch (e) { console.error("[CRON] CRASH:", e.message, e.stack); }
  },
};