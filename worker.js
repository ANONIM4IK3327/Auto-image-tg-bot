// ============================================================
// Telegram Image Bot — Cloudflare Workers (V16.0 Full)
// Migration to Upstash Redis REST API
// ============================================================

const DEFAULT_CONFIG = {
  enabled: false,
  chats: { channel: null, group: null }, // Поддержка двух каналов одновременно
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
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "google/gemma-2-9b-it:free",
  clipSkip: 2,
  hiresFix: false,
  karras: true,
  // Новые настройки
  faceFixer: false,
  postProcessors: [], // Сюда можно добавлять апскейлеры через меню
  captionMode: 1, // 0 - без текста, 1 - промпт, 2 - AI описание
  aiInstruction: "Write a creative short caption for this image."
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:16.0:tg" };
const MAX_RETRIES = 3;

// --- Вспомогательные функции (Upstash Redis) ---

async function getConfig(env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    console.error("Upstash credentials missing in env variables!");
    return { ...DEFAULT_CONFIG };
  }

  try {
    const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json"
      },
      // Используем команду GET по ключу "bot_config"
      body: JSON.stringify(["GET", "bot_config"])
    });
    
    const data = await res.json();
    
    if (data.result) {
      return JSON.parse(data.result);
    }
  } catch (e) {
    console.error("Redis Get Error:", e.message);
  }
  
  return { ...DEFAULT_CONFIG };
}

async function saveConfig(env, config) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return;

  try {
    await fetch(env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json"
      },
      // Используем команду SET для ключа "bot_config"
      body: JSON.stringify(["SET", "bot_config", JSON.stringify(config)])
    });
  } catch (e) {
    console.error("Redis Set Error:", e.message);
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Класс Telegram для работы с сообщениями и кнопками ---

class Telegram {
  constructor(token) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async api(method, body) {
    const r = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async sendMessage(chatId, text, markup = null) {
    return this.api("sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      reply_markup: markup,
    });
  }

  async editMessage(chatId, messageId, text, markup = null) {
    return this.api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: "HTML",
      reply_markup: markup,
    });
  }

  async sendPhoto(chatId, photoUrl, caption, notify = true) {
    return this.api("sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: "HTML",
      disable_notification: !notify,
    });
  }
}

// --- Интеграция с OpenRouter (LLM) ---

async function askLLM(env, system, user) {
  const config = await getConfig(env);
  if (!env.OPENROUTER_API_KEY) return null;
  
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: config.llmModel || "google/gemma-2-9b-it:free",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch (e) {
    console.error("LLM Error:", e.message);
    return null;
  }
}

// --- Обработка команд пользователя ---

async function handleCommand(msg, env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const config = await getConfig(env);

  if (config.adminId && chatId !== parseInt(config.adminId)) return;

  if (text === "/start") {
    await tg.sendMessage(chatId, "Бот готов. Нажми /settings для настройки.");
    return;
  }

  if (text === "/settings") {
    await sendSettingsMenu(tg, chatId, config);
    return;
  }

  if (text.startsWith("/models")) {
    const query = text.replace("/models", "").trim();
    await handleModelsSearch(tg, chatId, query);
    return;
  }

  // Привязка чатов
  if (text.startsWith("/setchannel")) {
    const id = text.split(" ")[1];
    config.chats.channel = id;
    await saveConfig(env, config);
    await tg.sendMessage(chatId, `✅ Канал для постинга установлен: <code>${id}</code>`);
  }

  if (text.startsWith("/setgroup")) {
    const id = text.split(" ")[1];
    config.chats.group = id;
    await saveConfig(env, config);
    await tg.sendMessage(chatId, `✅ Группа для постинга установлена: <code>${id}</code>`);
  }
}

// --- Меню настроек ---

async function sendSettingsMenu(tg, chatId, config, messageId = null) {
  const text = `⚙️ <b>Панель управления</b>\n\n` +
    `🤖 Статус: ${config.enabled ? "✅ ЗАПУЩЕН" : "⏸ ОСТАНОВЛЕН"}\n` +
    `📦 Модель: <code>${config.model}</code>\n` +
    `📝 Текст поста: <b>${["Нет", "Промпт", "AI Генерация"][config.captionMode]}</b>\n` +
    `👤 Fix Face: ${config.faceFixer ? "✅" : "❌"}\n\n` +
    `Канал: <code>${config.chats.channel || "—"}</code>\n` +
    `Группа: <code>${config.chats.group || "—"}</code>`;

  const markup = {
    inline_keyboard: [
      [{ text: config.enabled ? "🛑 Стоп" : "▶️ Пуск", callback_data: "toggle_run" }],
      [{ text: "🎭 Режим подписи", callback_data: "cycle_caption" }, { text: "👤 Лицо", callback_data: "toggle_face" }],
      [{ text: "🔎 Поиск моделей", callback_data: "search_models" }, { text: "🔗 Чаты", callback_data: "menu_chats" }]
    ]
  };

  if (messageId) {
    await tg.editMessage(chatId, messageId, text, markup);
  } else {
    await tg.sendMessage(chatId, text, markup);
  }
}

async function handleCallback(cb, env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  let config = await getConfig(env);

  if (cb.data === "toggle_run") config.enabled = !config.enabled;
  if (cb.data === "toggle_face") config.faceFixer = !config.faceFixer;
  if (cb.data === "cycle_caption") config.captionMode = (config.captionMode + 1) % 3;
  
  if (cb.data === "menu_chats") {
    const markup = { inline_keyboard: [[{ text: "🗑 Отвязать всё", callback_data: "unlink_all" }], [{ text: "⬅️ Назад", callback_data: "back" }]] };
    await tg.editMessage(chatId, messageId, "Управление привязками. Используй /setchannel [id] или /setgroup [id] для привязки.", markup);
    return;
  }

  if (cb.data === "unlink_all") {
    config.chats = { channel: null, group: null };
  }

  if (cb.data === "back") {
    await sendSettingsMenu(tg, chatId, config, messageId);
    return;
  }

  await saveConfig(env, config);
  await sendSettingsMenu(tg, chatId, config, messageId);
  await tg.api("answerCallbackQuery", { callback_query_id: cb.id });
}

// --- Улучшенный поиск моделей ---

async function handleModelsSearch(tg, chatId, query) {
  try {
    const res = await fetch(`${HORDE_API}/models?type=image`);
    const models = await res.json();
    
    let filtered = models;
    if (query) {
      filtered = models.filter(m => m.name.toLowerCase().includes(query.toLowerCase()));
    }

    const list = filtered.slice(0, 15).map(m => `• <code>${m.name}</code>`).join("\n");
    const text = `🔍 <b>Результаты поиска (${filtered.length})</b>\n\n${list}\n\n${filtered.length > 15 ? "<i>Уточните запрос для поиска конкретной модели.</i>" : ""}`;
    await tg.sendMessage(chatId, text);
  } catch (e) {
    await tg.sendMessage(chatId, "Ошибка при получении списка моделей.");
  }
}

// --- Основная логика генерации (Cron) ---

async function processScheduled(env) {
  const config = await getConfig(env);
  if (!config.enabled) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  
  let finalPrompt = config.generalPrompt || "masterpiece, highly detailed";
  const match = finalPrompt.match(/\[(.*?)\]/);
  if (match && env.OPENROUTER_API_KEY) {
    const instruction = match[1];
    const base = finalPrompt.replace(match[0], "").trim();
    const systemInstruction = "You are an AI prompt engineer. Change the prompt using the user instruction. Return ONLY the new prompt text.";
    const revised = await askLLM(env, systemInstruction, `Original prompt: ${base}\nInstruction to change: ${instruction}`);
    if (revised) finalPrompt = revised;
  }

  const hordePayload = {
    prompt: finalPrompt,
    params: {
      sampler_name: config.sampler,
      cfg_scale: config.cfgScale,
      width: config.width,
      height: config.height,
      steps: config.steps,
      karras: config.karras,
      hires_fix: config.hiresFix,
      facefixer_strength: config.faceFixer ? 0.75 : 0,
      post_processing: config.faceFixer ? ["GFPGAN"] : []
    },
    models: [config.model],
    nsfw: config.nsfw,
    censor_nsfw: !config.nsfw
  };

  try {
    const submitRes = await fetch(`${HORDE_API}/generate/async`, {
      method: "POST",
      headers: { ...HORDE_HEADERS, "Content-Type": "application/json", "apikey": env.HORDE_API_KEY || "0000000000" },
      body: JSON.stringify(hordePayload)
    });
    const { id } = await submitRes.json();

    let imgUrl = null;
    for (let i = 0; i < 30; i++) { // 5 минут ожидания
      await new Promise(r => setTimeout(r, 10000));
      const statusRes = await fetch(`${HORDE_API}/generate/check/${id}`);
      const status = await statusRes.json();
      if (status.done) {
        const getRes = await fetch(`${HORDE_API}/generate/status/${id}`);
        const result = await getRes.json();
        if (result.generations?.[0]?.img) {
          imgUrl = result.generations[0].img;
          break;
        }
      }
    }

    if (!imgUrl) return;

    let caption = "";
    if (config.captionMode === 1) {
      caption = `🎨 <b>Prompt:</b> ${escapeHtml(finalPrompt)}`;
    } else if (config.captionMode === 2) {
      caption = await askLLM(env, "Write a short catchy Telegram post caption (2 sentences) for an image.", `Image theme: ${finalPrompt}`);
    }

    const targets = [];
    if (config.chats.channel) targets.push(config.chats.channel);
    if (config.chats.group) targets.push(config.chats.group);

    for (const chat of targets) {
      await tg.sendPhoto(chat, imgUrl, caption);
    }

  } catch (e) {
    console.error("Critical Error during generation:", e.message);
  }
}

// --- Экспорт воркера ---

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      const upd = await request.json();
      if (upd.callback_query) {
        await handleCallback(upd.callback_query, env);
      } else if (upd.message) {
        await handleCommand(upd.message, env);
      }
      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      const wh = `${url.origin}/webhook`;
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            url: wh, 
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: true 
        }),
      });
      return new Response("✅ Бот обновлен! Теперь кнопки работают.");
    }

    return new Response("Bot is active.");
  },

  async scheduled(event, env) {
    await processScheduled(env);
  }
};
