// ================= CONFIG =================
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
  cfgScale: 7,
  sampler: "k_dpmpp_2m",

  nsfw: true,
  negativePrompt: "worst quality, low quality, blurry",

  clipSkip: 2,

  hiresFix: false,
  hiresFixDenoising: 0.65,

  karras: true,

  postProcessing: [], // 🔥 NEW

  llmModel: "openrouter/auto",

  autopostMode: 2 // 0=no text,1=prompt,2=AI caption
};

// ================= REDIS =================
const Redis = {
  async cmd(env, ...args) {
    const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ command: args })
    });
    return res.json();
  },

  async get(env, key) {
    const r = await this.cmd(env, "GET", key);
    return r.result ? JSON.parse(r.result) : null;
  },

  async set(env, key, value) {
    await this.cmd(env, "SET", key, JSON.stringify(value));
  },

  async del(env, key) {
    await this.cmd(env, "DEL", key);
  },

  async keys(env, prefix) {
    const r = await this.cmd(env, "SCAN", "0", "MATCH", prefix + "*");
    return r.result?.[1] || [];
  }
};

// ================= TELEGRAM =================
class Telegram {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async api(method, data) {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    return res.json();
  }

  send(chat, text, extra = {}) {
    return this.api("sendMessage", {
      chat_id: chat,
      text,
      parse_mode: "HTML",
      ...extra
    });
  }

  keyboard(chat, text, buttons) {
    return this.api("sendMessage", {
      chat_id: chat,
      text,
      reply_markup: { inline_keyboard: buttons }
    });
  }

  sendPhoto(chat, buffer, caption = "") {
    const f = new FormData();
    f.append("chat_id", chat);
    f.append("photo", new File([buffer], "img.webp"));
    if (caption) f.append("caption", caption);

    return fetch(`${this.base}/sendPhoto`, { method: "POST", body: f });
  }
}

// ================= HORDE =================
const HORDE = "https://stablehorde.net/api/v2";

async function hordeGenerate(prompt, cfg, env) {
  const body = {
    prompt: prompt + " ### " + cfg.negativePrompt,
    params: {
      sampler_name: cfg.sampler,
      cfg_scale: cfg.cfgScale,
      width: cfg.width,
      height: cfg.height,
      steps: cfg.steps,
      karras: cfg.karras,
      post_processing: cfg.postProcessing,
      clip_skip: cfg.clipSkip
    },
    models: [cfg.model],
    nsfw: true,
    r2: true,
    allow_downgrade: true
  };

  if (cfg.hiresFix) {
    body.params.hires_fix = true;
    body.params.hires_fix_denoising_strength = cfg.hiresFixDenoising;
  }

  const res = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.HORDE_API_KEY
    },
    body: JSON.stringify(body)
  });

  return res.json();
}

// ================= LLM PROMPT =================
function applyPromptCommands(text) {
  // [style: anime], [add: ...], [remove: ...]
  return text.replace(/\[(.*?)\]/g, (_, cmd) => {
    if (cmd.startsWith("add:")) return cmd.replace("add:", "");
    if (cmd.startsWith("remove:")) return "";
    if (cmd.startsWith("style:")) return cmd.replace("style:", "");
    return "";
  });
}

// ================= AI CAPTION =================
async function generateCaption(prompt, env) {
  if (!env.OPENROUTER_API_KEY) return prompt;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openrouter/auto",
      messages: [
        { role: "system", content: "Write a short красивый пост для Telegram" },
        { role: "user", content: prompt }
      ]
    })
  });

  const j = await res.json();
  return j.choices?.[0]?.message?.content || prompt;
}

// ================= COMMANDS =================
async function handle(msg, env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const chat = msg.chat.id;
  const user = msg.from.id;
  const text = msg.text || "";

  let cfg = await Redis.get(env, "config") || DEFAULT_CONFIG;

  if (!cfg.adminId) {
    cfg.adminId = user;
    await Redis.set(env, "config", cfg);
  }

  if (user !== cfg.adminId) return tg.send(chat, "🔒 admin only");

  if (text === "/menu") {
    return tg.keyboard(chat, "⚙️ Меню", [
      [{ text: "🎨 Модель", callback_data: "model" }],
      [{ text: "🧠 LLM", callback_data: "llm" }],
      [{ text: "📤 Автопост", callback_data: "auto" }]
    ]);
  }

  if (text.startsWith("/setprompt")) {
    cfg.generalPrompt = text.replace("/setprompt", "").trim();
    await Redis.set(env, "config", cfg);
    return tg.send(chat, "✅ prompt set");
  }

  if (text === "/generate") {
    let p = applyPromptCommands(cfg.generalPrompt);

    const gen = await hordeGenerate(p, cfg, env);

    if (!gen.id) return tg.send(chat, "❌ Horde error");

    await Redis.set(env, "pending:" + gen.id, {
      prompt: p,
      chatId: chat
    });

    return tg.send(chat, "⏳ Генерация...");
  }

  if (text === "/setchannel") {
    cfg.channelId = chat;
    await Redis.set(env, "config", cfg);
    return tg.send(chat, "✅ канал привязан");
  }

  if (text === "/setgroup") {
    cfg.chatId = chat;
    await Redis.set(env, "config", cfg);
    return tg.send(chat, "✅ группа привязана");
  }

  if (text === "/autopostmode") {
    cfg.autopostMode = (cfg.autopostMode + 1) % 3;
    await Redis.set(env, "config", cfg);
    return tg.send(chat, "🔄 режим: " + cfg.autopostMode);
  }
}

// ================= CRON =================
async function cron(env) {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const cfg = await Redis.get(env, "config");
  if (!cfg?.enabled) return;

  const keys = await Redis.keys(env, "pending:");

  for (const key of keys) {
    const id = key.replace("pending:", "");

    const res = await fetch(`${HORDE}/generate/status/${id}`);
    const data = await res.json();

    if (!data.done) continue;

    await Redis.del(env, key);

    const img = data.generations?.[0]?.img;
    if (!img) continue;

    let caption = "";

    if (cfg.autopostMode === 1) caption = cfg.generalPrompt;
    if (cfg.autopostMode === 2)
      caption = await generateCaption(cfg.generalPrompt, env);

    const buffer = await (await fetch(img)).arrayBuffer();

    if (cfg.chatId) await tg.sendPhoto(cfg.chatId, buffer, caption);
    if (cfg.channelId) await tg.sendPhoto(cfg.channelId, buffer, caption);
  }
}

// ================= EXPORT =================
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/webhook") {
      const upd = await req.json();
      if (upd.message) await handle(upd.message, env);
      return new Response("ok");
    }

    if (url.pathname === "/setup") {
      await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.origin + "/webhook" })
        }
      );
      return new Response("ok");
    }

    return new Response("running");
  },

  async scheduled(_, env) {
    await cron(env);
  }
};