// ============================================================
// Telegram Image Bot — Cloudflare Workers
// AI Horde + OpenRouter + Upstash Redis
// ============================================================

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:15.0:tg" };
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_CONFIG = {
  enabled: false,
  groupId: null,
  channelId: null,
  interval: 60,
  postMode: 1, // 0: Без текста, 1: Промпт, 2: ИИ текст
  generalPrompt: "",
  model: "AlbedoBase XL (SDXL)",
  loras: [],
  width: 1024,
  height: 1024,
  steps: 25,
  cfgScale: 7,
  sampler: "k_dpmpp_2m",
  nsfw: true,
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text",
  faceFixer: false,
  upscaler: false,
};

// --- База данных (Upstash Redis) ---
async function redisGet(env, key) {
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) { return null; }
}

async function redisSet(env, key, value) {
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(value)
  });
}

// --- Telegram API ---
async function tg(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// --- OpenRouter (LLM) ---
async function callLLM(env, systemPrompt, userText) {
  if (!env.OPENROUTER_API_KEY) return userText;
  try {
    const res = await fetch(OPENROUTER_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "google/gemma-2-9b-it:free", // Бесплатная модель для оптимизации
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ]
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || userText;
  } catch (e) {
    return userText;
  }
}

// --- AI Horde API ---
async function requestHorde(env, prompt, config) {
  const payload = {
    prompt: prompt + " ### " + config.negativePrompt,
    params: {
      sampler_name: config.sampler,
      cfg_scale: config.cfgScale,
      steps: config.steps,
      width: config.width,
      height: config.height,
      karras: true,
      hires_fix: config.upscaler,
      facefixer_algos: config.faceFixer ? ["GFPGAN"] : []
    },
    nsfw: config.nsfw,
    censor_nsfw: !config.nsfw,
    models: [config.model],
    source_image: null
  };

  const headers = { ...HORDE_HEADERS, "Content-Type": "application/json" };
  if (env.HORDE_API_KEY) headers["apikey"] = env.HORDE_API_KEY;

  const res = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  return res.json();
}

async function checkHordeStatus(env, id) {
  const res = await fetch(`${HORDE_API}/generate/check/${id}`, { headers: HORDE_HEADERS });
  return res.json();
}

async function getHordeStatus(env, id) {
  const res = await fetch(`${HORDE_API}/generate/status/${id}`, { headers: HORDE_HEADERS });
  return res.json();
}

// --- Генератор (Асинхронный процесс) ---
async function processGeneration(env, chatId, originalPrompt, config, messageId = null) {
  try {
    let finalPrompt = originalPrompt;
    
    // 4. Обработка команд в скобках [ ] для LLM
    const llmMatch = originalPrompt.match(/\[(.*?)\]/);
    if (llmMatch) {
      const instruction = llmMatch[1];
      const basePrompt = originalPrompt.replace(/\[.*?\]/, "").trim();
      if (messageId) await tg(env, "sendMessage", { chat_id: chatId, text: `🧠 LLM обрабатывает инструкцию: "${instruction}"...` });
      
      finalPrompt = await callLLM(
        env, 
        `Ты — ИИ-ассистент по написанию промптов для Stable Diffusion. Улучши или измени предоставленный базовый промпт, следуя инструкции пользователя. Отправь В ОТВЕТ ТОЛЬКО ИТОГОВЫЙ ПРОМПТ НА АНГЛИЙСКОМ ЯЗЫКЕ, без приветствий и лишнего текста.`, 
        `Инструкция: ${instruction}\nБазовый промпт: ${basePrompt}`
      );
    }

    if (messageId) {
      await tg(env, "sendMessage", { chat_id: chatId, text: `🎨 Отправка в AI Horde...\nПромпт: ${finalPrompt}` });
    }

    const initReq = await requestHorde(env, finalPrompt, config);
    if (!initReq.id) throw new Error(initReq.message || "Ошибка API Horde");

    // Полинг (ожидание генерации)
    let ready = false;
    let imageUrl = null;
    let attempts = 0;
    
    while (!ready && attempts < 30) {
      await new Promise(r => setTimeout(r, 5000)); // Ждем 5 сек
      const check = await checkHordeStatus(env, initReq.id);
      if (check.done) {
        const status = await getHordeStatus(env, initReq.id);
        if (status.generations && status.generations.length > 0) {
          imageUrl = status.generations[0].img;
          ready = true;
        } else {
          throw new Error("Генерация завершена, но изображение не найдено.");
        }
      } else if (!check.is_possible) {
         throw new Error("Генерация невозможна (нет доступных воркеров с этой моделью).");
      }
      attempts++;
    }

    if (!imageUrl) throw new Error("Таймаут ожидания генерации.");

    // Отправка результата
    let caption = "";
    // 5. Выбор режима подписи (по умолчанию или для автопоста)
    if (config.postMode === 1) {
      caption = `🎨 Промпт: ${finalPrompt}`;
    } else if (config.postMode === 2) {
      caption = await callLLM(
        env,
        "Ты креативный SMM-менеджер. Напиши короткий, красивый и вовлекающий пост (2-3 предложения) на русском языке для Telegram-канала на основе этого промпта. Добавь пару эмодзи.",
        finalPrompt
      );
    }

    await tg(env, "sendPhoto", {
      chat_id: chatId,
      photo: imageUrl,
      caption: caption
    });

  } catch (error) {
    await tg(env, "sendMessage", { chat_id: chatId, text: `❌ Ошибка: ${error.message}` });
  }
}

// --- Обработчики Telegram ---
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  
  let config = await redisGet(env, `config_${chatId}`) || DEFAULT_CONFIG;

  if (text.startsWith("/start")) {
    return tg(env, "sendMessage", { chat_id: chatId, text: "👋 Привет! Я готов к генерации. Напиши промпт или вызови /menu для настроек." });
  }

  if (text.startsWith("/menu")) {
    return sendMenu(env, chatId, config);
  }

  // 6. Управление каналами и группами
  if (text.startsWith("/setgroup")) {
    config.groupId = chatId;
    await redisSet(env, `config_${chatId}`, config);
    return tg(env, "sendMessage", { chat_id: chatId, text: "✅ Эта группа установлена как основная для автопостов." });
  }

  if (text.startsWith("/unsetgroup")) {
    config.groupId = null;
    await redisSet(env, `config_${chatId}`, config);
    return tg(env, "sendMessage", { chat_id: chatId, text: "❌ Группа отвязана." });
  }

  if (text.startsWith("/setchannel")) {
    const parts = text.split(" ");
    if (parts.length < 2) return tg(env, "sendMessage", { chat_id: chatId, text: "Укажи ID канала, например: /setchannel -100123456789" });
    config.channelId = parts[1];
    await redisSet(env, `config_${chatId}`, config);
    return tg(env, "sendMessage", { chat_id: chatId, text: `✅ Канал ${config.channelId} привязан.` });
  }

  if (text.startsWith("/unsetchannel")) {
    config.channelId = null;
    await redisSet(env, `config_${chatId}`, config);
    return tg(env, "sendMessage", { chat_id: chatId, text: "❌ Канал отвязан." });
  }

  // Если это обычный текст - запускаем генерацию
  if (text && !text.startsWith("/")) {
    env.ctx.waitUntil(processGeneration(env, chatId, text, config, msg.message_id));
    return tg(env, "sendMessage", { chat_id: chatId, text: "⏳ Запрос принят в обработку..." });
  }
}

// 1 & 2 & 3. Меню настроек с кнопками и улучшенным интерфейсом
async function sendMenu(env, chatId, config, messageId = null) {
  const keyboard = {
    inline_keyboard: [
      [{ text: `🎨 Модель: ${config.model.substring(0, 20)}`, callback_data: "menu_models" }],
      [{ text: `Настройки текста поста: ${['Откл', 'Промпт', 'ИИ Текст'][config.postMode]}`, callback_data: "menu_postmode" }],
      [
        { text: `Вкл. Лицо (GFPGAN): ${config.faceFixer ? '✅' : '❌'}`, callback_data: "toggle_face" },
        { text: `Апскейл (Hires): ${config.upscaler ? '✅' : '❌'}`, callback_data: "toggle_upscale" }
      ],
      [{ text: `NSFW: ${config.nsfw ? '✅' : '❌'}`, callback_data: "toggle_nsfw" }]
    ]
  };

  const text = `⚙️ **Настройки бота**\n\nМодель: ${config.model}\nУлучшение лица: ${config.faceFixer}\nАпскейл: ${config.upscaler}`;
  
  if (messageId) {
    return tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown", reply_markup: keyboard });
  } else {
    return tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", reply_markup: keyboard });
  }
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data;

  let config = await redisGet(env, `config_${chatId}`) || DEFAULT_CONFIG;

  if (data === "menu_main") {
    await sendMenu(env, chatId, config, messageId);
  } else if (data === "toggle_face") {
    config.faceFixer = !config.faceFixer;
  } else if (data === "toggle_upscale") {
    config.upscaler = !config.upscaler;
  } else if (data === "toggle_nsfw") {
    config.nsfw = !config.nsfw;
  } else if (data === "menu_postmode") {
    config.postMode = (config.postMode + 1) % 3;
  } else if (data === "menu_models") {
    // Мини-пагинация для популярных моделей (можно расширить запросом к API Horde)
    const models = ["AlbedoBase XL (SDXL)", "DreamShaper", "CyberRealistic", "Deliberate"];
    const kb = models.map(m => ([{ text: m, callback_data: `setmodel_${m.substring(0,20)}` }]));
    kb.push([{ text: "⬅️ Назад", callback_data: "menu_main" }]);
    
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: messageId,
      text: "Выбери модель:",
      reply_markup: { inline_keyboard: kb }
    });
    return tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  } else if (data.startsWith("setmodel_")) {
    config.model = data.replace("setmodel_", "");
    // Возвращаемся в главное меню после выбора
    await redisSet(env, `config_${chatId}`, config);
    await sendMenu(env, chatId, config, messageId);
    return tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Модель изменена!" });
  }

  // Сохраняем и обновляем меню
  await redisSet(env, `config_${chatId}`, config);
  if (data.startsWith("toggle_") || data === "menu_postmode") {
    await sendMenu(env, chatId, config, messageId);
  }
  
  return tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
}

// ============================================================
// Точка входа Cloudflare Worker
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    env.ctx = ctx; // Сохраняем контекст для асинхронных задач (waitUntil)

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      try {
        const upd = await request.json();
        if (upd.message?.text) {
          await handleMessage(upd.message, env);
        } else if (upd.callback_query) {
          await handleCallback(upd.callback_query, env);
        }
      } catch (e) {
        console.error("[WH Error]", e.message);
      }
      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TELEGRAM_BOT_TOKEN!", { status: 500 });
      const wh = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: wh, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }),
      });
      return new Response(`Webhook configured: ${wh}\n\n${JSON.stringify(await r.json(), null, 2)}`);
    }

    return new Response("🤖 Telegram Image Bot is running!\nVisit /setup to configure webhook.");
  },

  // 6. Автопостинг по расписанию (настраивается в cron триггерах Cloudflare)
  async scheduled(event, env, ctx) {
    env.ctx = ctx;
    // В реальном сценарии здесь нужно доставать список ID всех чатов из Redis
    // Для примера используем захардкоженный ID админа или берем один известный конфиг
    // (Потребуется доработка логики хранения всех пользователей, если бот публичный)
    const adminChatId = env.ADMIN_CHAT_ID; 
    if (!adminChatId) return;

    const config = await redisGet(env, `config_${adminChatId}`) || DEFAULT_CONFIG;
    if (!config.enabled || !config.generalPrompt) return;

    const autoPrompt = config.generalPrompt + " [make it random and creative]"; 

    if (config.groupId) {
      ctx.waitUntil(processGeneration(env, config.groupId, autoPrompt, config));
    }
    if (config.channelId) {
      ctx.waitUntil(processGeneration(env, config.channelId, autoPrompt, config));
    }
  }
};