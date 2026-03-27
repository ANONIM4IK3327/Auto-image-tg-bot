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
  cfgScale: 5,
  sampler: "k_dpmpp_2m",

  clipSkip: 2,
  karras: true,
  nsfw: true,

  negativePrompt: "worst quality, low quality, blurry",

  // NEW
  postProcessing: [],
  faceFix: false,
  upscale: null,

  captionMode: 1, // 0 none, 1 prompt, 2 ai text
  captionPrompt: "Опиши изображение красиво для телеграм поста",

  llmModel: "openrouter/auto",
};

// ================= REDIS (UPSTASH) =================
async function redis(env, cmd, args = []) {
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command: [cmd, ...args] }),
  });
  const json = await res.json();
  return json.result;
}

const KV = {
  async get(env, key) {
    const v = await redis(env, "GET", [key]);
    return v ? JSON.parse(v) : null;
  },
  async put(env, key, val) {
    await redis(env, "SET", [key, JSON.stringify(val)]);
  },
  async del(env, key) {
    await redis(env, "DEL", [key]);
  },
  async keys(env, prefix) {
    return await redis(env, "KEYS", [`${prefix}*`]);
  },
};

// ================= UTILS =================
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function escapeHtml(t) {
  return t?.replace(/[<>&]/g, "_") || "";
}

// ================= PROMPT COMMANDS =================
function applyPromptCommands(prompt, cfg) {
  const matches = prompt.match(/\[(.*?)\]/g);
  if (!matches) return { prompt, cfg };

  for (let m of matches) {
    const cmd = m.slice(1, -1).toLowerCase();

    if (cmd.startsWith("cfg:")) cfg.cfgScale = +cmd.split(":")[1];
    if (cmd.startsWith("steps:")) cfg.steps = +cmd.split(":")[1];
    if (cmd.startsWith("sampler:")) cfg.sampler = cmd.split(":")[1];
    if (cmd.startsWith("model:")) cfg.model = cmd.split(":")[1];
    if (cmd.startsWith("no:")) cfg.negativePrompt += ", " + cmd.split(":")[1];

    if (cmd === "facefix") cfg.postProcessing.push("GFPGAN");
    if (cmd === "upscale") cfg.postProcessing.push("RealESRGAN_x4plus");
  }

  return {
    prompt: prompt.replace(/\[.*?\]/g, "").trim(),
    cfg,
  };
}

// ================= HORDE =================
const HORDE = "https://stablehorde.net/api/v2";

async function hordeSubmit(prompt, cfg, env) {
  const { prompt: finalPrompt, cfg: newCfg } = applyPromptCommands(prompt, { ...cfg });

  const body = {
    prompt: finalPrompt + " ### " + newCfg.negativePrompt,
    params: {
      sampler_name: newCfg.sampler,
      cfg_scale: newCfg.cfgScale,
      width: newCfg.width,
      height: newCfg.height,
      steps: newCfg.steps,
      post_processing: newCfg.postProcessing,
      clip_skip: newCfg.clipSkip,
    },
    nsfw: true,
    models: [newCfg.model],
  };

  const res = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.HORDE_API_KEY || "0000000000",
    },
    body: JSON.stringify(body),
  });

  return await res.json();
}

// ================= OPENROUTER =================
async function aiCaption(env, text, imgPrompt) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openrouter/free",
      messages: [
        { role: "system", content: text },
        { role: "user", content: imgPrompt },
      ],
    }),
  });

  const j = await res.json();
  return j.choices?.[0]?.message?.content || imgPrompt;
}

// ================= TELEGRAM =================
class TG {
  constructor(token) {
    this.url = `https://api.telegram.org/bot${token}`;
  }

  async send(chat, text) {
    return fetch(`${this.url}/sendMessage`, {
      method: "POST",
      body: JSON.stringify({
        chat_id: chat,
        text,
        parse_mode: "HTML",
      }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async photo(chat, url, caption) {
    return fetch(`${this.url}/sendPhoto`, {
      method: "POST",
      body: JSON.stringify({
        chat_id: chat,
        photo: url,
        caption,
        parse_mode: "HTML",
      }),
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ================= COMMANDS =================
async function handle(msg, env) {
  const tg = new TG(env.TELEGRAM_BOT_TOKEN);
  const id = msg.chat.id;
  const text = msg.text || "";

  let cfg = (await KV.get(env, "config")) || DEFAULT_CONFIG;

  if (!cfg.adminId) {
    cfg.adminId = msg.from.id;
    await KV.put(env, "config", cfg);
  }

  if (msg.from.id !== cfg.adminId) return;

  // ===== BASIC =====
  if (text.startsWith("/setprompt")) {
    cfg.generalPrompt = text.replace("/setprompt", "").trim();
  }

  if (text === "/enable") cfg.enabled = true;
  if (text === "/disable") cfg.enabled = false;

  // ===== CHANNEL =====
  if (text.startsWith("/setchannel")) {
    cfg.channelId = text.split(" ")[1];
  }

  if (text === "/clearchannel") cfg.channelId = null;

  // ===== CAPTION =====
  if (text.startsWith("/setcaptionmode")) {
    cfg.captionMode = +text.split(" ")[1];
  }

  if (text.startsWith("/setcaptionprompt")) {
    cfg.captionPrompt = text.replace("/setcaptionprompt", "").trim();
  }

  // ===== POST PROCESS =====
  if (text === "/facefix") cfg.postProcessing.push("GFPGAN");

  if (text === "/upscale") cfg.postProcessing.push("RealESRGAN_x4plus");

  await KV.put(env, "config", cfg);

  await tg.send(id, "✅ OK");
}

// ================= CRON =================
async function cron(env) {
  const cfg = (await KV.get(env, "config")) || DEFAULT_CONFIG;
  if (!cfg.enabled) return;

  const tg = new TG(env.TELEGRAM_BOT_TOKEN);

  const prompt = cfg.generalPrompt;

  const job = await hordeSubmit(prompt, cfg, env);

  if (!job.id) return;

  // simplified polling
  await new Promise(r => setTimeout(r, 5000));

  const res = await fetch(`${HORDE}/generate/status/${job.id}`);
  const j = await res.json();

  const img = j.generations?.[0]?.img;
  if (!img) return;

  let caption = "";

  if (cfg.captionMode === 1) caption = prompt;
  if (cfg.captionMode === 2) {
    caption = await aiCaption(env, cfg.captionPrompt, prompt);
  }

  await tg.photo(cfg.chatId, img, caption);

  if (cfg.channelId) {
    await tg.photo(cfg.channelId, img, caption);
  }
}

// ================= WORKER =================
export default {
  async fetch(req, env) {
    if (req.method === "POST") {
      const upd = await req.json();
      if (upd.message) await handle(upd.message, env);
      return new Response("ok");
    }
    return new Response("running");
  },

  async scheduled(event, env) {
    await cron(env);
  },
};