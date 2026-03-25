// ============================================================
//  Telegram Image Bot v7 — base64 mode, no R2 URLs
//  Fix: r2:false → image returned as base64 in response
//       No expiring URLs, no download issues
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

const HORDE = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:7.0:tg" };
const MAX_RETRIES = 3;

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
    const res = await r.json();
    if (!res.ok) console.error(`[TG] ${method}:`, JSON.stringify(res));
    return res;
  }

  msg(chatId, text) {
    return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  }

  sendPhotoUrl(chatId, url, caption = "") {
    return this.call("sendPhoto", {
      chat_id: chatId, photo: url,
      caption: caption.substring(0, 1024), parse_mode: "HTML",
    });
  }

  async sendPhotoBuffer(chatId, arrayBuffer, caption = "") {
    console.log("[TG] sendPhotoBuffer bytes:", arrayBuffer.byteLength);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([arrayBuffer], { type: "image/png" }), "photo.png");
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.api}/sendPhoto`, { method: "POST", body: form });
    const res = await r.json();
    if (!res.ok) console.error("[TG] sendPhotoBuffer:", JSON.stringify(res));
    return res;
  }
}

// ──────────── KV ────────────

async function kvGet(env, key, type = "text") {
  if (!env.BOT_KV) return null;
  try { return await env.BOT_KV.get(key, type); } catch { return null; }
}
async function kvPut(env, key, val, opts = {}) {
  if (!env.BOT_KV) throw new Error("KV не привязан!");
  await env.BOT_KV.put(key, val, opts);
}
async function kvDel(env, key) { if (env.BOT_KV) await env.BOT_KV.delete(key); }
async function kvList(env, prefix) {
  if (!env.BOT_KV) return { keys: [] };
  return env.BOT_KV.list({ prefix });
}
async function getConfig(env) {
  const s = await kvGet(env, "config", "json");
  return { ...DEFAULT_CONFIG, ...(s || {}) };
}
async function saveConfig(env, c) { await kvPut(env, "config", JSON.stringify(c)); }

// ──────────── HORDE ────────────

function getApiKey(env) {
  return (env.HORDE_API_KEY || "").trim() || "0000000000";
}

async function checkHordeKey(env) {
  const key = getApiKey(env);
  try {
    const resp = await fetch(`${HORDE}/find_user`, {
      headers: { apikey: key, ...HORDE_HEADERS },
    });
    if (resp.status === 401 || resp.status === 403)
      return { valid: false, anon: key === "0000000000", error: `HTTP ${resp.status}` };
    const d = await resp.json();
    return { valid: true, anon: key === "0000000000", username: d.username, kudos: d.kudos, trusted: d.trusted, flagged: d.flagged };
  } catch (e) {
    return { valid: false, anon: key === "0000000000", error: e.message };
  }
}

async function hordeSubmit(prompt, config, env) {
  const apiKey = getApiKey(env);

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
    prompt: config.negativePrompt
      ? `${prompt} ### ${config.negativePrompt}`
      : prompt,
    params,
    nsfw: true,
    censor_nsfw: false,
    trusted_workers: true,
    models: [config.model],
    r2: false,                    // ← КЛЮЧЕВОЕ: base64 вместо R2 URL
    replacement_filter: false,
    shared: false,
    slow_workers: false,
    allow_downgrade: true,
    dry_run: false,
  };

  console.log("[HORDE] Submit:", JSON.stringify(body).substring(0, 600));

  const resp = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
      ...HORDE_HEADERS,
    },
    body: JSON.stringify(body),
  });

  const result = await resp.json();
  console.log("[HORDE] Response:", JSON.stringify(result).substring(0, 300));
  return result;
}

async function hordeCheck(id) {
  const r = await fetch(`${HORDE}/generate/check/${id}`, { headers: HORDE_HEADERS });
  return r.json();
}

async function hordeStatus(id) {
  const r = await fetch(`${HORDE}/generate/status/${id}`, { headers: HORDE_HEADERS });
  return r.json();
}

async function hordeModels() {
  const r = await fetch(`${HORDE}/status/models?type=image`, { headers: HORDE_HEADERS });
  return r.json();
}

// ──────────── BASE64 → ARRAYBUFFER ────────────

function base64ToArrayBuffer(b64) {
  // Убираем возможный data:image/... префикс
  const clean = b64.replace(/^data:image\/\w+;base64,/, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ──────────── ОТПРАВКА КАРТИНКИ ────────────

async function deliverImage(tg, chatId, imgData, caption, notifyChat) {
  if (!imgData) {
    if (notifyChat) await tg.msg(notifyChat, "❌ Нет данных картинки");
    return false;
  }

  try {
    let arrayBuffer;

    if (imgData.startsWith("http")) {
      // На случай если вдруг URL (не должно быть с r2:false)
      console.log("[DELIVER] Downloading URL:", imgData.substring(0, 80));
      const resp = await fetch(imgData);
      if (!resp.ok) {
        if (notifyChat) await tg.msg(notifyChat, `❌ Скачивание: HTTP ${resp.status}`);
        return false;
      }
      arrayBuffer = await resp.arrayBuffer();
    } else {
      // Base64 — основной путь
      console.log("[DELIVER] Decoding base64, length:", imgData.length);
      arrayBuffer = base64ToArrayBuffer(imgData);
    }

    console.log("[DELIVER] Image bytes:", arrayBuffer.byteLength);

    // Проверка на пустую/чёрную картинку (< 5KB подозрительно мало)
    if (arrayBuffer.byteLength < 5000) {
      console.warn("[DELIVER] Suspiciously small:", arrayBuffer.byteLength);
      if (notifyChat) await tg.msg(notifyChat, `⚠️ Картинка подозрительно маленькая (${arrayBuffer.byteLength} байт)`);
    }

    // Отправляем в Telegram
    const res = await tg.sendPhotoBuffer(chatId, arrayBuffer, caption);

    if (res.ok) {
      console.log("[DELIVER] ✅ Sent!");
      return true;
    }

    console.error("[DELIVER] ❌ Telegram rejected:", res.description);
    if (notifyChat) await tg.msg(notifyChat, `❌ Telegram: ${res.description}`);
    return false;

  } catch (e) {
    console.error("[DELIVER] Error:", e.message);
    if (notifyChat) await tg.msg(notifyChat, `❌ ${e.message}`);
    return false;
  }
}

// ──────────── PROMPTS ────────────

const VA = ["from above","low angle","eye level","dutch angle","bird's eye","close-up","wide shot","portrait","three-quarter","profile","from behind","over shoulder"];
const VL = ["golden hour","blue twilight","chiaroscuro","soft overcast","neon glow","moonlit","rim lighting","dappled light","harsh shadows","candlelit","god rays","backlit"];
const VS = ["photorealistic","concept art","oil painting","watercolor","anime","dark fantasy","hyperrealistic","noir","surrealist","pop art","renaissance","vaporwave"];
const VM = ["serene","dramatic","mysterious","vibrant","ethereal","dark","intimate","epic","melancholic","playful","suspenseful","romantic"];
const VD = ["intricate details","rough textures","smooth finish","baroque","clean lines","aged patina","sharp focus","bokeh","particles","reflections"];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function templatePrompt(base) {
  return [base,pick(VA),pick(VL),pick(VS),pick(VM),pick(VD),pick(VD),"masterpiece","best quality","highly detailed"].join(", ");
}

async function llmPrompt(instr, apiKey, model) {
  const dirs = ["unusual perspective","dramatic lighting","unexpected environment","intricate textures","bold colors","dynamic motion","atmospheric","extreme framing","cinematic","weather effects","reflections","futuristic"];
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://t.me", "X-Title": "ImgBot" },
      body: JSON.stringify({
        model: model || "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          { role: "system", content: `Stable Diffusion prompt engineer. ONLY comma-separated phrases. No quotes/markdown. Under 100 words. Direction: ${pick(dirs)}` },
          { role: "user", content: `Unique image prompt for: ${instr}` },
        ],
        temperature: 1.3, max_tokens: 200,
      }),
    });
    const d = await r.json();
    if (d.choices?.[0]?.message?.content) {
      let p = d.choices[0].message.content.trim().replace(/^["'`*]+|["'`*]+$/g, "");
      if (p.length > 10) return p;
    }
  } catch (e) { console.error("[LLM]", e.message); }
  return templatePrompt(instr);
}

async function makePrompt(instr, env) {
  if (env.OPENROUTER_API_KEY) {
    const c = await getConfig(env);
    return llmPrompt(instr, env.OPENROUTER_API_KEY, c.llmModel || env.LLM_MODEL || "meta-llama/llama-3.1-8b-instruct:free");
  }
  return templatePrompt(instr);
}

// ──────────── CENSOR LOG ────────────

async function getCensorLog(env) { return (await kvGet(env, "censor_log", "json")) || []; }
async function logCensor(env, wId, wName) {
  const log = await getCensorLog(env);
  log.push({ id: wId, name: wName, ts: Date.now() });
  while (log.length > 50) log.shift();
  await kvPut(env, "censor_log", JSON.stringify(log));
}
async function clearCensorLog(env) { await kvPut(env, "censor_log", "[]"); }

// ──────────── COMMANDS ────────────

async function handleCommand(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text || "";
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  console.log(`[CMD] ${userId} "${cmd}"`);

  // ── Без KV ──

  if (cmd === "/ping") {
    const k = getApiKey(env);
    await tg.msg(chatId, `🏓 v7\nChat: <code>${chatId}</code>\nUser: <code>${userId}</code>\nKV:${env.BOT_KV?"✅":"❌"} Horde:${k==="0000000000"?"❌ANON":"✅"} OR:${env.OPENROUTER_API_KEY?"✅":"⚠️"}`);
    return;
  }

  if (cmd === "/diagnostic") {
    const k = getApiKey(env);
    let t = `🔧 <b>v7</b>\nKV:${env.BOT_KV?"✅":"❌"} TOKEN:✅\nHORDE:${k==="0000000000"?"❌ANON":"✅"+k.substring(0,6)+"..."} OR:${env.OPENROUTER_API_KEY?"✅":"⚠️"}\nr2: false (base64 mode)`;
    if (k==="0000000000") t += "\n\n🔴 https://stablehorde.net/register → Workers Secrets → HORDE_API_KEY";
    await tg.msg(chatId, t); return;
  }

  if (cmd === "/checkkey") {
    await tg.msg(chatId, "🔑...");
    const i = await checkHordeKey(env);
    if (!i.valid) { await tg.msg(chatId, `❌ ${i.error}\nhttps://stablehorde.net/register`); }
    else { await tg.msg(chatId, `✅ ${i.username}\nKudos:${i.kudos} Trusted:${i.trusted} Flagged:${i.flagged}\n${i.anon?"🔴 Анонимный!":"✅ NSFW OK"}`); }
    return;
  }

  if (cmd === "/testimg") {
    await tg.msg(chatId, "🧪 Тест 1: URL...");
    const r1 = await tg.sendPhotoUrl(chatId, "https://picsum.photos/512/512", "URL ✅");
    await tg.msg(chatId, r1.ok ? "✅ URL OK\n\nТест 2: Buffer..." : `❌ URL: ${r1.description}\n\nТест 2: Buffer...`);
    try {
      const resp = await fetch("https://picsum.photos/256/256");
      const buf = await resp.arrayBuffer();
      const r2 = await tg.sendPhotoBuffer(chatId, buf, "Buffer ✅");
      await tg.msg(chatId, r2.ok ? "✅ Buffer OK — всё работает!" : `❌ Buffer: ${r2.description}`);
    } catch (e) { await tg.msg(chatId, `❌ ${e.message}`); }
    return;
  }

  // ── KV ──

  if (!env.BOT_KV) { await tg.msg(chatId, "❌ KV! /diagnostic"); return; }

  let config = await getConfig(env);

  if (!config.adminId) {
    config.adminId = userId; await saveConfig(env, config);
    await tg.msg(chatId, `👑 <code>${userId}</code>`);
  }
  if (config.adminId !== userId) { await tg.msg(chatId, `🔒 ${config.adminId}`); return; }

  switch (cmd) {

  case "/start": case "/help":
    await tg.msg(chatId,
`🤖 <b>v7</b> (base64 mode)

/ping /diagnostic /checkkey /testimg

/setchat /setprompt /setinterval /setcount
/setmodel /listmodels
/searchlora /addlora /removelora /listloras
/setsize /setsteps /setcfg /setsampler
/setneg /nsfw /setclipskip /setllm
/hiresfix /karras
/enable /disable /generate /debuggen
/status /pending /cancel
/censorlog /clearcensorlog /resetadmin`);
    break;

  case "/resetadmin": config.adminId=userId; await saveConfig(env,config); await tg.msg(chatId,`✅ ${userId}`); break;
  case "/setchat": config.chatId=chatId; await saveConfig(env,config); await tg.msg(chatId,`✅ <code>${chatId}</code>`); break;

  case "/setprompt": {
    const p=args.join(" ");
    if(!p){await tg.msg(chatId,"❌ /setprompt текст");break;}
    config.generalPrompt=p; await saveConfig(env,config);
    await tg.msg(chatId,`✅ <code>${p}</code>`); break;
  }

  case "/setinterval": {
    const m=parseInt(args[0]);
    if(isNaN(m)||m<1){await tg.msg(chatId,"❌ минуты");break;}
    config.interval=m; await saveConfig(env,config);
    await tg.msg(chatId,`✅ ${m}м`); break;
  }

  case "/setcount": {
    const n=parseInt(args[0]);
    if(isNaN(n)||n<1||n>10){await tg.msg(chatId,"❌ 1-10");break;}
    config.count=n; await saveConfig(env,config);
    await tg.msg(chatId,`✅ ${n}`); break;
  }

  case "/setmodel": {
    const nm=args.join(" ");
    if(!nm){await tg.msg(chatId,"❌ /listmodels");break;}
    config.model=nm; await saveConfig(env,config);
    await tg.msg(chatId,`✅ <code>${nm}</code>`); break;
  }

  case "/listmodels": {
    await tg.msg(chatId,"⏳...");
    const models=await hordeModels();
    const top=models.filter(m=>m.count>0).sort((a,b)=>b.count-a.count).slice(0,30);
    let t="📋\n\n";
    top.forEach(m=>{
      const tag=(m.name.includes("XL")||m.name.includes("SDXL")||m.name.includes("Pony"))?"🟢":"⚪";
      t+=`${tag} <code>${m.name}</code> (${m.count})\n`;
    });
    await tg.msg(chatId,t+"\n/setmodel имя"); break;
  }

  case "/searchlora": {
    const q=args.join(" ");
    if(!q){await tg.msg(chatId,"❌ запрос");break;}
    await tg.msg(chatId,"🔍...");
    const r=await fetch(`https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(q)}&limit=8&sort=Highest%20Rated&nsfw=true`);
    const d=await r.json();
    if(!d.items?.length){await tg.msg(chatId,"😕");break;}
    let t="";
    d.items.forEach(i=>{
      const v=i.modelVersions?.[0];
      t+=`${i.nsfw?"🔞":"✅"} <b>${i.name}</b> [${v?.baseModel||"?"}]\n<code>/addlora ${v?.id||"?"} 0.8</code>\n\n`;
    });
    await tg.msg(chatId,t); break;
  }

  case "/addlora": {
    const id=args[0],str=parseFloat(args[1])||0.8,cl=parseFloat(args[2])||1;
    if(!id){await tg.msg(chatId,"❌ id [str] [clip]");break;}
    config.loras=(config.loras||[]).filter(l=>String(l.name)!==String(id));
    config.loras.push({name:id,strength:str,clip:cl});
    await saveConfig(env,config);
    await tg.msg(chatId,`✅ ${id} (${str}/${cl})`); break;
  }

  case "/removelora":
    if(!args[0]){await tg.msg(chatId,"❌");break;}
    config.loras=(config.loras||[]).filter(l=>String(l.name)!==String(args[0]));
    await saveConfig(env,config); await tg.msg(chatId,"✅"); break;

  case "/listloras": {
    const ll=config.loras||[];
    if(!ll.length){await tg.msg(chatId,"Нет. /searchlora");break;}
    let t="";
    ll.forEach(l=>{t+=`• <code>${l.name}</code> (${l.strength}/${l.clip}) /removelora ${l.name}\n`;});
    await tg.msg(chatId,t); break;
  }

  case "/setsize": {
    const w=parseInt(args[0]),h=parseInt(args[1]);
    if(isNaN(w)||isNaN(h)||w<256||h<256||w>2048||h>2048){await tg.msg(chatId,"<code>/setsize 704 1024</code>");break;}
    config.width=Math.round(w/64)*64; config.height=Math.round(h/64)*64;
    await saveConfig(env,config);
    await tg.msg(chatId,`✅ ${config.width}×${config.height}`); break;
  }

  case "/setsteps": {const s=parseInt(args[0]);if(isNaN(s)||s<1||s>50){await tg.msg(chatId,"❌ 1-50");break;}config.steps=s;await saveConfig(env,config);await tg.msg(chatId,`✅ ${s}`);break;}
  case "/setcfg": {const c=parseFloat(args[0]);if(isNaN(c)||c<1||c>30){await tg.msg(chatId,"❌ 1-30");break;}config.cfgScale=c;await saveConfig(env,config);await tg.msg(chatId,`✅ ${c}`);break;}

  case "/setsampler": {
    const sl=["k_euler","k_euler_a","k_lms","k_heun","k_dpm_2","k_dpm_2_a","k_dpmpp_2s_a","k_dpmpp_2m","k_dpmpp_sde","DDIM"];
    if(!args[0]||!sl.includes(args[0])){await tg.msg(chatId,sl.map(s=>`<code>${s}</code>`).join("\n"));break;}
    config.sampler=args[0];await saveConfig(env,config);await tg.msg(chatId,`✅ ${args[0]}`);break;
  }

  case "/setneg": config.negativePrompt=args.join(" ")||DEFAULT_CONFIG.negativePrompt;await saveConfig(env,config);await tg.msg(chatId,"✅");break;

  case "/nsfw":
    if(args[0]!=="on"&&args[0]!=="off"){await tg.msg(chatId,"/nsfw on|off");break;}
    config.nsfw=args[0]==="on";await saveConfig(env,config);
    await tg.msg(chatId,`✅ ${config.nsfw?"🔞":"OFF"}`);break;

  case "/setclipskip": {const cs=parseInt(args[0]);if(isNaN(cs)||cs<1||cs>4){await tg.msg(chatId,"❌ 1-4");break;}config.clipSkip=cs;await saveConfig(env,config);await tg.msg(chatId,`✅ ${cs}`);break;}

  case "/setllm": {
    const l=args.join(" ");
    if(!l){await tg.msg(chatId,`<code>meta-llama/llama-3.1-8b-instruct:free</code>\n<code>google/gemma-2-9b-it:free</code>`);break;}
    config.llmModel=l;await saveConfig(env,config);await tg.msg(chatId,`✅`);break;
  }

  case "/hiresfix":
    if(args[0]!=="on"&&args[0]!=="off"){await tg.msg(chatId,"/hiresfix on|off [0-1]");break;}
    config.hiresFix=args[0]==="on";
    if(args[1])config.hiresFixDenoising=parseFloat(args[1])||0.65;
    await saveConfig(env,config);await tg.msg(chatId,`✅ ${config.hiresFix?"ON":"OFF"}`);break;

  case "/karras":
    if(args[0]!=="on"&&args[0]!=="off"){await tg.msg(chatId,"/karras on|off");break;}
    config.karras=args[0]==="on";await saveConfig(env,config);await tg.msg(chatId,`✅`);break;

  case "/enable":
    if(!config.chatId){await tg.msg(chatId,"❌ /setchat");break;}
    if(!config.generalPrompt){await tg.msg(chatId,"❌ /setprompt");break;}
    config.enabled=true;await saveConfig(env,config);
    await tg.msg(chatId,`🟢 ${config.interval}м × ${config.count}`);break;

  case "/disable": config.enabled=false;await saveConfig(env,config);await tg.msg(chatId,"🔴");break;

  case "/status": {
    const k=getApiKey(env);
    const pend=await kvList(env,"pending:");
    const clog=await getCensorLog(env);
    const loras=(config.loras||[]).map(l=>`  • ${l.name} (${l.strength})`).join("\n")||"  нет";
    await tg.msg(chatId,
`📊 <b>v7</b> ${config.enabled?"🟢":"🔴"} r2:false
Chat:<code>${config.chatId||"—"}</code> ${config.interval}м×${config.count}

<code>${config.generalPrompt||"—"}</code>

<code>${config.model}</code>
${config.width}×${config.height} S:${config.steps} CFG:${config.cfgScale}
${config.sampler} CLIP:${config.clipSkip} Karras:${config.karras!==false?"✅":"❌"} HiRes:${config.hiresFix?"✅":"❌"}
NSFW:${config.nsfw?"🔞":"❌"} Horde:${k==="0000000000"?"❌":"✅"} trusted:✅

LoRA:\n${loras}

LLM:<code>${config.llmModel||"auto"}</code>
Censor:${clog.length} Queue:${pend.keys.length}`);
    break;
  }

  case "/debuggen": {
    const k=getApiKey(env);
    await tg.msg(chatId,`🧪 Key:${k==="0000000000"?"❌":"✅"} Model:${config.model} r2:false`);

    const prompt="beautiful woman, studio photo, elegant, soft lighting, masterpiece, best quality";
    try {
      const result=await hordeSubmit(prompt,config,env);
      if(result.id){
        await kvPut(env,`pending:${result.id}`,JSON.stringify({
          chatId,prompt,submittedAt:Date.now(),notifyChat:chatId,debug:true,retryCount:0,
        }),{expirationTtl:3600});
        await tg.msg(chatId,`📤 <code>${result.id}</code>\nЖди отчёт...`+(result.message?`\n⚠️ ${result.message}`:""));
      } else {
        await tg.msg(chatId,`❌ ${JSON.stringify(result).substring(0,500)}`);
      }
    } catch(e){await tg.msg(chatId,`❌ ${e.message}`);}
    break;
  }

  case "/generate": {
    if(!config.generalPrompt){await tg.msg(chatId,"❌ /setprompt");break;}
    const target=config.chatId||chatId;
    await tg.msg(chatId,`⏳ ${config.count}шт...`);
    for(let i=0;i<config.count;i++){
      try{
        const prompt=await makePrompt(config.generalPrompt,env);
        await tg.msg(chatId,`🎨 #${i+1}: <code>${prompt.substring(0,200)}</code>`);
        const result=await hordeSubmit(prompt,config,env);
        if(result.id){
          await kvPut(env,`pending:${result.id}`,JSON.stringify({
            chatId:target,prompt,submittedAt:Date.now(),notifyChat:chatId,retryCount:0,
          }),{expirationTtl:3600});
          await tg.msg(chatId,`📤 <code>${result.id}</code>`);
        }else{await tg.msg(chatId,`❌ ${JSON.stringify(result).substring(0,300)}`);}
      }catch(e){await tg.msg(chatId,`❌ ${e.message}`);}
    }
    break;
  }

  case "/pending": {
    const list=await kvList(env,"pending:");
    if(!list.keys.length){await tg.msg(chatId,"📋 Пусто");break;}
    let t=`📋 ${list.keys.length}:\n\n`;
    for(const kk of list.keys.slice(0,10)){
      const id=kk.name.replace("pending:","");
      try{const ch=await hordeCheck(id);t+=`• <code>${id}</code> ${ch.done?"✅":ch.processing?"⚙️":`⏳#${ch.queue_position}`} ~${ch.wait_time}с\n`;}
      catch{t+=`• <code>${id}</code> ?\n`;}
    }
    await tg.msg(chatId,t);break;
  }

  case "/cancel": {
    const list=await kvList(env,"pending:");
    for(const kk of list.keys) await kvDel(env,kk.name);
    await tg.msg(chatId,`🗑 ${list.keys.length}`);break;
  }

  case "/censorlog": {
    const log=await getCensorLog(env);
    if(!log.length){await tg.msg(chatId,"📋 Пусто");break;}
    let t=`🚫 ${log.length}:\n`;
    log.slice(-10).forEach(w=>{t+=`• <code>${w.name}</code> ${new Date(w.ts).toISOString().substring(0,16)}\n`;});
    t+="\n/clearcensorlog";
    await tg.msg(chatId,t);break;
  }

  case "/clearcensorlog": await clearCensorLog(env);await tg.msg(chatId,"✅");break;

  default: if(cmd.startsWith("/"))await tg.msg(chatId,"❓ /help");
  }
}

// ──────────── CRON ────────────

async function processScheduled(env) {
  if (!env.BOT_KV || !env.TELEGRAM_BOT_TOKEN) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);
  const pendingList = await kvList(env, "pending:");

  for (const key of pendingList.keys) {
    const id = key.name.replace("pending:", "");

    try {
      const data = await kvGet(env, key.name, "json");
      if (!data) { await kvDel(env, key.name); continue; }

      if (Date.now() - data.submittedAt > 20 * 60 * 1000) {
        await kvDel(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `⏰ Таймаут: <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      console.log(`[CRON] ${id}: done=${check.done} proc=${check.processing} q=${check.queue_position}`);

      if (!check.done) continue;

      // ══ ГОТОВО ══
      console.log(`[CRON] ${id} DONE`);
      if (data.notifyChat) await tg.msg(data.notifyChat, `⚡ <code>${id}</code> готово!`);

      const result = await hordeStatus(id);
      console.log(`[CRON] faulted=${result.faulted} gens=${result.generations?.length}`);

      if (result.faulted) {
        await kvDel(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `❌ Faulted`);
        continue;
      }

      const gens = result.generations || [];
      if (!gens.length) {
        await kvDel(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `⚠️ Пусто`);
        continue;
      }

      let anySent = false;
      let anyCensored = false;

      for (const gen of gens) {
        const wName = gen.worker_name || "?";
        const wId = gen.worker_id || "";

        console.log(`[CRON] censored=${gen.censored} worker=${wName} img=${gen.img ? "len:" + gen.img.length : "null"}`);

        // Debug
        if (data.debug && data.notifyChat) {
          await tg.msg(data.notifyChat,
            `🔍 Censored:${gen.censored?"🔴":"✅"}\n` +
            `Worker:<code>${wName}</code>\n` +
            `Model:<code>${gen.model||"?"}</code>\n` +
            `Seed:${gen.seed||"?"}\n` +
            `Img: ${gen.img ? (gen.img.startsWith("http") ? "URL" : "base64 len:" + gen.img.length) : "null"}`
          );
        }

        if (gen.censored) {
          anyCensored = true;
          await logCensor(env, wId, wName);
          if (data.notifyChat) {
            await tg.msg(data.notifyChat, `🚫 <code>${wName}</code> зацензурил. Попытка ${(data.retryCount||0)+1}/${MAX_RETRIES}`);
          }
          continue;
        }

        if (!gen.img) {
          if (data.notifyChat) await tg.msg(data.notifyChat, `⚠️ img=null`);
          continue;
        }

        // ── ОТПРАВЛЯЕМ ──
        if (data.notifyChat) await tg.msg(data.notifyChat, `📨 Отправляю... (${gen.img.startsWith("http") ? "URL" : "base64 " + gen.img.length + " chars"})`);

        const caption = data.prompt ? `🎨 <i>${data.prompt.substring(0, 150)}</i>` : "";
        const sent = await deliverImage(tg, data.chatId, gen.img, caption, data.notifyChat);
        if (sent) anySent = true;
      }

      await kvDel(env, key.name);

      // Retry
      if (anyCensored && !anySent) {
        const rc = (data.retryCount || 0) + 1;
        if (rc < MAX_RETRIES) {
          try {
            const nr = await hordeSubmit(data.prompt, config, env);
            if (nr.id) {
              await kvPut(env, `pending:${nr.id}`, JSON.stringify({
                ...data, submittedAt: Date.now(), retryCount: rc,
              }), { expirationTtl: 3600 });
              if (data.notifyChat) await tg.msg(data.notifyChat, `🔄 Retry ${rc}/${MAX_RETRIES}: <code>${nr.id}</code>`);
            }
          } catch (e) { console.error("[CRON] retry:", e.message); }
        } else {
          if (data.notifyChat) await tg.msg(data.notifyChat, `❌ ${MAX_RETRIES}× цензура!\n/checkkey /listmodels /censorlog`);
        }
      }

      if (anySent && data.notifyChat && data.notifyChat !== data.chatId) {
        await tg.msg(data.notifyChat, "✅ Отправлено!");
      }

    } catch (e) { console.error(`[CRON] ${id}:`, e.message); }
  }

  // Auto
  if (!config.enabled || !config.chatId || !config.generalPrompt) return;
  const curr = await kvList(env, "pending:");
  if (curr.keys.length > 0) return;
  const lastPost = parseInt((await kvGet(env, "last_post_time")) || "0");
  const now = Date.now();
  if (now - lastPost < config.interval * 60 * 1000) return;

  await kvPut(env, "last_post_time", String(now));
  for (let i = 0; i < config.count; i++) {
    try {
      const prompt = await makePrompt(config.generalPrompt, env);
      const result = await hordeSubmit(prompt, config, env);
      if (result.id) {
        await kvPut(env, `pending:${result.id}`, JSON.stringify({
          chatId: config.chatId, prompt, submittedAt: now, notifyChat: null, retryCount: 0,
        }), { expirationTtl: 3600 });
      }
    } catch (e) { console.error("[CRON]", e.message); }
  }
}

// ──────────── ENTRY ────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("POST", { status: 405 });
      let upd;
      try { upd = await request.json(); } catch { return new Response("Bad", { status: 400 }); }
      if (upd.message?.text) {
        try { await handleCommand(upd.message, env); }
        catch (e) {
          console.error("[WH]", e.message, e.stack);
          try { new Telegram(env.TELEGRAM_BOT_TOKEN).msg(upd.message.chat.id, `💥 <code>${e.message}</code>`); } catch {}
        }
      }
      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TOKEN!", { status: 500 });
      const wh = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: wh, allowed_updates: ["message"], drop_pending_updates: true }),
      });
      const res = await r.json();
      return new Response(`Webhook: ${wh}\n${JSON.stringify(res, null, 2)}\n\nKV:${env.BOT_KV?"OK":"MISSING"} Horde:${getApiKey(env)==="0000000000"?"ANON!":"OK"} OR:${env.OPENROUTER_API_KEY?"OK":"no"}\n\nr2: false (base64 mode)`, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ kv:!!env.BOT_KV, tg:!!env.TELEGRAM_BOT_TOKEN, horde:getApiKey(env)!=="0000000000", or:!!env.OPENROUTER_API_KEY, r2:false }));
    }

    return new Response("Bot v7 (base64). /setup /health");
  },

  async scheduled(event, env, ctx) {
    try { await processScheduled(env); } catch (e) { console.error("[CRON]", e.message, e.stack); }
  },
};