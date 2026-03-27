// ============================================================
// Telegram Image Bot — Cloudflare Workers (Upstash Redis Edition)
// AI Horde + OpenRouter + LLM Commands + Advanced Autoposting
// ============================================================

const DEFAULT_CONFIG = {
  enabled: false,
  chatId: null,
  channelId: null,
  postToBoth: false,
  adminId: null,
  interval: 60,
  count: 1,
  generalPrompt: "masterpiece, best quality, highly detailed",
  model: "AlbedoBase XL (SDXL)",
  loras: [],
  width: 1024,
  height: 1024,
  steps: 25,
  cfgScale: 7,
  sampler: "k_dpmpp_2m",
  nsfw: true,
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "google/gemma-2-9b-it:free",
  clipSkip: 2,
  hiresFix: false,
  hiresFixDenoising: 0.65,
  faceFixer: false,
  karras: true,
  autopostMode: 2, // 1: No prompt, 2: With prompt, 3: AI Text
  aiTextInstruction: "Write a short poetic description for this image.",
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:15.0:tg" };
const MAX_RETRIES = 3;
const MIN_IMAGE_KB = 10;

// ============================================================
// Redis (Upstash)
// ============================================================

class Redis {
  constructor(url, token) {
    this.url = url;
    this.token = token;
  }

  async exec(cmd, ...args) {
    const r = await fetch(`${this.url}/${cmd}/${args.map(a => encodeURIComponent(JSON.stringify(a))).join("/")}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const res = await r.json();
    return res.result;
  }

  async get(key) {
    const r = await fetch(`${this.url}/get/${key}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const res = await r.json();
    if (!res.result) return null;
    try { return JSON.parse(res.result); } catch { return res.result; }
  }

  async set(key, val, ex = null) {
    const body = ["set", key, JSON.stringify(val)];
    if (ex) body.push("EX", ex);
    const r = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  async del(key) {
    const r = await fetch(`${this.url}/del/${key}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    return r.json();
  }

  async keys(pattern) {
    const r = await fetch(`${this.url}/keys/${pattern}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    });
    const res = await r.json();
    return res.result || [];
  }
}

// ============================================================
// Telegram
// ============================================================

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
    return r.json();
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
    form.append("photo", new File([arrayBuffer], "image.webp", { type: "image/webp" }));
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
    return r.json();
  }

  edit(chatId, messageId, text, extra = {}) {
    return this.api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...extra,
    });
  }

  answerCallback(callbackQueryId, text = "", showAlert = false) {
    return this.api("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }
}

// ============================================================
// Helpers
// ============================================================

function escapeHtml(text) {
  if (text == null) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getConfig(redis) {
  const stored = await redis.get("config");
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function saveConfig(redis, config) {
  await redis.set("config", config);
}

// ============================================================
// LLM Logic
// ============================================================

async function askLLM(system, user, env, model = null) {
  if (!env.OPENROUTER_API_KEY) return null;
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
        model: model || "google/gemma-2-9b-it:free",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 1.1,
        max_tokens: 300,
      }),
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    console.error("[LLM Error]", e);
    return null;
  }
}

async function processPromptWithCommands(prompt, env) {
  const match = prompt.match(/\[(.*?)\]/);
  if (!match) return prompt;

  const command = match[1];
  const basePrompt = prompt.replace(/\[.*?\]/g, "").trim();
  
  const system = "You are a prompt engineer. Modify the user's base prompt according to their instructions in brackets. Output ONLY the final modified prompt, no explanations.";
  const user = `Base prompt: ${basePrompt}\nInstruction: ${command}`;
  
  const modified = await askLLM(system, user, env);
  return modified || basePrompt;
}

// ============================================================
// Horde API
// ============================================================

async function hordeSubmit(prompt, config, env, opts = {}) {
  const key = (env.HORDE_API_KEY || "").trim() || "0000000000";
  
  const params = {
    sampler_name: config.sampler,
    cfg_scale: config.cfgScale,
    width: config.width,
    height: config.height,
    steps: config.steps,
    karras: config.karras !== false,
    clip_skip: config.clipSkip || 2,
    post_processing: [],
    n: 1,
  };

  if (config.hiresFix) {
    params.hires_fix = true;
    params.hires_fix_denoising_strength = config.hiresFixDenoising || 0.65;
  }
  if (config.faceFixer) {
    params.post_processing.push("GFPGAN");
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
    prompt: config.negativePrompt ? `${prompt} ### ${config.negativePrompt}` : prompt,
    params,
    nsfw: true,
    censor_nsfw: false,
    models: [config.model],
    r2: true,
    allow_downgrade: true,
  };

  if (opts.workerBlacklist?.length > 0) {
    body.workers = opts.workerBlacklist.slice(0, 5);
    body.worker_blacklist = true;
  }

  const resp = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, ...HORDE_HEADERS },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ============================================================
// Menus
// ============================================================

function getMainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🎨 Генерировать", callback_data: "cmd_gen" }],
      [{ text: "⚙️ Настройки", callback_data: "menu_settings" }, { text: "📊 Статус", callback_data: "cmd_status" }],
      [{ text: "📋 Очередь", callback_data: "cmd_pending" }, { text: "🚫 Блэклист", callback_data: "cmd_workerbl" }]
    ]
  };
}

function getSettingsMenu() {
  return {
    inline_keyboard: [
      [{ text: "🖼 Картинка", callback_data: "menu_img" }, { text: "🤖 Модели", callback_data: "menu_models" }],
      [{ text: "✨ Улучшайзеры", callback_data: "menu_fx" }, { text: "📝 Промпты", callback_data: "menu_prompts" }],
      [{ text: "📢 Автопостинг", callback_data: "menu_auto" }, { text: "🔑 API", callback_data: "menu_api" }],
      [{ text: "🔙 Назад", callback_data: "menu_main" }]
    ]
  };
}

// ============================================================
// Main Handler
// ============================================================

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    
    const redis = new Redis(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    
    try {
      const update = await request.json();
      
      if (update.message) {
        await handleMessage(update.message, env, redis, tg);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env, redis, tg);
      }
    } catch (e) {
      console.error(e);
    }
    
    return new Response("OK");
  },

  async scheduled(event, env) {
    const redis = new Redis(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    await processScheduled(env, redis, tg);
    await processAutopost(env, redis, tg);
  }
};

async function handleMessage(msg, env, redis, tg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const config = await getConfig(redis);

  if (text === "/start" || text === "/menu") {
    await tg.send(chatId, "👋 Привет! Я продвинутый бот для генерации картинок.\nИспользуй меню для настройки.", {
      reply_markup: getMainMenu()
    });
    return;
  }

  // Обработка состояний ввода
  const state = await redis.get(`state:${chatId}`);
  if (state) {
    await redis.del(`state:${chatId}`);
    if (state === "set_prompt") {
      config.generalPrompt = text;
      await saveConfig(redis, config);
      await tg.send(chatId, "✅ Промпт сохранен!");
    } else if (state === "set_neg") {
      config.negativePrompt = text;
      await saveConfig(redis, config);
      await tg.send(chatId, "✅ Негативный промпт сохранен!");
    } else if (state === "search_model") {
      const models = await (await fetch(`${HORDE_API}/status/models?type=image`)).json();
      const found = models.filter(m => m.name.toLowerCase().includes(text.toLowerCase())).slice(0, 10);
      if (found.length === 0) {
        await tg.send(chatId, "❌ Ничего не найдено.");
      } else {
        const buttons = found.map(m => [{ text: m.name, callback_data: `setmod_${m.name}` }]);
        await tg.send(chatId, `🔍 Найдено моделей:`, { reply_markup: { inline_keyboard: buttons } });
      }
    } else if (state === "set_chat") {
      config.chatId = text;
      await saveConfig(redis, config);
      await tg.send(chatId, `✅ ID группы установлен: ${text}`);
    } else if (state === "set_channel") {
      config.channelId = text;
      await saveConfig(redis, config);
      await tg.send(chatId, `✅ ID канала установлен: ${text}`);
    }
    return;
  }

  if (text.startsWith("/")) {
    const cmd = text.split(" ")[0].toLowerCase();
    if (cmd === "/gen") {
      await triggerGeneration(chatId, config, env, redis, tg);
    }
  }
}

async function handleCallback(cb, env, redis, tg) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const data = cb.data;
  let config = await getConfig(redis);

  if (data === "menu_main") {
    await tg.edit(chatId, msgId, "Главное меню:", { reply_markup: getMainMenu() });
  } else if (data === "menu_settings") {
    await tg.edit(chatId, msgId, "Настройки:", { reply_markup: getSettingsMenu() });
  } else if (data === "menu_img") {
    const menu = {
      inline_keyboard: [
        [{ text: `Размер: ${config.width}x${config.height}`, callback_data: "toggle_size" }],
        [{ text: `Шаги: ${config.steps}`, callback_data: "inc_steps" }, { text: `CFG: ${config.cfgScale}`, callback_data: "inc_cfg" }],
        [{ text: "🔙 Назад", callback_data: "menu_settings" }]
      ]
    };
    await tg.edit(chatId, msgId, "Параметры изображения:", { reply_markup: menu });
  } else if (data === "menu_models") {
    const menu = {
      inline_keyboard: [
        [{ text: "🔍 Поиск модели", callback_data: "ask_search_model" }],
        [{ text: "📜 Список популярных", callback_data: "list_models" }],
        [{ text: "🔙 Назад", callback_data: "menu_settings" }]
      ]
    };
    await tg.edit(chatId, msgId, `Текущая модель: ${config.model}`, { reply_markup: menu });
  } else if (data === "menu_fx") {
    const menu = {
      inline_keyboard: [
        [{ text: `Hires Fix: ${config.hiresFix ? "✅" : "❌"}`, callback_data: "toggle_hires" }],
        [{ text: `Face Fix: ${config.faceFixer ? "✅" : "❌"}`, callback_data: "toggle_face" }],
        [{ text: `CLIP Skip: ${config.clipSkip}`, callback_data: "inc_clip" }],
        [{ text: "🔙 Назад", callback_data: "menu_settings" }]
      ]
    };
    await tg.edit(chatId, msgId, "Улучшайзеры:", { reply_markup: menu });
  } else if (data === "menu_prompts") {
    const menu = {
      inline_keyboard: [
        [{ text: "📝 Изменить промпт", callback_data: "ask_prompt" }],
        [{ text: "🚫 Изменить негатив", callback_data: "ask_neg" }],
        [{ text: "🔙 Назад", callback_data: "menu_settings" }]
      ]
    };
    await tg.edit(chatId, msgId, "Настройка промптов:", { reply_markup: menu });
  } else if (data === "menu_auto") {
    const modes = ["", "Без промпта", "С промптом", "AI Текст"];
    const menu = {
      inline_keyboard: [
        [{ text: `Автопостинг: ${config.enabled ? "🟢 ВКЛ" : "🔴 ВЫКЛ"}`, callback_data: "toggle_auto" }],
        [{ text: `Режим: ${modes[config.autopostMode]}`, callback_data: "cycle_automode" }],
        [{ text: `Группа: ${config.chatId ? "✅" : "❌"}`, callback_data: "ask_chat" }, { text: `Канал: ${config.channelId ? "✅" : "❌"}`, callback_data: "ask_channel" }],
        [{ text: `Оба: ${config.postToBoth ? "✅" : "❌"}`, callback_data: "toggle_both" }],
        [{ text: "🔙 Назад", callback_data: "menu_settings" }]
      ]
    };
    await tg.edit(chatId, msgId, "Настройки автопостинга:", { reply_markup: menu });
  } else if (data === "ask_prompt") {
    await redis.set(`state:${chatId}`, "set_prompt", 300);
    await tg.send(chatId, "Введите новый основной промпт:");
  } else if (data === "ask_search_model") {
    await redis.set(`state:${chatId}`, "search_model", 300);
    await tg.send(chatId, "Введите название модели для поиска:");
  } else if (data.startsWith("setmod_")) {
    config.model = data.replace("setmod_", "");
    await saveConfig(redis, config);
    await tg.answerCallback(cb.id, `Модель установлена: ${config.model}`);
    await tg.edit(chatId, msgId, `Текущая модель: ${config.model}`, { reply_markup: getSettingsMenu() });
  } else if (data === "toggle_auto") {
    config.enabled = !config.enabled;
    await saveConfig(redis, config);
    await handleCallback({ ...cb, data: "menu_auto" }, env, redis, tg);
  } else if (data === "cycle_automode") {
    config.autopostMode = (config.autopostMode % 3) + 1;
    await saveConfig(redis, config);
    await handleCallback({ ...cb, data: "menu_auto" }, env, redis, tg);
  } else if (data === "toggle_hires") {
    config.hiresFix = !config.hiresFix;
    await saveConfig(redis, config);
    await handleCallback({ ...cb, data: "menu_fx" }, env, redis, tg);
  } else if (data === "toggle_face") {
    config.faceFixer = !config.faceFixer;
    await saveConfig(redis, config);
    await handleCallback({ ...cb, data: "menu_fx" }, env, redis, tg);
  } else if (data === "cmd_gen") {
    await triggerGeneration(chatId, config, env, redis, tg);
    await tg.answerCallback(cb.id, "Запрос отправлен!");
  } else if (data === "cmd_status") {
    const status = `📊 <b>Статус</b>\n\nМодель: ${config.model}\nАвтопостинг: ${config.enabled ? "🟢" : "🔴"}\nРежим: ${config.autopostMode}\nГруппа: ${config.chatId || "—"}\nКанал: ${config.channelId || "—"}`;
    await tg.send(chatId, status);
    await tg.answerCallback(cb.id);
  } else if (data === "ask_chat") {
    await redis.set(`state:${chatId}`, "set_chat", 300);
    await tg.send(chatId, "Введите ID группы (например, -100...):");
  } else if (data === "ask_channel") {
    await redis.set(`state:${chatId}`, "set_channel", 300);
    await tg.send(chatId, "Введите ID канала (например, @mychannel или -100...):");
  } else if (data === "toggle_both") {
    config.postToBoth = !config.postToBoth;
    await saveConfig(redis, config);
    await handleCallback({ ...cb, data: "menu_auto" }, env, redis, tg);
  }

  await tg.answerCallback(cb.id);
}

async function triggerGeneration(chatId, config, env, redis, tg, isAutopost = false) {
  const prompt = await processPromptWithCommands(config.generalPrompt, env);
  const result = await hordeSubmit(prompt, config, env);
  
  if (result.id) {
    const targetChat = isAutopost ? (config.postToBoth ? [config.chatId, config.channelId] : [config.channelId || config.chatId]) : [chatId];
    await redis.set(`pending:${result.id}`, {
      chats: targetChat.filter(Boolean),
      prompt,
      at: Date.now(),
      notify: chatId,
      isAutopost,
      mode: config.autopostMode
    }, 3600);
    if (!isAutopost) await tg.send(chatId, `📤 Запрос отправлен! ID: <code>${result.id}</code>`);
  } else {
    if (!isAutopost) await tg.send(chatId, `❌ Ошибка Horde: ${JSON.stringify(result).substring(0, 200)}`);
  }
}

async function processScheduled(env, redis, tg) {
  const keys = await redis.keys("pending:*");
  for (const key of keys) {
    const id = key.replace("pending:", "");
    const data = await redis.get(key);
    if (!data) continue;

    const check = await (await fetch(`${HORDE_API}/generate/check/${id}`)).json();
    if (!check.done) continue;

    const result = await (await fetch(`${HORDE_API}/generate/status/${id}`)).json();
    await redis.del(key);

    if (result.generations?.[0]?.img) {
      const imgUrl = result.generations[0].img;
      const imgResp = await fetch(imgUrl);
      const buffer = await imgResp.arrayBuffer();
      
      let caption = "";
      if (data.isAutopost) {
        if (data.mode === 2) caption = `🎨 ${data.prompt}`;
        else if (data.mode === 3) {
          const config = await getConfig(redis);
          caption = await askLLM(config.aiTextInstruction, `Image prompt was: ${data.prompt}`, env) || data.prompt;
        }
      } else {
        caption = `🎨 ${data.prompt}`;
      }

      for (const chatId of data.chats) {
        await tg.sendPhoto(chatId, buffer, caption);
      }
    }
  }
}

async function processAutopost(env, redis, tg) {
  const config = await getConfig(redis);
  if (!config.enabled) return;

  const lastPost = await redis.get("last_autopost") || 0;
  if (Date.now() - lastPost < config.interval * 60 * 1000) return;

  await triggerGeneration(null, config, env, redis, tg, true);
  await redis.set("last_autopost", Date.now());
