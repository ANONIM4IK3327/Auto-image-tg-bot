// ============================================================
//  Telegram Image Bot — Cloudflare Workers (v2 — fixed)
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
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:2.0:github" };

// ──────────── ПРОВЕРКА ОКРУЖЕНИЯ ────────────

function checkEnv(env) {
  const issues = [];
  if (!env.BOT_KV) issues.push("BOT_KV (KV Namespace) не привязан");
  if (!env.TELEGRAM_BOT_TOKEN) issues.push("TELEGRAM_BOT_TOKEN не задан");
  if (!env.HORDE_API_KEY) issues.push("HORDE_API_KEY не задан (будет анонимный)");
  if (!env.OPENROUTER_API_KEY)
    issues.push("OPENROUTER_API_KEY не задан (промпты по шаблонам)");
  return issues;
}

// ──────────── KV ОБЁРТКА (БЕЗОПАСНАЯ) ────────────

async function kvGet(env, key, type = "text") {
  if (!env.BOT_KV) return null;
  try {
    return await env.BOT_KV.get(key, type);
  } catch (e) {
    console.error(`KV GET error [${key}]:`, e.message);
    return null;
  }
}

async function kvPut(env, key, value, options = {}) {
  if (!env.BOT_KV) throw new Error("KV не привязан! Смотри /diagnostic");
  try {
    await env.BOT_KV.put(key, value, options);
  } catch (e) {
    console.error(`KV PUT error [${key}]:`, e.message);
    throw e;
  }
}

async function kvDelete(env, key) {
  if (!env.BOT_KV) return;
  try {
    await env.BOT_KV.delete(key);
  } catch (e) {
    console.error(`KV DELETE error [${key}]:`, e.message);
  }
}

async function kvList(env, prefix) {
  if (!env.BOT_KV) return { keys: [] };
  try {
    return await env.BOT_KV.list({ prefix });
  } catch (e) {
    console.error(`KV LIST error [${prefix}]:`, e.message);
    return { keys: [] };
  }
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
      clip_skip: config.clipSkip || 1,
      n: 1,
    },
    nsfw: config.nsfw,
    censor_nsfw: false,
    models: [config.model],
    r2: true,
    shared: false,
    replacement_filter: true,
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

  const resp = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey || "0000000000",
      ...HORDE_HEADERS,
    },
    body: JSON.stringify(body),
  });
  return resp.json();
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
    const result = await r.json();
    if (!result.ok) {
      console.error(`Telegram ${method} error:`, JSON.stringify(result));
    }
    return result;
  }

  msg(chatId, text, extra = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...extra,
    });
  }

  async sendPhotoUrl(chatId, url, caption = "") {
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
    return r.json();
  }
}

// ──────────── ГЕНЕРАЦИЯ ПРОМПТОВ ────────────

const V_ANGLES = [
  "from above at 45 degrees", "extreme low angle looking up",
  "eye level straight on", "dutch angle tilted frame",
  "bird's eye view", "over the shoulder perspective",
  "extreme close-up macro", "wide establishing shot",
  "medium portrait framing", "three-quarter view",
  "profile side view", "shot from behind",
];

const V_LIGHT = [
  "golden hour warm sunlight", "cool blue hour twilight",
  "dramatic chiaroscuro lighting", "soft diffused overcast light",
  "neon cyberpunk glow", "moonlit night scene",
  "studio rim lighting", "dappled forest light",
  "harsh midday shadows", "candlelit warm ambiance",
  "volumetric god rays", "backlit silhouette",
];

const V_STYLE = [
  "photorealistic photography", "digital concept art",
  "oil painting impasto style", "watercolor soft washes",
  "anime cel shading", "dark fantasy illustration",
  "hyperrealistic 8k render", "noir high contrast",
  "surrealist dreamlike", "comic book pop art",
  "renaissance classical painting", "vaporwave aesthetic",
];

const V_MOOD = [
  "serene and peaceful", "intense and dramatic",
  "mysterious and enigmatic", "vibrant and energetic",
  "ethereal and dreamlike", "dark and brooding",
  "warm and intimate", "epic and grandiose",
  "melancholic and wistful", "playful and whimsical",
];

const V_DETAIL = [
  "intricate filigree details", "rough textured surfaces",
  "smooth polished finish", "ornate baroque decoration",
  "minimalist clean lines", "weathered and aged patina",
  "crystalline sharp focus", "bokeh background blur",
  "particle effects and dust motes", "reflections and refractions",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  const s = [...arr].sort(() => Math.random() - 0.5);
  return s.slice(0, n);
}

function templatePrompt(base) {
  return [
    base, pick(V_ANGLES), pick(V_LIGHT), pick(V_STYLE),
    pick(V_MOOD), ...pickN(V_DETAIL, 2),
    "masterpiece", "best quality", "highly detailed",
  ].join(", ");
}

async function generatePromptLLM(instruction, apiKey, model) {
  const directives = [
    "Focus on an unusual creative perspective",
    "Emphasize dramatic lighting and deep shadows",
    "Place the subject in an unexpected environment",
    "Focus on intricate textures and micro-details",
    "Use a bold unconventional color palette",
    "Capture dynamic motion and energy",
    "Create a contemplative atmospheric scene",
    "Use extreme framing — very close or very wide",
    "Create cinematic movie-poster composition",
    "Add weather effects — rain, snow, fog, or storm",
  ];

  const systemPrompt = `You are an expert AI image prompt engineer for Stable Diffusion.
Take a general theme and create ONE unique, highly detailed prompt.

RULES:
- Output ONLY the prompt text. No explanations, no quotes, no markdown.
- Stable Diffusion format: comma-separated descriptive phrases
- Be specific about: subject, pose, expression, setting, colors, lighting, camera angle, art style
- Include: masterpiece, best quality, highly detailed
- Under 120 words. Be creative.
- Direction: ${pick(directives)}`;

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
          { role: "system", content: systemPrompt },
          { role: "user", content: `Theme: ${instruction}\n\nGenerate a unique Stable Diffusion prompt.` },
        ],
        temperature: 1.3,
        top_p: 0.95,
        max_tokens: 250,
      }),
    });

    const data = await resp.json();
    if (data.choices?.[0]?.message?.content) {
      let prompt = data.choices[0].message.content.trim();
      prompt = prompt.replace(/^["'`]+|["'`]+$/g, "").replace(/^\*+|\*+$/g, "").trim();
      if (prompt.length > 10) return prompt;
    }
    console.log("LLM response unexpected:", JSON.stringify(data).substring(0, 300));
  } catch (e) {
    console.error("LLM error:", e.message);
  }

  return templatePrompt(instruction);
}

async function generatePrompt(instruction, env) {
  if (env.OPENROUTER_API_KEY) {
    const config = await getConfig(env);
    const model = config.llmModel || env.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
    return generatePromptLLM(instruction, env.OPENROUTER_API_KEY, model);
  }
  return templatePrompt(instruction);
}

// ──────────── ОБРАБОТКА КОМАНД ────────────

async function handleCommand(message, env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  try {
    // Диагностика — работает даже без KV
    if (cmd === "/diagnostic") {
      const issues = checkEnv(env);
      let txt = "🔧 <b>Диагностика</b>\n\n";
      txt += `BOT_KV: ${env.BOT_KV ? "✅ привязан" : "❌ НЕ ПРИВЯЗАН"}\n`;
      txt += `TELEGRAM_BOT_TOKEN: ${env.TELEGRAM_BOT_TOKEN ? "✅ есть" : "❌ нет"}\n`;
      txt += `HORDE_API_KEY: ${env.HORDE_API_KEY ? "✅ есть" : "⚠️ нет (анонимно)"}\n`;
      txt += `OPENROUTER_API_KEY: ${env.OPENROUTER_API_KEY ? "✅ есть" : "⚠️ нет (шаблоны)"}\n`;
      txt += `LLM_MODEL: ${env.LLM_MODEL || "не задан"}\n`;
      txt += `\nChat ID: <code>${chatId}</code>\n`;
      txt += `User ID: <code>${userId}</code>\n`;

      if (issues.length > 0) {
        txt += "\n⚠️ <b>Проблемы:</b>\n";
        issues.forEach((i) => (txt += `• ${i}\n`));
      }

      if (!env.BOT_KV) {
        txt += `\n🔴 <b>KV не привязан!</b>\n`;
        txt += `Иди в Cloudflare Dashboard:\n`;
        txt += `Workers → autoimgtg → Settings → Bindings\n`;
        txt += `Add → KV Namespace\n`;
        txt += `Variable name: <code>BOT_KV</code>\n`;
        txt += `Выбери свой namespace → Save`;
      }

      await tg.msg(chatId, txt);
      return;
    }

    // Проверка KV для всех остальных команд
    if (!env.BOT_KV) {
      await tg.msg(
        chatId,
        "❌ <b>KV Storage не привязан!</b>\n\nОтправь /diagnostic чтобы увидеть инструкцию."
      );
      return;
    }

    let config = await getConfig(env);

    // Первый пользователь — админ
    if (!config.adminId) {
      config.adminId = userId;
      await saveConfig(env, config);
    }

    if (config.adminId !== userId) {
      await tg.msg(chatId, `🔒 Доступ только для админа (ID: ${config.adminId})`);
      return;
    }

    switch (cmd) {
      case "/start":
      case "/help": {
        await tg.msg(
          chatId,
          `🤖 <b>Image Generator Bot v2</b>

<b>📌 Основные:</b>
/setchat — текущий чат для постинга
/setprompt &lt;текст&gt; — общая инструкция
/setinterval &lt;минуты&gt; — интервал (мин. 1)
/setcount &lt;1-10&gt; — кол-во за раз
/enable — включить автопостинг
/disable — выключить
/generate — сгенерировать сейчас

<b>🎨 Модель и LoRA:</b>
/setmodel &lt;название&gt; — выбрать модель
/listmodels — доступные модели
/searchlora &lt;запрос&gt; — поиск LoRA
/addlora &lt;version_id&gt; [сила] [clip]
/removelora &lt;id&gt; — удалить
/listloras — показать

<b>⚙️ Параметры:</b>
/setsize &lt;W&gt; &lt;H&gt; — размер
/setsteps &lt;1-50&gt; — шаги
/setcfg &lt;1-30&gt; — CFG Scale
/setsampler &lt;имя&gt; — сэмплер
/setneg &lt;текст&gt; — негативный промпт
/nsfw on|off — NSFW
/setllm &lt;model&gt; — LLM модель
/setclipskip &lt;1-4&gt;

<b>📊 Инфо:</b>
/status — настройки
/pending — очередь
/cancel — очистить очередь
/diagnostic — проверка системы
/resetadmin — сбросить админа`
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
        await tg.msg(chatId, `✅ Чат для постинга: <code>${chatId}</code>`);
        break;
      }

      case "/setprompt": {
        const prompt = args.join(" ");
        if (!prompt) {
          await tg.msg(chatId, "❌ Использование: /setprompt &lt;ваша инструкция&gt;\n\nПример:\n<code>/setprompt beautiful anime girl in fantasy world</code>");
          break;
        }
        config.generalPrompt = prompt;
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ Промпт:\n<code>${prompt}</code>`);
        break;
      }

      case "/setinterval": {
        const mins = parseInt(args[0]);
        if (isNaN(mins) || mins < 1) {
          await tg.msg(chatId, "❌ /setinterval &lt;минуты&gt; (мин. 1)");
          break;
        }
        config.interval = mins;
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ Интервал: ${mins} мин.`);
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
          await tg.msg(chatId, "❌ /setmodel &lt;название&gt;\nИспользуй /listmodels");
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
            .slice(0, 40);

          let txt = "📋 <b>Топ-40 моделей:</b>\n\n";
          for (const m of sorted) {
            const tag = m.name.includes("XL") || m.name.includes("SDXL") ? "🟢" : "⚪";
            txt += `${tag} <code>${m.name}</code> (${m.count}w)\n`;
          }
          txt += "\n🟢=SDXL ⚪=SD1.5\n/setmodel &lt;название&gt;";
          await tg.msg(chatId, txt);
        } catch (e) {
          await tg.msg(chatId, `❌ ${e.message}`);
        }
        break;
      }

      case "/searchlora": {
        const query = args.join(" ");
        if (!query) {
          await tg.msg(chatId, "❌ /searchlora &lt;запрос на английском&gt;");
          break;
        }
        await tg.msg(chatId, "🔍 Ищу...");
        try {
          const url = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(query)}&limit=10&sort=Highest%20Rated&nsfw=true`;
          const resp = await fetch(url);
          const data = await resp.json();

          if (!data.items?.length) {
            await tg.msg(chatId, "😕 Ничего не найдено");
            break;
          }

          let txt = `🔍 <b>"${query}"</b>\n\n`;
          for (const item of data.items.slice(0, 8)) {
            const ver = item.modelVersions?.[0];
            const vid = ver?.id || "?";
            const nsfw = item.nsfw ? "🔞" : "✅";
            const baseModel = ver?.baseModel || "?";

            txt += `${nsfw} <b>${item.name}</b> [${baseModel}]\n`;
            txt += `   ➕ <code>/addlora ${vid} 0.8</code>\n\n`;
          }
          await tg.msg(chatId, txt);
        } catch (e) {
          await tg.msg(chatId, `❌ ${e.message}`);
        }
        break;
      }

      case "/addlora": {
        const loraId = args[0];
        const strength = parseFloat(args[1]) || 0.8;
        const clip = parseFloat(args[2]) || 1;
        if (!loraId) {
          await tg.msg(chatId, "❌ /addlora &lt;version_id&gt; [strength] [clip]\nНайди через /searchlora");
          break;
        }
        config.loras = config.loras || [];
        config.loras = config.loras.filter((l) => String(l.name) !== String(loraId));
        config.loras.push({ name: loraId, strength, clip });
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ LoRA <code>${loraId}</code> (str:${strength}, clip:${clip})`);
        break;
      }

      case "/removelora": {
        const rid = args[0];
        if (!rid) {
          await tg.msg(chatId, "❌ /removelora &lt;id&gt;");
          break;
        }
        config.loras = (config.loras || []).filter((l) => String(l.name) !== String(rid));
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ Удалено: <code>${rid}</code>`);
        break;
      }

      case "/listloras": {
        const loras = config.loras || [];
        if (!loras.length) {
          await tg.msg(chatId, "📋 Нет LoRA\n/searchlora для поиска");
          break;
        }
        let txt = "📋 <b>LoRA:</b>\n\n";
        loras.forEach((l) => {
          txt += `• <code>${l.name}</code> (str:${l.strength}, clip:${l.clip})\n  ❌ /removelora ${l.name}\n\n`;
        });
        await tg.msg(chatId, txt);
        break;
      }

      case "/setsize": {
        let w = parseInt(args[0]);
        let h = parseInt(args[1]);
        if (isNaN(w) || isNaN(h) || w < 256 || h < 256 || w > 2048 || h > 2048) {
          await tg.msg(chatId, "❌ /setsize &lt;W&gt; &lt;H&gt; (256-2048)\n\n<code>/setsize 1024 1024</code> — квадрат\n<code>/setsize 832 1216</code> — портрет\n<code>/setsize 1216 832</code> — ландшафт");
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
        if (isNaN(s) || s < 1 || s > 50) {
          await tg.msg(chatId, "❌ /setsteps &lt;1-50&gt;");
          break;
        }
        config.steps = s;
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ Шаги: ${s}`);
        break;
      }

      case "/setcfg": {
        const c = parseFloat(args[0]);
        if (isNaN(c) || c < 1 || c > 30) {
          await tg.msg(chatId, "❌ /setcfg &lt;1-30&gt;");
          break;
        }
        config.cfgScale = c;
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ CFG: ${c}`);
        break;
      }

      case "/setsampler": {
        const samplers = [
          "k_euler", "k_euler_a", "k_lms", "k_heun",
          "k_dpm_2", "k_dpm_2_a", "k_dpmpp_2s_a",
          "k_dpmpp_2m", "k_dpmpp_sde", "DDIM",
        ];
        const sam = args[0];
        if (!sam || !samplers.includes(sam)) {
          await tg.msg(chatId, `❌ Выбери:\n${samplers.map((s) => `<code>${s}</code>`).join("\n")}`);
          break;
        }
        config.sampler = sam;
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ Сэмплер: ${sam}`);
        break;
      }

      case "/setneg": {
        config.negativePrompt = args.join(" ") || DEFAULT_CONFIG.negativePrompt;
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ Негатив:\n<code>${config.negativePrompt}</code>`);
        break;
      }

      case "/nsfw": {
        const v = args[0]?.toLowerCase();
        if (v !== "on" && v !== "off") {
          await tg.msg(chatId, "❌ /nsfw on или /nsfw off");
          break;
        }
        config.nsfw = v === "on";
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ NSFW: ${config.nsfw ? "🔞 ВКЛ" : "ВЫКЛ"}`);
        break;
      }

      case "/setllm": {
        const llm = args.join(" ");
        if (!llm) {
          await tg.msg(
            chatId,
            `Текущая: <code>${config.llmModel || env.LLM_MODEL || "auto"}</code>

<b>Бесплатные:</b>
<code>meta-llama/llama-3.1-8b-instruct:free</code>
<code>google/gemma-2-9b-it:free</code>
<code>mistralai/mistral-7b-instruct:free</code>
<code>qwen/qwen-2-7b-instruct:free</code>`
          );
          break;
        }
        config.llmModel = llm;
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ LLM: <code>${llm}</code>`);
        break;
      }

      case "/setclipskip": {
        const cs = parseInt(args[0]);
        if (isNaN(cs) || cs < 1 || cs > 4) {
          await tg.msg(chatId, "❌ /setclipskip &lt;1-4&gt;");
          break;
        }
        config.clipSkip = cs;
        await saveConfig(env, config);
        await tg.msg(chatId, `✅ CLIP Skip: ${cs}`);
        break;
      }

      case "/enable": {
        if (!config.chatId) {
          await tg.msg(chatId, "❌ Сначала /setchat в нужном чате");
          break;
        }
        if (!config.generalPrompt) {
          await tg.msg(chatId, "❌ Сначала /setprompt &lt;инструкция&gt;");
          break;
        }
        config.enabled = true;
        await saveConfig(env, config);
        await tg.msg(chatId, `🟢 Автопостинг ВКЛ!\nИнтервал: ${config.interval} мин.\nКол-во: ${config.count}`);
        break;
      }

      case "/disable": {
        config.enabled = false;
        await saveConfig(env, config);
        await tg.msg(chatId, "🔴 Автопостинг ВЫКЛ");
        break;
      }

      case "/status": {
        const lorasTxt =
          (config.loras || []).map((l) => `  • ${l.name} (${l.strength})`).join("\n") || "  нет";
        const pending = await kvList(env, "pending:");

        await tg.msg(
          chatId,
          `📊 <b>Статус</b>

${config.enabled ? "🟢 ВКЛ" : "🔴 ВЫКЛ"}
<b>Чат:</b> <code>${config.chatId || "—"}</code>
<b>Интервал:</b> ${config.interval}м | <b>Кол-во:</b> ${config.count}

<b>Промпт:</b> <code>${config.generalPrompt || "—"}</code>

<b>Модель:</b> <code>${config.model}</code>
<b>Размер:</b> ${config.width}×${config.height}
<b>Шаги:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}
<b>Сэмплер:</b> ${config.sampler} | <b>CLIP:</b> ${config.clipSkip || 1}
<b>NSFW:</b> ${config.nsfw ? "🔞" : "нет"}

<b>Негатив:</b> <code>${config.negativePrompt.substring(0, 100)}</code>

<b>LoRA:</b>
${lorasTxt}

<b>LLM:</b> <code>${config.llmModel || env.LLM_MODEL || "auto"}</code>
<b>Очередь:</b> ${pending.keys.length}`
        );
        break;
      }

      case "/generate": {
        if (!config.generalPrompt) {
          await tg.msg(chatId, "❌ Сначала /setprompt");
          break;
        }
        const targetChat = config.chatId || chatId;
        await tg.msg(chatId, `⏳ Генерирую ${config.count} шт...`);

        for (let i = 0; i < config.count; i++) {
          try {
            const prompt = await generatePrompt(config.generalPrompt, env);
            await tg.msg(chatId, `🎨 #${i + 1}: <code>${prompt.substring(0, 300)}</code>`);

            const result = await hordeSubmit(prompt, config, env.HORDE_API_KEY);

            if (result.id) {
              await kvPut(
                env,
                `pending:${result.id}`,
                JSON.stringify({
                  chatId: targetChat,
                  prompt,
                  submittedAt: Date.now(),
                  notifyChat: chatId,
                }),
                { expirationTtl: 3600 }
              );
              await tg.msg(chatId, `📤 В очереди: <code>${result.id}</code>`);
            } else {
              await tg.msg(chatId, `❌ Horde: <code>${JSON.stringify(result).substring(0, 200)}</code>`);
            }
          } catch (e) {
            await tg.msg(chatId, `❌ ${e.message}`);
          }
        }
        break;
      }

      case "/pending": {
        const list = await kvList(env, "pending:");
        if (!list.keys.length) {
          await tg.msg(chatId, "📋 Очередь пуста");
          break;
        }
        let txt = `📋 <b>Очередь: ${list.keys.length}</b>\n\n`;
        for (const key of list.keys.slice(0, 10)) {
          const id = key.name.replace("pending:", "");
          try {
            const check = await hordeCheck(id);
            const st = check.done ? "✅ Готово" : check.processing ? "⚙️ Генерация" : `⏳ #${check.queue_position}`;
            txt += `🔸 <code>${id}</code> ${st} (~${check.wait_time}с)\n`;
          } catch {
            txt += `🔸 <code>${id}</code> ?\n`;
          }
        }
        await tg.msg(chatId, txt);
        break;
      }

      case "/cancel": {
        const list = await kvList(env, "pending:");
        for (const key of list.keys) {
          await kvDelete(env, key.name);
        }
        await tg.msg(chatId, `🗑 Очищено: ${list.keys.length}`);
        break;
      }

      default: {
        if (cmd.startsWith("/")) {
          await tg.msg(chatId, "❓ /help");
        }
      }
    }
  } catch (error) {
    console.error("Command handler error:", error);
    try {
      const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
      await tg.msg(chatId, `❌ Ошибка: <code>${error.message}</code>\n\nПопробуй /diagnostic`);
    } catch (e2) {
      console.error("Failed to send error message:", e2);
    }
  }
}

// ──────────── CRON ────────────

async function processScheduled(env) {
  // Проверяем что KV привязан
  if (!env.BOT_KV) {
    console.error("BOT_KV not bound! Go to Worker Settings → Bindings → Add KV Namespace");
    return;
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN not set!");
    return;
  }

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);

  // 1. Проверяем pending
  const pendingList = await kvList(env, "pending:");

  for (const key of pendingList.keys) {
    const id = key.name.replace("pending:", "");
    let data;

    try {
      data = await kvGet(env, key.name, "json");
      if (!data) {
        await kvDelete(env, key.name);
        continue;
      }

      // Таймаут 20 мин
      if (Date.now() - data.submittedAt > 20 * 60 * 1000) {
        await kvDelete(env, key.name);
        if (data.notifyChat) {
          await tg.msg(data.notifyChat, `⏰ Таймаут: <code>${id}</code>`);
        }
        continue;
      }

      const check = await hordeCheck(id);
      if (!check.done) continue;

      const result = await hordeResult(id);
      await kvDelete(env, key.name);

      if (result.faulted) {
        if (data.notifyChat) {
          await tg.msg(data.notifyChat, `❌ Ошибка генерации <code>${id}</code>`);
        }
        continue;
      }

      if (result.generations?.length > 0) {
        for (const gen of result.generations) {
          if (!gen.img) continue;

          const caption = data.prompt
            ? `🎨 <i>${data.prompt.substring(0, 200)}</i>`
            : "";

          // Скачиваем и отправляем (R2 ссылки короткоживущие)
          try {
            const imgResp = await fetch(gen.img);
            if (imgResp.ok) {
              const blob = await imgResp.blob();
              const sendResult = await tg.sendPhotoBlob(data.chatId, blob, caption);
              if (!sendResult.ok) {
                console.error("sendPhoto failed:", JSON.stringify(sendResult));
                // Пробуем URL напрямую
                await tg.sendPhotoUrl(data.chatId, gen.img, caption);
              }
            } else {
              // Фолбэк на URL
              await tg.sendPhotoUrl(data.chatId, gen.img, caption);
            }
          } catch (e) {
            console.error("Send image error:", e.message);
            if (data.notifyChat) {
              await tg.msg(data.notifyChat, `❌ Не удалось отправить: ${e.message}`);
            }
          }
        }

        if (data.notifyChat && data.notifyChat !== data.chatId) {
          await tg.msg(data.notifyChat, `✅ Изображение отправлено!`);
        }
      }
    } catch (e) {
      console.error(`Pending ${id} error:`, e.message);
    }
  }

  // 2. Автопостинг
  if (!config.enabled || !config.chatId || !config.generalPrompt) return;

  // Не спамим если есть pending
  const currentPending = await kvList(env, "pending:");
  if (currentPending.keys.length > 0) return;

  const lastPost = parseInt((await kvGet(env, "last_post_time")) || "0");
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  // Постим!
  await kvPut(env, "last_post_time", String(now));

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env.HORDE_API_KEY);

      if (result.id) {
        await kvPut(
          env,
          `pending:${result.id}`,
          JSON.stringify({
            chatId: config.chatId,
            prompt,
            submittedAt: now,
            notifyChat: null,
          }),
          { expirationTtl: 3600 }
        );
        console.log(`Auto-queued: ${result.id}`);
      } else {
        console.error("Horde submit failed:", JSON.stringify(result).substring(0, 200));
      }
    } catch (e) {
      console.error("Auto-post error:", e.message);
    }
  }
}

// ──────────── ENTRY POINT ────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Webhook
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        if (update.message?.text?.startsWith("/")) {
          ctx.waitUntil(handleCommand(update.message, env));
        }
      } catch (e) {
        console.error("Webhook parse error:", e.message);
      }
      return new Response("OK", { status: 200 });
    }

    // Setup webhook
    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response("ERROR: TELEGRAM_BOT_TOKEN not set!\nGo to Worker Settings → Variables and Secrets", {
          status: 500,
        });
      }

      const webhookUrl = `${url.origin}/webhook`;
      const resp = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            allowed_updates: ["message"],
            drop_pending_updates: true,
          }),
        }
      );
      const result = await resp.json();

      let diagnostics = "\n\n--- Diagnostics ---\n";
      diagnostics += `BOT_KV: ${env.BOT_KV ? "OK" : "NOT BOUND!"}\n`;
      diagnostics += `HORDE_API_KEY: ${env.HORDE_API_KEY ? "OK" : "not set"}\n`;
      diagnostics += `OPENROUTER_API_KEY: ${env.OPENROUTER_API_KEY ? "OK" : "not set"}\n`;

      return new Response(
        `Webhook URL: ${webhookUrl}\nResult: ${JSON.stringify(result, null, 2)}${diagnostics}`,
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    // Health
    if (url.pathname === "/health") {
      const issues = checkEnv(env);
      return new Response(
        JSON.stringify({ status: issues.length === 0 ? "ok" : "issues", issues }, null, 2),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Root
    if (url.pathname === "/") {
      return new Response(
        "Telegram Image Bot v2\n/setup — configure webhook\n/health — check status",
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduled(env));
  },
};
