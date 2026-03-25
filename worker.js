// ============================================================
//  Telegram Image Bot — Cloudflare Workers v3 (fixed)
//  Fixes:
//  1. r2: false  →  получаем base64 вместо протухающих URL
//  2. Удаление из KV только ПОСЛЕ успешной отправки
//  3. Правильная обработка base64-картинок
//  4. Уведомление о чёрной/пустой картинке (цензура Horde)
//  5. NSFW-флаг корректно пробрасывается через API-ключ
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
  sampler: "k_dpmpp_2m",
  nsfw: true,
  negativePrompt:
    "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "",
  clipSkip: 1,
};

const HORDE = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:3.0:github" };

// ──────────── TELEGRAM ────────────

class Telegram {
  constructor(token) {
    this.api = `https://api.telegram.org/bot${token}`;
  }

  async call(method, body) {
    console.log(`[TG] ${method}`, JSON.stringify(body).substring(0, 200));
    const r = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await r.json();
    if (!result.ok) {
      console.error(`[TG] ${method} FAILED:`, JSON.stringify(result));
    } else {
      console.log(`[TG] ${method} OK`);
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
    console.log("[TG] sendPhotoBlob result:", JSON.stringify(result).substring(0, 200));
    return result;
  }
}

// ──────────── KV ────────────

async function kvGet(env, key, type = "text") {
  if (!env.BOT_KV) return null;
  try {
    return await env.BOT_KV.get(key, type);
  } catch (e) {
    console.error(`[KV] GET "${key}" error:`, e.message);
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
  const body = {
    prompt: config.negativePrompt
      ? `${prompt} ### ${config.negativePrompt}`
      : prompt,
    params: {
      sampler_name: config.sampler,
      cfg_scale: config.cfgScale,
      width: config.width,
      height: config.height,
      steps: config.steps,
      karras: true,
      clip_skip: config.clipSkip || 1,
      n: 1,
    },
    nsfw: config.nsfw,
    censor_nsfw: false,       // не цензурировать на стороне Horde
    models: [config.model],
    allow_downgrade: true,
    r2: false,                // FIX: false = получаем base64 вместо протухающих R2-URL
    shared: false,
    replacement_filter: false,
    slow_workers: true,       // расширяем пул воркеров
    trusted_workers: false,
  };

  if (config.loras?.length > 0) {
    body.params.loras = config.loras.map((l) => ({
      name: String(l.name),
      model: l.strength ?? 1,
      clip: l.clip ?? 1,
      inject_trigger: "any",
      is_version: true,
    }));
  }

  console.log("[HORDE] Submitting:", JSON.stringify(body).substring(0, 500));

  const resp = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // FIX: без реального API-ключа NSFW не работает, даже если nsfw:true
      apikey: apiKey || "0000000000",
      ...HORDE_HEADERS,
    },
    body: JSON.stringify(body),
  });
  const result = await resp.json();
  console.log("[HORDE] Submit result:", JSON.stringify(result));
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

// ──────────── ХЕЛПЕР: base64 или URL → Blob ────────────

async function imgToBlob(img) {
  if (!img) return null;

  // base64 (r2:false возвращает чистый base64 без префикса data:)
  if (!img.startsWith("http")) {
    try {
      const base64 = img.replace(/^data:image\/\w+;base64,/, "");
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: "image/webp" });
    } catch (e) {
      console.error("[IMG] base64 decode error:", e.message);
      return null;
    }
  }

  // URL (fallback, если вдруг r2:true)
  try {
    const resp = await fetch(img);
    if (!resp.ok) {
      console.error("[IMG] fetch URL failed:", resp.status);
      return null;
    }
    return await resp.blob();
  } catch (e) {
    console.error("[IMG] fetch URL error:", e.message);
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
            content: `You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations. No quotes. No markdown. Under 100 words. Direction: ${pick(directives)}`,
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
    console.log("[LLM] Response:", JSON.stringify(data).substring(0, 300));

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

// ──────────── ОБРАБОТКА КОМАНД ────────────

async function handleCommand(message, env) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = message.text || "";

  console.log(`[CMD] from=${userId} chat=${chatId} text="${text}"`);

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("[CMD] No TELEGRAM_BOT_TOKEN!");
    return;
  }

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);

  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  console.log(`[CMD] parsed cmd="${cmd}" args=${JSON.stringify(args)}`);

  if (cmd === "/ping") {
    await tg.msg(chatId, `🏓 Pong!\n\nChat ID: <code>${chatId}</code>\nUser ID: <code>${userId}</code>\nKV: ${env.BOT_KV ? "✅" : "❌"}\nHorde: ${env.HORDE_API_KEY ? "✅" : "⚠️ анонимный (NSFW не работает!)"}\nOpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}`);
    return;
  }

  if (cmd === "/diagnostic") {
    let txt = "🔧 <b>Диагностика</b>\n\n";
    txt += `BOT_KV: ${env.BOT_KV ? "✅" : "❌ НЕ ПРИВЯЗАН"}\n`;
    txt += `TELEGRAM_BOT_TOKEN: ${env.TELEGRAM_BOT_TOKEN ? "✅" : "❌"}\n`;
    txt += `HORDE_API_KEY: ${env.HORDE_API_KEY ? "✅" : "⚠️ анонимный — NSFW заблокирован!"}\n`;
    txt += `OPENROUTER_API_KEY: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️ шаблоны"}\n`;
    txt += `\nChat: <code>${chatId}</code>\nUser: <code>${userId}</code>\n`;
    txt += `Chat type: ${message.chat.type}\n`;

    if (!env.HORDE_API_KEY) {
      txt += `\n🔴 <b>Нет HORDE_API_KEY!</b>\nБез него NSFW всегда будет чёрным.\nРегистрируйся на stablehorde.net и добавь ключ в Secrets.`;
    }

    if (!env.BOT_KV) {
      txt += `\n🔴 <b>KV не привязан!</b>\nWorkers → Settings → Bindings → Add → KV Namespace\nVariable name: <code>BOT_KV</code>`;
    } else {
      try {
        await env.BOT_KV.put("_test", "ok");
        const val = await env.BOT_KV.get("_test");
        txt += `\nKV тест: ${val === "ok" ? "✅ работает" : "❌ " + val}`;
      } catch (e) {
        txt += `\nKV тест: ❌ ${e.message}`;
      }
    }

    await tg.msg(chatId, txt);
    return;
  }

  if (!env.BOT_KV) {
    await tg.msg(chatId, "❌ KV не привязан!\n/diagnostic для деталей");
    return;
  }

  let config = await getConfig(env);
  console.log("[CMD] config loaded, adminId=", config.adminId);

  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(env, config);
    console.log("[CMD] Set admin:", userId);
    await tg.msg(chatId, `👑 Вы назначены админом! ID: <code>${userId}</code>`);
  }

  if (config.adminId !== userId) {
    console.log(`[CMD] Access denied: ${userId} != ${config.adminId}`);
    await tg.msg(chatId, `🔒 Только для админа (${config.adminId})\nВы: ${userId}`);
    return;
  }

  switch (cmd) {
    case "/start":
    case "/help": {
      await tg.msg(
        chatId,
        `🤖 <b>Image Bot v3</b>

<b>Тест:</b> /ping /diagnostic

<b>Настройка:</b>
/setchat — этот чат для постинга
/setprompt &lt;текст&gt; — тема
/setinterval &lt;мин&gt; — интервал
/setcount &lt;1-10&gt; — кол-во

<b>Модель:</b>
/setmodel &lt;имя&gt;
/listmodels
/searchlora &lt;запрос&gt;
/addlora &lt;id&gt; [сила] [clip]
/removelora &lt;id&gt;
/listloras

<b>Параметры:</b>
/setsize &lt;W&gt; &lt;H&gt;
/setsteps &lt;1-50&gt;
/setcfg &lt;1-30&gt;
/setsampler &lt;имя&gt;
/setneg &lt;текст&gt;
/nsfw on|off
/setllm &lt;model&gt;
/setclipskip &lt;1-4&gt;

<b>Управление:</b>
/enable — вкл автопост
/disable — выкл
/generate — прямо сейчас
/status — все настройки
/pending — очередь
/cancel — очистить
/resetadmin — сброс админа`
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
        await tg.msg(chatId, "❌ /setprompt &lt;инструкция&gt;\n\nПример:\n<code>/setprompt anime girl in fantasy world</code>");
        break;
      }
      config.generalPrompt = prompt;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Промпт: <code>${prompt}</code>`);
      break;
    }

    case "/setinterval": {
      const m = parseInt(args[0]);
      if (isNaN(m) || m < 1) {
        await tg.msg(chatId, "❌ /setinterval &lt;минуты&gt;");
        break;
      }
      config.interval = m;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Интервал: ${m} мин`);
      break;
    }

    case "/setcount": {
      const n = parseInt(args[0]);
      if (isNaN(n) || n < 1 || n > 10) {
        await tg.msg(chatId, "❌ /setcount &lt;1-10&gt;");
        break;
      }
      config.count = n;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Кол-во: ${n}`);
      break;
    }

    case "/setmodel": {
      const name = args.join(" ");
      if (!name) {
        await tg.msg(chatId, "❌ /setmodel &lt;название&gt;\n/listmodels");
        break;
      }
      config.model = name;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Модель: <code>${name}</code>`);
      break;
    }

    case "/listmodels": {
      await tg.msg(chatId, "⏳ Загружаю...");
      try {
        const models = await hordeModels();
        const sorted = models
          .filter((m) => m.count > 0)
          .sort((a, b) => b.count - a.count)
          .slice(0, 30);

        let txt = "📋 <b>Модели:</b>\n\n";
        for (const m of sorted) {
          const xl = m.name.includes("XL") || m.name.includes("SDXL") ? "🟢" : "⚪";
          txt += `${xl} <code>${m.name}</code> (${m.count})\n`;
        }
        txt += "\n/setmodel &lt;название&gt;";
        await tg.msg(chatId, txt);
      } catch (e) {
        await tg.msg(chatId, `❌ ${e.message}`);
      }
      break;
    }

    case "/searchlora": {
      const query = args.join(" ");
      if (!query) {
        await tg.msg(chatId, "❌ /searchlora &lt;запрос&gt;");
        break;
      }
      await tg.msg(chatId, "🔍 Ищу...");
      try {
        const url = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(query)}&limit=8&sort=Highest%20Rated&nsfw=true`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (!data.items?.length) {
          await tg.msg(chatId, "😕 Не найдено");
          break;
        }

        let txt = `🔍 "${query}":\n\n`;
        for (const item of data.items) {
          const ver = item.modelVersions?.[0];
          const vid = ver?.id || "?";
          const base = ver?.baseModel || "?";
          txt += `${item.nsfw ? "🔞" : "✅"} <b>${item.name}</b> [${base}]\n`;
          txt += `➕ <code>/addlora ${vid} 0.8</code>\n\n`;
        }
        await tg.msg(chatId, txt);
      } catch (e) {
        await tg.msg(chatId, `❌ ${e.message}`);
      }
      break;
    }

    case "/addlora": {
      const id = args[0];
      const str = parseFloat(args[1]) || 0.8;
      const clip = parseFloat(args[2]) || 1;
      if (!id) {
        await tg.msg(chatId, "❌ /addlora &lt;version_id&gt; [str] [clip]");
        break;
      }
      config.loras = (config.loras || []).filter((l) => String(l.name) !== String(id));
      config.loras.push({ name: id, strength: str, clip });
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ LoRA ${id} (${str}/${clip})`);
      break;
    }

    case "/removelora": {
      const rid = args[0];
      if (!rid) { await tg.msg(chatId, "❌ /removelora &lt;id&gt;"); break; }
      config.loras = (config.loras || []).filter((l) => String(l.name) !== String(rid));
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Удалено: ${rid}`);
      break;
    }

    case "/listloras": {
      const ll = config.loras || [];
      if (!ll.length) { await tg.msg(chatId, "Нет LoRA. /searchlora"); break; }
      let txt = "📋 LoRA:\n\n";
      ll.forEach((l) => { txt += `• <code>${l.name}</code> (${l.strength}/${l.clip})\n  /removelora ${l.name}\n\n`; });
      await tg.msg(chatId, txt);
      break;
    }

    case "/setsize": {
      const w = parseInt(args[0]), h = parseInt(args[1]);
      if (isNaN(w) || isNaN(h) || w < 256 || h < 256 || w > 2048 || h > 2048) {
        await tg.msg(chatId, "❌ /setsize W H\n<code>/setsize 1024 1024</code>\n<code>/setsize 832 1216</code>");
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
      if (isNaN(s) || s < 1 || s > 50) { await tg.msg(chatId, "❌ /setsteps 1-50"); break; }
      config.steps = s;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Steps: ${s}`);
      break;
    }

    case "/setcfg": {
      const c = parseFloat(args[0]);
      if (isNaN(c) || c < 1 || c > 30) { await tg.msg(chatId, "❌ /setcfg 1-30"); break; }
      config.cfgScale = c;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ CFG: ${c}`);
      break;
    }

    case "/setsampler": {
      const list = ["k_euler","k_euler_a","k_lms","k_heun","k_dpm_2","k_dpm_2_a","k_dpmpp_2s_a","k_dpmpp_2m","k_dpmpp_sde","DDIM"];
      if (!args[0] || !list.includes(args[0])) {
        await tg.msg(chatId, `Сэмплеры:\n${list.map(s=>`<code>${s}</code>`).join("\n")}`);
        break;
      }
      config.sampler = args[0];
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ ${args[0]}`);
      break;
    }

    case "/setneg": {
      config.negativePrompt = args.join(" ") || DEFAULT_CONFIG.negativePrompt;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Neg: <code>${config.negativePrompt.substring(0,200)}</code>`);
      break;
    }

    case "/nsfw": {
      if (args[0] !== "on" && args[0] !== "off") { await tg.msg(chatId, "/nsfw on|off"); break; }
      config.nsfw = args[0] === "on";
      await saveConfig(env, config);
      let warn = "";
      if (config.nsfw && !env.HORDE_API_KEY) {
        warn = "\n\n⚠️ Нет HORDE_API_KEY — NSFW будет чёрным! Добавь ключ со stablehorde.net";
      }
      await tg.msg(chatId, `✅ NSFW: ${config.nsfw ? "🔞 ON" : "OFF"}${warn}`);
      break;
    }

    case "/setllm": {
      const llm = args.join(" ");
      if (!llm) {
        await tg.msg(chatId, `Текущая: <code>${config.llmModel||env.LLM_MODEL||"auto"}</code>\n\n<code>meta-llama/llama-3.1-8b-instruct:free</code>\n<code>google/gemma-2-9b-it:free</code>\n<code>mistralai/mistral-7b-instruct:free</code>`);
        break;
      }
      config.llmModel = llm;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ LLM: <code>${llm}</code>`);
      break;
    }

    case "/setclipskip": {
      const cs = parseInt(args[0]);
      if (isNaN(cs) || cs < 1 || cs > 4) { await tg.msg(chatId, "❌ 1-4"); break; }
      config.clipSkip = cs;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ CLIP Skip: ${cs}`);
      break;
    }

    case "/enable": {
      if (!config.chatId) { await tg.msg(chatId, "❌ Сначала /setchat"); break; }
      if (!config.generalPrompt) { await tg.msg(chatId, "❌ Сначала /setprompt"); break; }
      config.enabled = true;
      await saveConfig(env, config);
      let warn = !env.HORDE_API_KEY ? "\n⚠️ Нет HORDE_API_KEY — NSFW будет чёрным!" : "";
      await tg.msg(chatId, `🟢 ВКЛ! Каждые ${config.interval}м по ${config.count}шт${warn}`);
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
`📊 ${config.enabled?"🟢 ВКЛ":"🔴 ВЫКЛ"}
Чат: <code>${config.chatId||"—"}</code>
Интервал: ${config.interval}м × ${config.count}шт

Промпт: <code>${config.generalPrompt||"—"}</code>

Модель: <code>${config.model}</code>
${config.width}×${config.height} | Steps:${config.steps} | CFG:${config.cfgScale}
Sampler: ${config.sampler} | CLIP:${config.clipSkip||1}
NSFW: ${config.nsfw?"🔞":"нет"}
Horde API: ${env.HORDE_API_KEY?"✅":"⚠️ анонимный"}

LoRA:
${loras}

LLM: <code>${config.llmModel||env.LLM_MODEL||"auto"}</code>
Очередь: ${pend.keys.length}`);
      break;
    }

    case "/generate": {
      if (!config.generalPrompt) { await tg.msg(chatId, "❌ /setprompt сначала"); break; }
      const target = config.chatId || chatId;
      await tg.msg(chatId, `⏳ Генерирую ${config.count}...`);

      for (let i = 0; i < config.count; i++) {
        try {
          const prompt = await generatePrompt(config.generalPrompt, env);
          console.log(`[GEN] #${i+1} prompt:`, prompt.substring(0, 200));
          await tg.msg(chatId, `🎨 #${i+1}: <code>${prompt.substring(0,250)}</code>`);

          const result = await hordeSubmit(prompt, config, env.HORDE_API_KEY);

          if (result.id) {
            await kvPut(env, `pending:${result.id}`, JSON.stringify({
              chatId: target, prompt, submittedAt: Date.now(), notifyChat: chatId,
            }), { expirationTtl: 3600 });
            await tg.msg(chatId, `📤 ID: <code>${result.id}</code>`);
          } else {
            await tg.msg(chatId, `❌ ${JSON.stringify(result).substring(0,300)}`);
          }
        } catch (e) {
          console.error("[GEN] Error:", e.message);
          await tg.msg(chatId, `❌ ${e.message}`);
        }
      }
      break;
    }

    case "/pending": {
      const list = await kvList(env, "pending:");
      if (!list.keys.length) { await tg.msg(chatId, "📋 Пусто"); break; }
      let txt = `📋 ${list.keys.length} шт:\n\n`;
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
      await tg.msg(chatId, `🗑 Удалено: ${list.keys.length}`);
      break;
    }

    default: {
      if (cmd.startsWith("/")) {
        await tg.msg(chatId, "❓ /help");
      }
    }
  }
}

// ──────────── CRON ────────────

async function processScheduled(env) {
  if (!env.BOT_KV || !env.TELEGRAM_BOT_TOKEN) {
    console.error("[CRON] Missing BOT_KV or TELEGRAM_BOT_TOKEN");
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

      // Таймаут 20 минут
      if (Date.now() - data.submittedAt > 20 * 60 * 1000) {
        await kvDelete(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `⏰ Таймаут: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      console.log(`[CRON] ${id}: done=${check.done} proc=${check.processing} q=${check.queue_position}`);
      if (!check.done) continue;

      const result = await hordeResult(id);

      // FIX: НЕ удаляем из KV до отправки

      if (result.faulted) {
        await kvDelete(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `❌ Faulted: <code>${id}</code>`);
        continue;
      }

      const generations = result.generations || [];
      if (!generations.length) {
        await kvDelete(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `⚠️ Пустой результат: <code>${id}</code>`);
        continue;
      }

      let anySent = false;

      for (const gen of generations) {
        // FIX: предупреждаем если img пустой (цензура Horde)
        if (!gen.img) {
          console.warn(`[CRON] gen.img пустой для ${id} — вероятно цензура Horde`);
          if (data.notifyChat) {
            await tg.msg(data.notifyChat,
              `⚠️ Картинка заблокирована цензурой Horde (чёрный img).\n` +
              `Убедись что:\n` +
              `1. Добавлен реальный HORDE_API_KEY\n` +
              `2. В аккаунте на stablehorde.net включён NSFW\n` +
              `ID: <code>${id}</code>`
            );
          }
          continue;
        }

        const caption = data.prompt ? `🎨 <i>${data.prompt.substring(0, 150)}</i>` : "";

        try {
          // FIX: конвертируем base64 или URL в Blob
          const blob = await imgToBlob(gen.img);

          if (blob) {
            const sent = await tg.sendPhotoBlob(data.chatId, blob, caption);
            if (sent.ok) {
              anySent = true;
              console.log(`[CRON] Успешно отправлено: ${id}`);
            } else {
              console.warn(`[CRON] sendPhotoBlob failed для ${id}:`, JSON.stringify(sent));
              if (data.notifyChat) {
                await tg.msg(data.notifyChat, `❌ Ошибка отправки: ${sent.description || "unknown"}`);
              }
            }
          } else {
            console.warn(`[CRON] Не удалось получить blob для ${id}`);
            if (data.notifyChat) {
              await tg.msg(data.notifyChat, `❌ Не удалось загрузить изображение: <code>${id}</code>`);
            }
          }
        } catch (e) {
          console.error("[CRON] Send error:", e.message);
          if (data.notifyChat) await tg.msg(data.notifyChat, `❌ Отправка: ${e.message}`);
        }
      }

      // FIX: удаляем из KV только после обработки всех генераций
      await kvDelete(env, key.name);

      if (anySent && data.notifyChat && data.notifyChat !== data.chatId) {
        await tg.msg(data.notifyChat, `✅ Отправлено!`);
      }

    } catch (e) {
      console.error(`[CRON] ${id} error:`, e.message);
    }
  }

  // Автопостинг
  if (!config.enabled || !config.chatId || !config.generalPrompt) return;

  const currentPending = await kvList(env, "pending:");
  if (currentPending.keys.length > 0) return;

  const lastPost = parseInt((await kvGet(env, "last_post_time")) || "0");
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  console.log("[CRON] Auto-posting...");
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
      } else {
        console.error("[CRON] Submit failed:", JSON.stringify(result));
      }
    } catch (e) {
      console.error("[CRON] Auto-post error:", e.message);
    }
  }
}

// ──────────── ENTRY POINT ────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    console.log(`[FETCH] ${request.method} ${url.pathname}`);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") {
        return new Response("Send POST", { status: 405 });
      }

      let update;
      try {
        update = await request.json();
      } catch (e) {
        console.error("[WEBHOOK] Bad JSON:", e.message);
        return new Response("Bad JSON", { status: 400 });
      }

      console.log("[WEBHOOK] Update:", JSON.stringify(update).substring(0, 500));

      if (update.message?.text) {
        ctx.waitUntil(
          (async () => {
            try {
              await handleCommand(update.message, env);
            } catch (e) {
              console.error("[WEBHOOK] handleCommand CRASHED:", e.message);
            }
          })()
        );
      }

      return new Response("OK", { status: 200 });
    }

    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response("ERROR: Set TELEGRAM_BOT_TOKEN in Worker secrets!", { status: 500 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const resp = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message"], drop_pending_updates: true }),
        }
      );
      const result = await resp.json();
      return new Response(
        `Webhook: ${webhookUrl}\n\nResult: ${JSON.stringify(result, null, 2)}\n\nKV: ${env.BOT_KV ? "OK" : "NOT BOUND!"}\nHorde: ${env.HORDE_API_KEY ? "OK" : "NOT SET — NSFW won't work!"}\nOpenRouter: ${env.OPENROUTER_API_KEY ? "OK" : "not set"}`,
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        kv: !!env.BOT_KV,
        telegram: !!env.TELEGRAM_BOT_TOKEN,
        horde: !!env.HORDE_API_KEY,
        openrouter: !!env.OPENROUTER_API_KEY,
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/") {
      return new Response("Bot OK. /setup /health", { headers: { "Content-Type": "text/plain" } });
    }

    return new Response("404", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    try {
      await processScheduled(env);
    } catch (e) {
      console.error("[CRON] CRASHED:", e.message, e.stack);
    }
  },
};
