// ============================================================
//  Telegram Image Bot — Cloudflare Workers
//  AI Horde (бесплатно, NSFW, LoRA из CivitAI)
//  OpenRouter (бесплатный тир, генерация уникальных промптов)
// ============================================================

// ──────────── ДЕФОЛТНЫЙ КОНФИГ ────────────
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
};

// ──────────── AI HORDE API ────────────
const HORDE = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:1.0:github" };

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

  // LoRA из CivitAI
  if (config.loras?.length > 0) {
    body.params.loras = config.loras.map((l) => ({
      name: String(l.name),
      model: l.strength ?? 1,
      clip: l.clip ?? 1,
      inject_trigger: "any",
      is_version: true, // Используем CivitAI version ID
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

// ──────────── TELEGRAM API ────────────
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
    return r.json();
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
    form.append("photo", blob, "image.png");
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
const VARIATION_ANGLES = [
  "from above at 45 degrees",
  "extreme low angle looking up",
  "eye level straight on",
  "dutch angle tilted frame",
  "bird's eye view from directly above",
  "over the shoulder perspective",
  "extreme close-up macro",
  "wide establishing shot",
  "medium portrait framing",
  "three-quarter view",
  "profile side view",
  "shot from behind",
];

const VARIATION_LIGHT = [
  "golden hour warm sunlight",
  "cool blue hour twilight",
  "dramatic chiaroscuro lighting",
  "soft diffused overcast light",
  "neon cyberpunk glow",
  "moonlit night scene",
  "studio rim lighting",
  "dappled forest light",
  "harsh midday shadows",
  "candlelit warm ambiance",
  "aurora borealis colors",
  "volumetric god rays",
  "backlit silhouette",
  "underwater caustics light",
];

const VARIATION_STYLE = [
  "photorealistic photography",
  "digital concept art",
  "oil painting impasto style",
  "watercolor soft washes",
  "anime cel shading",
  "dark fantasy illustration",
  "art nouveau decorative",
  "hyperrealistic 8k render",
  "noir high contrast",
  "surrealist dreamlike",
  "ukiyo-e japanese woodblock",
  "comic book pop art",
  "renaissance classical painting",
  "vaporwave aesthetic",
];

const VARIATION_MOOD = [
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
  "tense and suspenseful",
  "romantic and passionate",
];

const VARIATION_DETAIL = [
  "intricate filigree details",
  "rough textured surfaces",
  "smooth polished finish",
  "ornate baroque decoration",
  "minimalist clean lines",
  "weathered and aged patina",
  "crystalline sharp focus",
  "bokeh background blur",
  "particle effects and dust motes",
  "reflections and refractions",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function templatePrompt(base) {
  const parts = [
    base,
    pick(VARIATION_ANGLES),
    pick(VARIATION_LIGHT),
    pick(VARIATION_STYLE),
    pick(VARIATION_MOOD),
    ...pickN(VARIATION_DETAIL, 2),
    "masterpiece",
    "best quality",
    "highly detailed",
  ];
  return parts.join(", ");
}

async function generatePromptLLM(generalInstruction, apiKey, model) {
  // Случайная "директива" для разнообразия
  const directives = [
    "Focus on an unusual and creative camera perspective",
    "Emphasize dramatic lighting and deep shadows",
    "Place the subject in an unexpected environment",
    "Focus on intricate textures and micro-details",
    "Use a bold unconventional color palette",
    "Capture dynamic motion and energy",
    "Create a contemplative atmospheric scene",
    "Use extreme framing — very close or very wide",
    "Create cinematic movie-poster composition",
    "Emphasize contrast between elements in the scene",
    "Make it look like a Renaissance painting reimagined",
    "Give it a futuristic sci-fi aesthetic",
    "Add weather effects — rain, snow, fog, or storm",
    "Focus on reflections and mirror-like surfaces",
  ];

  const systemPrompt = `You are an expert AI image prompt engineer for Stable Diffusion.
Your task: take a general theme and create ONE unique, highly detailed prompt.

RULES:
- Output ONLY the prompt text. No explanations, no quotes, no markdown.
- Use Stable Diffusion format: comma-separated descriptive phrases
- Be extremely specific about: subject, pose, expression, action, setting, background, colors, lighting, camera angle, art style
- Include quality boosters: masterpiece, best quality, highly detailed, sharp focus
- Keep under 120 words
- Be creative and unpredictable
- Current creative direction: ${pick(directives)}`;

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
          {
            role: "user",
            content: `Theme: ${generalInstruction}\n\nGenerate a unique detailed Stable Diffusion prompt. Be creative.`,
          },
        ],
        temperature: 1.3,
        top_p: 0.95,
        max_tokens: 250,
      }),
    });

    const data = await resp.json();
    if (data.choices?.[0]?.message?.content) {
      let prompt = data.choices[0].message.content.trim();
      // Очистка от возможных кавычек/markdown
      prompt = prompt
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/^\*+|\*+$/g, "")
        .trim();
      if (prompt.length > 10) return prompt;
    }
  } catch (e) {
    console.error("LLM prompt generation failed:", e);
  }

  // Фолбэк на шаблоны
  return templatePrompt(generalInstruction);
}

async function generatePrompt(generalInstruction, env) {
  if (env.OPENROUTER_API_KEY) {
    const config = await getConfig(env);
    const model =
      config.llmModel || env.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
    return generatePromptLLM(generalInstruction, env.OPENROUTER_API_KEY, model);
  }
  return templatePrompt(generalInstruction);
}

// ──────────── KV ХЕЛПЕРЫ ────────────
async function getConfig(env) {
  try {
    const stored = await env.BOT_KV.get("config", "json");
    return { ...DEFAULT_CONFIG, ...(stored || {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(env, config) {
  await env.BOT_KV.put("config", JSON.stringify(config));
}

// ──────────── ОБРАБОТКА КОМАНД ────────────
async function handleCommand(message, env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  // Парсинг команды (убираем @botname)
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  let config = await getConfig(env);

  // Первый пользователь — админ
  if (!config.adminId) {
    config.adminId = userId;
    await saveConfig(env, config);
  }

  // Проверка прав
  if (config.adminId !== userId) {
    return; // Молча игнорируем не-админов
  }

  switch (cmd) {
    // ─── ПОМОЩЬ ───
    case "/start":
    case "/help": {
      await tg.msg(
        chatId,
        `🤖 <b>Image Generator Bot</b>

<b>📌 Основные:</b>
/setchat — установить текущий чат для постинга
/setprompt &lt;текст&gt; — общая инструкция
/setinterval &lt;минуты&gt; — интервал (мин. 1)
/setcount &lt;1-10&gt; — кол-во картинок за раз
/enable — включить автопостинг
/disable — выключить
/generate — сгенерировать сейчас

<b>🎨 Модель и LoRA:</b>
/setmodel &lt;название&gt; — выбрать модель
/listmodels — список доступных моделей
/searchlora &lt;запрос&gt; — поиск LoRA на CivitAI
/addlora &lt;version_id&gt; [сила] [clip] — добавить
/removelora &lt;version_id&gt; — удалить
/listloras — показать добавленные

<b>⚙️ Параметры:</b>
/setsize &lt;W&gt; &lt;H&gt; — размер (кратно 64)
/setsteps &lt;1-50&gt; — шаги генерации
/setcfg &lt;1-30&gt; — CFG Scale
/setsampler &lt;имя&gt; — сэмплер
/setneg &lt;текст&gt; — негативный промпт
/nsfw on|off — NSFW режим
/setllm &lt;model_id&gt; — LLM для промптов
/setclipskip &lt;1-4&gt; — CLIP Skip

<b>📊 Инфо:</b>
/status — все настройки
/pending — ожидающие генерации
/cancel — отменить все ожидающие`
      );
      break;
    }

    // ─── ЦЕЛЕВОЙ ЧАТ ───
    case "/setchat": {
      config.chatId = chatId;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Чат для постинга: <code>${chatId}</code>`);
      break;
    }

    // ─── ПРОМПТ ───
    case "/setprompt": {
      const prompt = args.join(" ");
      if (!prompt) {
        await tg.msg(chatId, "❌ /setprompt &lt;ваша общая инструкция&gt;");
        break;
      }
      config.generalPrompt = prompt;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Промпт:\n<code>${prompt}</code>`);
      break;
    }

    // ─── ИНТЕРВАЛ ───
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

    // ─── КОЛИЧЕСТВО ───
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

    // ─── МОДЕЛЬ ───
    case "/setmodel": {
      const name = args.join(" ");
      if (!name) {
        await tg.msg(
          chatId,
          "❌ /setmodel &lt;название&gt;\nИспользуй /listmodels"
        );
        break;
      }
      config.model = name;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Модель: <code>${name}</code>`);
      break;
    }

    // ─── СПИСОК МОДЕЛЕЙ ───
    case "/listmodels": {
      await tg.msg(chatId, "⏳ Загружаю список...");
      try {
        const models = await hordeModels();
        const sorted = models
          .filter((m) => m.count > 0)
          .sort((a, b) => b.count - a.count)
          .slice(0, 40);

        let txt = "📋 <b>Модели (топ-40 по воркерам):</b>\n\n";
        for (const m of sorted) {
          const tag =
            m.name.includes("XL") || m.name.includes("SDXL") ? "🟢" : "⚪";
          txt += `${tag} <code>${m.name}</code>  (${m.count}w)\n`;
        }
        txt +=
          "\n🟢 = SDXL  ⚪ = SD1.5\nКопируй название: /setmodel &lt;название&gt;";
        await tg.msg(chatId, txt);
      } catch (e) {
        await tg.msg(chatId, `❌ Ошибка: ${e.message}`);
      }
      break;
    }

    // ─── ПОИСК LORA НА CIVITAI ───
    case "/searchlora": {
      const query = args.join(" ");
      if (!query) {
        await tg.msg(chatId, "❌ /searchlora &lt;запрос на английском&gt;");
        break;
      }
      await tg.msg(chatId, "🔍 Ищу на CivitAI...");
      try {
        const url = `https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(query)}&limit=10&sort=Highest%20Rated&nsfw=true`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (!data.items?.length) {
          await tg.msg(chatId, "😕 Ничего не найдено");
          break;
        }

        let txt = `🔍 <b>LoRA: "${query}"</b>\n\n`;
        for (const item of data.items.slice(0, 10)) {
          const ver = item.modelVersions?.[0];
          const vid = ver?.id || "?";
          const nsfw = item.nsfw ? "🔞" : "✅";
          const dl = ver?.stats?.downloadCount || 0;
          const rating = ver?.stats?.rating
            ? `⭐${ver.stats.rating.toFixed(1)}`
            : "";
          const baseModel = ver?.baseModel || "?";

          txt += `${nsfw} <b>${item.name}</b> [${baseModel}] ${rating}\n`;
          txt += `   📥 ${dl} скачиваний\n`;
          txt += `   ➕ <code>/addlora ${vid} 0.8</code>\n\n`;
        }
        txt += "💡 Триггер-слова добавляются автоматически (inject_trigger: any)";
        await tg.msg(chatId, txt);
      } catch (e) {
        await tg.msg(chatId, `❌ ${e.message}`);
      }
      break;
    }

    // ─── ДОБАВИТЬ LORA ───
    case "/addlora": {
      const loraId = args[0];
      const strength = parseFloat(args[1]) || 0.8;
      const clip = parseFloat(args[2]) || 1;
      if (!loraId) {
        await tg.msg(
          chatId,
          "❌ /addlora &lt;civitai_version_id&gt; [strength=0.8] [clip=1]\n\nНайди через /searchlora"
        );
        break;
      }
      config.loras = config.loras || [];
      config.loras = config.loras.filter((l) => String(l.name) !== String(loraId));
      config.loras.push({ name: loraId, strength, clip });
      await saveConfig(env, config);
      await tg.msg(
        chatId,
        `✅ LoRA <code>${loraId}</code> (strength: ${strength}, clip: ${clip})`
      );
      break;
    }

    // ─── УДАЛИТЬ LORA ───
    case "/removelora": {
      const rid = args[0];
      if (!rid) {
        await tg.msg(chatId, "❌ /removelora &lt;id&gt;");
        break;
      }
      config.loras = (config.loras || []).filter(
        (l) => String(l.name) !== String(rid)
      );
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ LoRA <code>${rid}</code> удалена`);
      break;
    }

    // ─── СПИСОК LORA ───
    case "/listloras": {
      const loras = config.loras || [];
      if (!loras.length) {
        await tg.msg(chatId, "📋 Нет добавленных LoRA\n/searchlora для поиска");
        break;
      }
      let txt = "📋 <b>Ваши LoRA:</b>\n\n";
      loras.forEach((l, i) => {
        txt += `${i + 1}. ID: <code>${l.name}</code> (str: ${l.strength}, clip: ${l.clip})\n   ❌ /removelora ${l.name}\n\n`;
      });
      await tg.msg(chatId, txt);
      break;
    }

    // ─── РАЗМЕР ───
    case "/setsize": {
      let w = parseInt(args[0]);
      let h = parseInt(args[1]);
      if (isNaN(w) || isNaN(h) || w < 256 || h < 256 || w > 2048 || h > 2048) {
        await tg.msg(
          chatId,
          "❌ /setsize &lt;ширина&gt; &lt;высота&gt; (256-2048, кратно 64)\n\nПопулярные:\n<code>/setsize 1024 1024</code> — квадрат\n<code>/setsize 832 1216</code> — портрет\n<code>/setsize 1216 832</code> — ландшафт"
        );
        break;
      }
      config.width = Math.round(w / 64) * 64;
      config.height = Math.round(h / 64) * 64;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Размер: ${config.width}×${config.height}`);
      break;
    }

    // ─── ШАГИ ───
    case "/setsteps": {
      const s = parseInt(args[0]);
      if (isNaN(s) || s < 1 || s > 50) {
        await tg.msg(chatId, "❌ /setsteps &lt;1-50&gt;  (рекомендуется 20-30)");
        break;
      }
      config.steps = s;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Шаги: ${s}`);
      break;
    }

    // ─── CFG ───
    case "/setcfg": {
      const c = parseFloat(args[0]);
      if (isNaN(c) || c < 1 || c > 30) {
        await tg.msg(chatId, "❌ /setcfg &lt;1-30&gt;  (рекомендуется 5-9)");
        break;
      }
      config.cfgScale = c;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ CFG: ${c}`);
      break;
    }

    // ─── СЭМПЛЕР ───
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
      const sam = args[0];
      if (!sam || !samplers.includes(sam)) {
        await tg.msg(
          chatId,
          `❌ Выберите:\n${samplers.map((s) => `<code>${s}</code>`).join("\n")}\n\nРекомендуется: <code>k_dpmpp_2m</code> или <code>k_euler_a</code>`
        );
        break;
      }
      config.sampler = sam;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ Сэмплер: ${sam}`);
      break;
    }

    // ─── НЕГАТИВНЫЙ ПРОМПТ ───
    case "/setneg": {
      config.negativePrompt = args.join(" ") || DEFAULT_CONFIG.negativePrompt;
      await saveConfig(env, config);
      await tg.msg(
        chatId,
        `✅ Негативный промпт:\n<code>${config.negativePrompt}</code>`
      );
      break;
    }

    // ─── NSFW ───
    case "/nsfw": {
      const v = args[0]?.toLowerCase();
      if (v !== "on" && v !== "off") {
        await tg.msg(chatId, "❌ /nsfw on или /nsfw off");
        break;
      }
      config.nsfw = v === "on";
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ NSFW: ${config.nsfw ? "🔞 ВКЛ" : "✅ ВЫКЛ"}`);
      break;
    }

    // ─── LLM МОДЕЛЬ ───
    case "/setllm": {
      const llm = args.join(" ");
      if (!llm) {
        await tg.msg(
          chatId,
          `❌ /setllm &lt;model_id&gt;

Текущая: <code>${config.llmModel || env.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free"}</code>

<b>Бесплатные на OpenRouter:</b>
<code>meta-llama/llama-3.1-8b-instruct:free</code>
<code>google/gemma-2-9b-it:free</code>
<code>mistralai/mistral-7b-instruct:free</code>
<code>qwen/qwen-2-7b-instruct:free</code>
<code>huggingfaceh4/zephyr-7b-beta:free</code>

💡 Модели с :free в конце — бесплатные`
        );
        break;
      }
      config.llmModel = llm;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ LLM: <code>${llm}</code>`);
      break;
    }

    // ─── CLIP SKIP ───
    case "/setclipskip": {
      const cs = parseInt(args[0]);
      if (isNaN(cs) || cs < 1 || cs > 4) {
        await tg.msg(chatId, "❌ /setclipskip &lt;1-4&gt; (для anime обычно 2)");
        break;
      }
      config.clipSkip = cs;
      await saveConfig(env, config);
      await tg.msg(chatId, `✅ CLIP Skip: ${cs}`);
      break;
    }

    // ─── ВКЛЮЧИТЬ ───
    case "/enable": {
      if (!config.chatId) {
        await tg.msg(chatId, "❌ Сначала: /setchat");
        break;
      }
      if (!config.generalPrompt) {
        await tg.msg(chatId, "❌ Сначала: /setprompt &lt;инструкция&gt;");
        break;
      }
      config.enabled = true;
      await saveConfig(env, config);
      await tg.msg(
        chatId,
        `🟢 Автопостинг включён!\nИнтервал: ${config.interval} мин.\nКол-во: ${config.count}`
      );
      break;
    }

    // ─── ВЫКЛЮЧИТЬ ───
    case "/disable": {
      config.enabled = false;
      await saveConfig(env, config);
      await tg.msg(chatId, "🔴 Автопостинг выключен");
      break;
    }

    // ─── СТАТУС ───
    case "/status": {
      const lorasTxt =
        (config.loras || []).map((l) => `  • ${l.name} (${l.strength})`).join("\n") ||
        "  нет";

      const pending = await env.BOT_KV.list({ prefix: "pending:" });

      await tg.msg(
        chatId,
        `📊 <b>Настройки</b>

<b>Статус:</b> ${config.enabled ? "🟢 ВКЛ" : "🔴 ВЫКЛ"}
<b>Чат:</b> <code>${config.chatId || "—"}</code>
<b>Интервал:</b> ${config.interval} мин.
<b>Кол-во:</b> ${config.count}

<b>Промпт:</b>
<code>${config.generalPrompt || "—"}</code>

<b>Модель:</b> <code>${config.model}</code>
<b>Размер:</b> ${config.width}×${config.height}
<b>Шаги:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}
<b>Сэмплер:</b> ${config.sampler}
<b>CLIP Skip:</b> ${config.clipSkip || 1}
<b>NSFW:</b> ${config.nsfw ? "🔞 да" : "нет"}

<b>Негативный:</b>
<code>${config.negativePrompt}</code>

<b>LoRA:</b>
${lorasTxt}

<b>LLM:</b> <code>${config.llmModel || env.LLM_MODEL || "auto"}</code>
<b>В очереди:</b> ${pending.keys.length} шт.`
      );
      break;
    }

    // ─── ГЕНЕРАЦИЯ СЕЙЧАС ───
    case "/generate": {
      if (!config.generalPrompt) {
        await tg.msg(chatId, "❌ Сначала: /setprompt");
        break;
      }
      const targetChat = config.chatId || chatId;
      await tg.msg(chatId, `⏳ Генерирую ${config.count} изображений...`);

      for (let i = 0; i < config.count; i++) {
        try {
          const prompt = await generatePrompt(config.generalPrompt, env);
          await tg.msg(
            chatId,
            `🎨 #${i + 1}: <code>${prompt.substring(0, 400)}</code>`
          );

          const result = await hordeSubmit(prompt, config, env.HORDE_API_KEY);

          if (result.id) {
            await env.BOT_KV.put(
              `pending:${result.id}`,
              JSON.stringify({
                chatId: targetChat,
                prompt,
                submittedAt: Date.now(),
                notifyChat: chatId,
              }),
              { expirationTtl: 3600 }
            );
            await tg.msg(
              chatId,
              `📤 Отправлено в очередь (ID: <code>${result.id}</code>)`
            );
          } else {
            await tg.msg(
              chatId,
              `❌ Ошибка Horde: <code>${JSON.stringify(result).substring(0, 300)}</code>`
            );
          }
        } catch (e) {
          await tg.msg(chatId, `❌ ${e.message}`);
        }
      }
      break;
    }

    // ─── ОЖИДАЮЩИЕ ───
    case "/pending": {
      const list = await env.BOT_KV.list({ prefix: "pending:" });
      if (!list.keys.length) {
        await tg.msg(chatId, "📋 Очередь пуста");
        break;
      }
      let txt = `📋 <b>В очереди: ${list.keys.length}</b>\n\n`;
      for (const key of list.keys.slice(0, 10)) {
        const id = key.name.replace("pending:", "");
        try {
          const check = await hordeCheck(id);
          txt += `🔸 <code>${id}</code>\n`;
          txt += `   Позиция: ${check.queue_position} | ~${check.wait_time}с\n`;
          txt += `   ${check.done ? "✅ Готово!" : check.processing ? "⚙️ Генерируется..." : "⏳ В очереди"}\n\n`;
        } catch {
          txt += `🔸 <code>${id}</code> — не удалось проверить\n\n`;
        }
      }
      await tg.msg(chatId, txt);
      break;
    }

    // ─── ОТМЕНА ───
    case "/cancel": {
      const list = await env.BOT_KV.list({ prefix: "pending:" });
      for (const key of list.keys) {
        await env.BOT_KV.delete(key.name);
      }
      await tg.msg(chatId, `🗑 Удалено из очереди: ${list.keys.length}`);
      break;
    }

    default: {
      if (cmd.startsWith("/")) {
        await tg.msg(chatId, "❓ Неизвестная команда — /help");
      }
    }
  }
}

// ──────────── ПЛАНИРОВЩИК (CRON) ────────────
async function processScheduled(env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);

  // 1. Проверяем pending генерации
  const pendingList = await env.BOT_KV.list({ prefix: "pending:" });

  for (const key of pendingList.keys) {
    const id = key.name.replace("pending:", "");
    let data;

    try {
      data = await env.BOT_KV.get(key.name, "json");
      if (!data) {
        await env.BOT_KV.delete(key.name);
        continue;
      }

      // Таймаут 20 минут
      if (Date.now() - data.submittedAt > 20 * 60 * 1000) {
        await env.BOT_KV.delete(key.name);
        if (data.notifyChat) {
          await tg.msg(data.notifyChat, `⏰ Таймаут: <code>${id}</code>`);
        }
        continue;
      }

      const check = await hordeCheck(id);

      if (!check.done) continue;

      // Готово! Забираем результат
      const result = await hordeResult(id);
      await env.BOT_KV.delete(key.name);

      if (result.faulted) {
        if (data.notifyChat) {
          await tg.msg(data.notifyChat, `❌ Генерация <code>${id}</code> провалилась`);
        }
        continue;
      }

      if (result.generations?.length > 0) {
        for (const gen of result.generations) {
          if (!gen.img) continue;

          const caption = data.prompt
            ? `🎨 <i>${data.prompt.substring(0, 200)}...</i>`
            : "";

          // Пробуем отправить URL
          const urlResult = await tg.sendPhotoUrl(data.chatId, gen.img, caption);

          if (!urlResult.ok) {
            // Фолбэк: скачиваем и загружаем
            try {
              const imgResp = await fetch(gen.img);
              if (imgResp.ok) {
                const blob = await imgResp.blob();
                await tg.sendPhotoBlob(data.chatId, blob, caption);
              }
            } catch (e) {
              console.error("Failed to send image:", e);
              if (data.notifyChat) {
                await tg.msg(
                  data.notifyChat,
                  `❌ Не удалось отправить изображение: ${e.message}`
                );
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(`Error processing ${id}:`, e);
    }
  }

  // 2. Автопостинг — отправляем новые генерации
  if (!config.enabled || !config.chatId || !config.generalPrompt) return;

  // Не отправляем новые, если есть pending
  const currentPending = await env.BOT_KV.list({ prefix: "pending:" });
  if (currentPending.keys.length > 0) return;

  // Проверяем интервал
  const lastPost = parseInt((await env.BOT_KV.get("last_post_time")) || "0");
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  // Время постить!
  await env.BOT_KV.put("last_post_time", String(now));

  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await generatePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env.HORDE_API_KEY);

      if (result.id) {
        await env.BOT_KV.put(
          `pending:${result.id}`,
          JSON.stringify({
            chatId: config.chatId,
            prompt,
            submittedAt: now,
            notifyChat: null, // Тихий режим для автопостинга
          }),
          { expirationTtl: 3600 }
        );
      }
    } catch (e) {
      console.error("Auto-post error:", e);
    }
  }
}

// ──────────── ENTRY POINT ────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Вебхук от Telegram
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        if (update.message?.text?.startsWith("/")) {
          ctx.waitUntil(handleCommand(update.message, env));
        }
      } catch (e) {
        console.error("Webhook error:", e);
      }
      return new Response("OK");
    }

    // Установка вебхука
    if (url.pathname === "/setup") {
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
      return new Response(
        `Webhook: ${webhookUrl}\nResult: ${JSON.stringify(result, null, 2)}`,
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    // Информация
    if (url.pathname === "/") {
      return new Response(
        "🤖 Telegram Image Bot is running!\nVisit /setup to configure webhook.",
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduled(env));
  },
};
