// ============================================================
//  Telegram Image Bot v9
//  Fix: IGNORE censored flag, detect by SIZE only
//  Fix: /testsfw keeps nsfw:true censor_nsfw:false
//  Fix: always attempt delivery, never skip on flag
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
const HH = { "Client-Agent": "TgImageBot:9.0:tg" };
const MAX_RETRIES = 3;
const MIN_IMG_BYTES = 20000;

// ──────────── TELEGRAM ────────────

class TG {
  constructor(token) { this.api = `https://api.telegram.org/bot${token}`; }

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

  async sendPhotoBuf(chatId, buf, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([buf], { type: "image/png" }), "photo.png");
    if (caption) {
      form.append("caption", caption.substring(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const r = await fetch(`${this.api}/sendPhoto`, { method: "POST", body: form });
    const res = await r.json();
    if (!res.ok) console.error("[TG] sendBuf:", JSON.stringify(res));
    return res;
  }
}

// ──────────── KV ────────────

async function kvGet(env, k, t = "text") { if (!env.BOT_KV) return null; try { return await env.BOT_KV.get(k, t); } catch { return null; } }
async function kvPut(env, k, v, o = {}) { if (!env.BOT_KV) throw new Error("KV!"); await env.BOT_KV.put(k, v, o); }
async function kvDel(env, k) { if (env.BOT_KV) await env.BOT_KV.delete(k); }
async function kvList(env, p) { if (!env.BOT_KV) return { keys: [] }; return env.BOT_KV.list({ prefix: p }); }
async function getConfig(env) { const s = await kvGet(env, "config", "json"); return { ...DEFAULT_CONFIG, ...(s || {}) }; }
async function saveConfig(env, c) { await kvPut(env, "config", JSON.stringify(c)); }

// ──────────── HORDE ────────────

function apiKey(env) { return (env.HORDE_API_KEY || "").trim() || "0000000000"; }

async function checkKey(env) {
  const k = apiKey(env);
  try {
    const r = await fetch(`${HORDE}/find_user`, { headers: { apikey: k, ...HH } });
    if (r.status === 401 || r.status === 403) return { valid: false, anon: k === "0000000000" };
    const d = await r.json();
    return { valid: true, anon: k === "0000000000", username: d.username, kudos: d.kudos, trusted: d.trusted, flagged: d.flagged };
  } catch (e) { return { valid: false, anon: k === "0000000000", error: e.message }; }
}

async function hordeSubmit(prompt, config, env, skipLoras = false) {
  const key = apiKey(env);

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

  if (!skipLoras && config.loras?.length > 0) {
    params.loras = config.loras.map(l => ({
      name: String(l.name), model: l.strength ?? 1,
      clip: l.clip ?? 1, inject_trigger: "any", is_version: true,
    }));
  }

  // ВСЕГДА nsfw:true censor_nsfw:false — никогда не просим цензурить
  const body = {
    prompt: config.negativePrompt ? `${prompt} ### ${config.negativePrompt}` : prompt,
    params,
    nsfw: true,
    censor_nsfw: false,
    trusted_workers: true,
    models: [config.model],
    r2: false,
    replacement_filter: false,
    shared: false,
    slow_workers: false,
    allow_downgrade: true,
    dry_run: false,
  };

  console.log("[H] key:", key === "0000000000" ? "ANON" : key.substring(0, 8));
  console.log("[H]", JSON.stringify(body).substring(0, 600));

  const resp = await fetch(`${HORDE}/generate/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, ...HH },
    body: JSON.stringify(body),
  });
  const result = await resp.json();
  console.log("[H] resp:", JSON.stringify(result).substring(0, 300));
  return result;
}

async function hordeCheck(id) { return (await fetch(`${HORDE}/generate/check/${id}`, { headers: HH })).json(); }
async function hordeStatus(id) { return (await fetch(`${HORDE}/generate/status/${id}`, { headers: HH })).json(); }
async function hordeModels() { return (await fetch(`${HORDE}/status/models?type=image`, { headers: HH })).json(); }

// ──────────── IMAGE ────────────

function b64toBuf(b64) {
  const clean = b64.replace(/^data:image\/\w+;base64,/, "");
  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

async function deliver(tg, chatId, imgData, caption, notify) {
  if (!imgData) {
    if (notify) await tg.msg(notify, "❌ img=null");
    return { ok: false, tooSmall: false };
  }

  try {
    let buf;

    if (imgData.startsWith("http")) {
      const resp = await fetch(imgData);
      if (!resp.ok) {
        if (notify) await tg.msg(notify, `❌ HTTP ${resp.status}`);
        return { ok: false, tooSmall: false };
      }
      buf = await resp.arrayBuffer();
    } else {
      buf = b64toBuf(imgData);
    }

    const kb = Math.round(buf.byteLength / 1024);
    console.log("[D] bytes:", buf.byteLength, "=", kb, "KB");

    if (buf.byteLength < MIN_IMG_BYTES) {
      console.warn("[D] TOO SMALL — likely censored placeholder");
      if (notify) await tg.msg(notify, `🚫 Картинка ${kb}KB — заглушка. Нормальная >20KB`);
      return { ok: false, tooSmall: true };
    }

    const res = await tg.sendPhotoBuf(chatId, buf, caption);
    if (res.ok) {
      console.log("[D] ✅ sent", kb, "KB");
      return { ok: true, tooSmall: false };
    }

    if (notify) await tg.msg(notify, `❌ TG: ${res.description}`);
    return { ok: false, tooSmall: false };

  } catch (e) {
    console.error("[D]", e.message);
    if (notify) await tg.msg(notify, `❌ ${e.message}`);
    return { ok: false, tooSmall: false };
  }
}

// ──────────── PROMPTS ────────────

const VA=["from above","low angle","eye level","dutch angle","bird's eye","close-up","wide shot","portrait","three-quarter","profile","from behind","over shoulder"];
const VL=["golden hour","blue twilight","chiaroscuro","soft overcast","neon glow","moonlit","rim lighting","dappled light","harsh shadows","candlelit","god rays","backlit"];
const VS=["photorealistic","concept art","oil painting","watercolor","anime","dark fantasy","hyperrealistic","noir","surrealist","pop art","renaissance","vaporwave"];
const VM=["serene","dramatic","mysterious","vibrant","ethereal","dark","intimate","epic","melancholic","playful","suspenseful","romantic"];
const VD=["intricate details","rough textures","smooth finish","baroque","clean lines","aged patina","sharp focus","bokeh","particles","reflections"];
function pick(a){return a[Math.floor(Math.random()*a.length)];}
function tplPrompt(base){return[base,pick(VA),pick(VL),pick(VS),pick(VM),pick(VD),pick(VD),"masterpiece","best quality","highly detailed"].join(", ");}

async function llmPrompt(instr,key,model){
  const dirs=["unusual perspective","dramatic lighting","unexpected environment","intricate textures","bold colors","dynamic motion","atmospheric","extreme framing","cinematic","weather effects","reflections","futuristic"];
  try{
    const r=await fetch("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`,"HTTP-Referer":"https://t.me","X-Title":"ImgBot"},
      body:JSON.stringify({model:model||"meta-llama/llama-3.1-8b-instruct:free",messages:[
        {role:"system",content:`Stable Diffusion prompt engineer. ONLY comma-separated phrases. No quotes/markdown. Under 100 words. Direction: ${pick(dirs)}`},
        {role:"user",content:`Unique image prompt for: ${instr}`}
      ],temperature:1.3,max_tokens:200}),
    });
    const d=await r.json();
    if(d.choices?.[0]?.message?.content){let p=d.choices[0].message.content.trim().replace(/^["'`*]+|["'`*]+$/g,"");if(p.length>10)return p;}
  }catch(e){console.error("[LLM]",e.message);}
  return tplPrompt(instr);
}

async function makePrompt(instr,env){
  if(env.OPENROUTER_API_KEY){const c=await getConfig(env);return llmPrompt(instr,env.OPENROUTER_API_KEY,c.llmModel||env.LLM_MODEL||"meta-llama/llama-3.1-8b-instruct:free");}
  return tplPrompt(instr);
}

// ──────────── LOG ────────────

async function getCLog(env){return(await kvGet(env,"clog","json"))||[];}
async function addCLog(env,wName,reason){
  const l=await getCLog(env);l.push({n:wName,r:reason,t:Date.now()});
  while(l.length>50)l.shift();await kvPut(env,"clog",JSON.stringify(l));
}
async function clearCLog(env){await kvPut(env,"clog","[]");}

// ──────────── COMMANDS ────────────

async function handleCommand(msg,env){
  const chatId=msg.chat.id,userId=msg.from?.id,text=msg.text||"";
  if(!env.TELEGRAM_BOT_TOKEN)return;
  const tg=new TG(env.TELEGRAM_BOT_TOKEN);
  const parts=text.split(/\s+/),cmd=parts[0].split("@")[0].toLowerCase(),args=parts.slice(1);

  // ── Без KV ──

  if(cmd==="/ping"){
    const k=apiKey(env);
    await tg.msg(chatId,`🏓 v9\nChat:<code>${chatId}</code> User:<code>${userId}</code>\nKV:${env.BOT_KV?"✅":"❌"} Horde:${k==="0000000000"?"❌":"✅"} OR:${env.OPENROUTER_API_KEY?"✅":"⚠️"}`);
    return;
  }

  if(cmd==="/diagnostic"){
    const k=apiKey(env);
    await tg.msg(chatId,`🔧 <b>v9</b>\nKV:${env.BOT_KV?"✅":"❌"} HORDE:${k==="0000000000"?"❌ANON":"✅"+k.substring(0,8)+"..."} OR:${env.OPENROUTER_API_KEY?"✅":"⚠️"}\nMode: r2=false, always nsfw:true censor_nsfw:false\nDetect censorship by size only (>${MIN_IMG_BYTES}b)`+(k==="0000000000"?"\n\n🔴 https://stablehorde.net/register":""));
    return;
  }

  if(cmd==="/checkkey"){
    await tg.msg(chatId,"🔑...");
    const i=await checkKey(env);
    if(!i.valid){await tg.msg(chatId,`❌ ${i.error||""}\nhttps://stablehorde.net/register`);}
    else{await tg.msg(chatId,`${i.anon?"🔴 АНОНИМНЫЙ":"✅"} <b>${i.username}</b>\nKudos:${i.kudos} Trusted:${i.trusted} Flagged:${i.flagged}\n${i.anon?"🔴 NSFW всегда чёрный без ключа!":i.flagged?"⚠️ Flagged":"✅ OK"}`);}
    return;
  }

  if(cmd==="/testimg"){
    await tg.msg(chatId,"🧪 URL...");
    const r1=await tg.sendPhotoUrl(chatId,"https://picsum.photos/512/512","URL ✅");
    await tg.msg(chatId,r1.ok?"✅ URL. Buffer...":"❌ URL. Buffer...");
    try{const resp=await fetch("https://picsum.photos/256/256");const buf=await resp.arrayBuffer();
      const r2=await tg.sendPhotoBuf(chatId,buf,"Buffer ✅");
      await tg.msg(chatId,r2.ok?"✅ Оба работают":"❌ "+r2.description);
    }catch(e){await tg.msg(chatId,`❌ ${e.message}`);}
    return;
  }

  // ── /testsfw — SFW пейзаж, те же настройки nsfw ──
  if(cmd==="/testsfw"){
    if(!env.BOT_KV){await tg.msg(chatId,"❌ KV!");return;}
    const config=await getConfig(env);
    await tg.msg(chatId,`🧪 <b>SFW тест</b>\nГенерирую пейзаж (nsfw:true, censor_nsfw:false)\nМодель: ${config.model}\n\nЕсли пейзаж нормальный → проблема в NSFW\nЕсли чёрный → проблема в модели/воркере`);

    const sfwPrompt="beautiful mountain landscape, lake reflection, sunset sky, pine trees, snow peaks, nature photography, national geographic, masterpiece, best quality, highly detailed, 4k, sharp";

    try{
      const result=await hordeSubmit(sfwPrompt,config,env,true); // skipLoras=true для чистого теста
      if(result.id){
        await kvPut(env,`pending:${result.id}`,JSON.stringify({
          chatId,prompt:sfwPrompt,submittedAt:Date.now(),notifyChat:chatId,debug:true,retryCount:99,sfwTest:true
        }),{expirationTtl:3600});
        await tg.msg(chatId,`📤 <code>${result.id}</code>`);
      }else{await tg.msg(chatId,`❌ ${JSON.stringify(result).substring(0,500)}`);}
    }catch(e){await tg.msg(chatId,`❌ ${e.message}`);}
    return;
  }

  // ── KV ──
  if(!env.BOT_KV){await tg.msg(chatId,"❌ KV!");return;}
  let config=await getConfig(env);
  if(!config.adminId){config.adminId=userId;await saveConfig(env,config);await tg.msg(chatId,`👑 <code>${userId}</code>`);}
  if(config.adminId!==userId){await tg.msg(chatId,`🔒 ${config.adminId}`);return;}

  switch(cmd){

  case "/start":case "/help":
    await tg.msg(chatId,`🤖 <b>v9</b>\n\n/ping /diagnostic /checkkey\n/testimg /testsfw /debuggen\n\n/setchat /setprompt /setinterval /setcount\n/setmodel /listmodels\n/searchlora /addlora /removelora /listloras\n/setsize /setsteps /setcfg /setsampler\n/setneg /nsfw /setclipskip /setllm /hiresfix /karras\n/enable /disable /generate\n/status /pending /cancel\n/censorlog /clearcensorlog /resetadmin`);
    break;

  case "/resetadmin":config.adminId=userId;await saveConfig(env,config);await tg.msg(chatId,"✅");break;
  case "/setchat":config.chatId=chatId;await saveConfig(env,config);await tg.msg(chatId,`✅ <code>${chatId}</code>`);break;

  case "/setprompt":{const p=args.join(" ");if(!p){await tg.msg(chatId,"❌");break;}config.generalPrompt=p;await saveConfig(env,config);await tg.msg(chatId,`✅ <code>${p}</code>`);break;}
  case "/setinterval":{const m=parseInt(args[0]);if(isNaN(m)||m<1){await tg.msg(chatId,"❌");break;}config.interval=m;await saveConfig(env,config);await tg.msg(chatId,`✅ ${m}м`);break;}
  case "/setcount":{const n=parseInt(args[0]);if(isNaN(n)||n<1||n>10){await tg.msg(chatId,"❌ 1-10");break;}config.count=n;await saveConfig(env,config);await tg.msg(chatId,`✅ ${n}`);break;}
  case "/setmodel":{const nm=args.join(" ");if(!nm){await tg.msg(chatId,"❌ /listmodels");break;}config.model=nm;await saveConfig(env,config);await tg.msg(chatId,`✅ <code>${nm}</code>`);break;}

  case "/listmodels":{
    await tg.msg(chatId,"⏳...");
    const models=await hordeModels();
    const top=models.filter(m=>m.count>0).sort((a,b)=>b.count-a.count).slice(0,30);
    let t="📋\n\n";
    top.forEach(m=>{t+=`${(m.name.includes("XL")||m.name.includes("Pony"))?"🟢":"⚪"} <code>${m.name}</code> (${m.count})\n`;});
    await tg.msg(chatId,t+"\n/setmodel имя");break;
  }

  case "/searchlora":{
    const q=args.join(" ");if(!q){await tg.msg(chatId,"❌");break;}
    await tg.msg(chatId,"🔍...");
    const r=await fetch(`https://civitai.com/api/v1/models?types=LORA&query=${encodeURIComponent(q)}&limit=8&sort=Highest%20Rated&nsfw=true`);
    const d=await r.json();if(!d.items?.length){await tg.msg(chatId,"😕");break;}
    let t="";d.items.forEach(i=>{const v=i.modelVersions?.[0];t+=`${i.nsfw?"🔞":"✅"} <b>${i.name}</b> [${v?.baseModel||"?"}]\n<code>/addlora ${v?.id||"?"} 0.8</code>\n\n`;});
    await tg.msg(chatId,t);break;
  }

  case "/addlora":{const id=args[0],str=parseFloat(args[1])||0.8,cl=parseFloat(args[2])||1;if(!id){await tg.msg(chatId,"❌");break;}config.loras=(config.loras||[]).filter(l=>String(l.name)!==String(id));config.loras.push({name:id,strength:str,clip:cl});await saveConfig(env,config);await tg.msg(chatId,`✅ ${id}`);break;}
  case "/removelora":if(!args[0]){await tg.msg(chatId,"❌");break;}config.loras=(config.loras||[]).filter(l=>String(l.name)!==String(args[0]));await saveConfig(env,config);await tg.msg(chatId,"✅");break;
  case "/listloras":{const ll=config.loras||[];if(!ll.length){await tg.msg(chatId,"Нет");break;}let t="";ll.forEach(l=>{t+=`• <code>${l.name}</code> (${l.strength}/${l.clip}) /removelora ${l.name}\n`;});await tg.msg(chatId,t);break;}

  case "/setsize":{const w=parseInt(args[0]),h=parseInt(args[1]);if(isNaN(w)||isNaN(h)||w<256||h<256||w>2048||h>2048){await tg.msg(chatId,"<code>/setsize 704 1024</code>");break;}config.width=Math.round(w/64)*64;config.height=Math.round(h/64)*64;await saveConfig(env,config);await tg.msg(chatId,`✅ ${config.width}×${config.height}`);break;}
  case "/setsteps":{const s=parseInt(args[0]);if(isNaN(s)||s<1||s>50){await tg.msg(chatId,"❌");break;}config.steps=s;await saveConfig(env,config);await tg.msg(chatId,`✅ ${s}`);break;}
  case "/setcfg":{const c=parseFloat(args[0]);if(isNaN(c)||c<1||c>30){await tg.msg(chatId,"❌");break;}config.cfgScale=c;await saveConfig(env,config);await tg.msg(chatId,`✅ ${c}`);break;}
  case "/setsampler":{const sl=["k_euler","k_euler_a","k_lms","k_heun","k_dpm_2","k_dpm_2_a","k_dpmpp_2s_a","k_dpmpp_2m","k_dpmpp_sde","DDIM"];if(!args[0]||!sl.includes(args[0])){await tg.msg(chatId,sl.map(s=>`<code>${s}</code>`).join("\n"));break;}config.sampler=args[0];await saveConfig(env,config);await tg.msg(chatId,`✅`);break;}
  case "/setneg":config.negativePrompt=args.join(" ")||DEFAULT_CONFIG.negativePrompt;await saveConfig(env,config);await tg.msg(chatId,"✅");break;
  case "/nsfw":if(args[0]!=="on"&&args[0]!=="off"){await tg.msg(chatId,"/nsfw on|off");break;}config.nsfw=args[0]==="on";await saveConfig(env,config);await tg.msg(chatId,`✅ ${config.nsfw?"🔞":"OFF"}`);break;
  case "/setclipskip":{const cs=parseInt(args[0]);if(isNaN(cs)||cs<1||cs>4){await tg.msg(chatId,"❌");break;}config.clipSkip=cs;await saveConfig(env,config);await tg.msg(chatId,`✅ ${cs}`);break;}
  case "/setllm":{const l=args.join(" ");if(!l){await tg.msg(chatId,`<code>meta-llama/llama-3.1-8b-instruct:free</code>`);break;}config.llmModel=l;await saveConfig(env,config);await tg.msg(chatId,"✅");break;}
  case "/hiresfix":if(args[0]!=="on"&&args[0]!=="off"){await tg.msg(chatId,"/hiresfix on|off");break;}config.hiresFix=args[0]==="on";if(args[1])config.hiresFixDenoising=parseFloat(args[1])||0.65;await saveConfig(env,config);await tg.msg(chatId,"✅");break;
  case "/karras":if(args[0]!=="on"&&args[0]!=="off"){await tg.msg(chatId,"/karras on|off");break;}config.karras=args[0]==="on";await saveConfig(env,config);await tg.msg(chatId,"✅");break;

  case "/enable":if(!config.chatId){await tg.msg(chatId,"❌ /setchat");break;}if(!config.generalPrompt){await tg.msg(chatId,"❌ /setprompt");break;}config.enabled=true;await saveConfig(env,config);await tg.msg(chatId,`🟢 ${config.interval}м×${config.count}`);break;
  case "/disable":config.enabled=false;await saveConfig(env,config);await tg.msg(chatId,"🔴");break;

  case "/status":{
    const k=apiKey(env),pend=await kvList(env,"pending:"),cl=await getCLog(env);
    const loras=(config.loras||[]).map(l=>`  •${l.name}(${l.strength})`).join("\n")||"  нет";
    await tg.msg(chatId,`📊 <b>v9</b> ${config.enabled?"🟢":"🔴"}\nChat:<code>${config.chatId||"—"}</code> ${config.interval}м×${config.count}\n\n<code>${config.generalPrompt||"—"}</code>\n\n<code>${config.model}</code>\n${config.width}×${config.height} S:${config.steps} CFG:${config.cfgScale}\n${config.sampler} CLIP:${config.clipSkip}\nNSFW:${config.nsfw?"🔞":"❌"} Horde:${k==="0000000000"?"❌":"✅"}\n\nLoRA:\n${loras}\n\nLLM:<code>${config.llmModel||"auto"}</code>\nCensor:${cl.length} Queue:${pend.keys.length}`);
    break;
  }

  case "/debuggen":{
    await tg.msg(chatId,`🧪 Model:${config.model}`);
    const prompt="beautiful woman, elegant dress, studio photo, soft lighting, masterpiece, best quality";
    try{
      const result=await hordeSubmit(prompt,config,env);
      if(result.id){
        await kvPut(env,`pending:${result.id}`,JSON.stringify({chatId,prompt,submittedAt:Date.now(),notifyChat:chatId,debug:true,retryCount:0}),{expirationTtl:3600});
        await tg.msg(chatId,`📤 <code>${result.id}</code>`+(result.message?`\n⚠️ ${result.message}`:""));
      }else{await tg.msg(chatId,`❌ ${JSON.stringify(result).substring(0,500)}`);}
    }catch(e){await tg.msg(chatId,`❌ ${e.message}`);}
    break;
  }

  case "/generate":{
    if(!config.generalPrompt){await tg.msg(chatId,"❌ /setprompt");break;}
    const target=config.chatId||chatId;
    await tg.msg(chatId,`⏳ ${config.count}...`);
    for(let i=0;i<config.count;i++){
      try{
        const prompt=await makePrompt(config.generalPrompt,env);
        await tg.msg(chatId,`🎨 #${i+1}: <code>${prompt.substring(0,200)}</code>`);
        const result=await hordeSubmit(prompt,config,env);
        if(result.id){
          await kvPut(env,`pending:${result.id}`,JSON.stringify({chatId:target,prompt,submittedAt:Date.now(),notifyChat:chatId,retryCount:0}),{expirationTtl:3600});
          await tg.msg(chatId,`📤 <code>${result.id}</code>`);
        }else{await tg.msg(chatId,`❌ ${JSON.stringify(result).substring(0,300)}`);}
      }catch(e){await tg.msg(chatId,`❌ ${e.message}`);}
    }
    break;
  }

  case "/pending":{
    const list=await kvList(env,"pending:");if(!list.keys.length){await tg.msg(chatId,"📋 Пусто");break;}
    let t=`📋 ${list.keys.length}:\n\n`;
    for(const kk of list.keys.slice(0,10)){const idd=kk.name.replace("pending:","");try{const ch=await hordeCheck(idd);t+=`• <code>${idd}</code> ${ch.done?"✅":ch.processing?"⚙️":`⏳#${ch.queue_position}`} ~${ch.wait_time}с\n`;}catch{t+=`• <code>${idd}</code> ?\n`;}}
    await tg.msg(chatId,t);break;
  }

  case "/cancel":{const list=await kvList(env,"pending:");for(const kk of list.keys)await kvDel(env,kk.name);await tg.msg(chatId,`🗑 ${list.keys.length}`);break;}

  case "/censorlog":{
    const log=await getCLog(env);if(!log.length){await tg.msg(chatId,"📋 Пусто");break;}
    let t=`🚫 ${log.length}:\n`;log.slice(-10).forEach(w=>{t+=`• <code>${w.n}</code> [${w.r}] ${new Date(w.t).toISOString().substring(0,16)}\n`;});
    t+="\n/clearcensorlog";await tg.msg(chatId,t);break;
  }

  case "/clearcensorlog":await clearCLog(env);await tg.msg(chatId,"✅");break;

  default:if(cmd.startsWith("/"))await tg.msg(chatId,"❓ /help");
  }
}

// ──────────── CRON ────────────

async function processScheduled(env) {
  if (!env.BOT_KV || !env.TELEGRAM_BOT_TOKEN) return;
  const tg = new TG(env.TELEGRAM_BOT_TOKEN);
  const config = await getConfig(env);
  const pendingList = await kvList(env, "pending:");

  for (const key of pendingList.keys) {
    const id = key.name.replace("pending:", "");
    try {
      const data = await kvGet(env, key.name, "json");
      if (!data) { await kvDel(env, key.name); continue; }
      if (Date.now() - data.submittedAt > 20 * 60 * 1000) {
        await kvDel(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, `⏰ <code>${id}</code>`);
        continue;
      }

      const check = await hordeCheck(id);
      console.log(`[C] ${id}: done=${check.done} q=${check.queue_position}`);
      if (!check.done) continue;

      // ══ DONE ══
      if (data.notifyChat) await tg.msg(data.notifyChat, `⚡ <code>${id}</code> готово!`);
      const result = await hordeStatus(id);

      if (result.faulted) {
        await kvDel(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, "❌ Faulted");
        continue;
      }

      const gens = result.generations || [];
      if (!gens.length) {
        await kvDel(env, key.name);
        if (data.notifyChat) await tg.msg(data.notifyChat, "⚠️ 0 gens");
        continue;
      }

      let anySent = false;
      let anySmall = false;

      for (const gen of gens) {
        const wName = gen.worker_name || "?";

        // Debug info
        if (data.debug && data.notifyChat) {
          const imgInfo = gen.img
            ? (gen.img.startsWith("http") ? "URL" : `b64:${gen.img.length}ch≈${Math.round(gen.img.length*3/4/1024)}KB`)
            : "null";
          await tg.msg(data.notifyChat,
            `🔍 flag:${gen.censored?"🔴":"✅"} worker:<code>${wName}</code> model:<code>${gen.model||"?"}</code> img:${imgInfo}`
          );
        }

        // ИГНОРИРУЕМ gen.censored флаг — пробуем отправить ВСЕГДА
        if (!gen.img) {
          if (data.notifyChat) await tg.msg(data.notifyChat, "⚠️ img=null");
          continue;
        }

        if (data.notifyChat) await tg.msg(data.notifyChat, "📨 Отправляю...");

        const caption = data.prompt ? `🎨 <i>${data.prompt.substring(0, 150)}</i>` : "";
        const { ok, tooSmall } = await deliver(tg, data.chatId, gen.img, caption, data.notifyChat);

        if (ok) {
          anySent = true;
        } else if (tooSmall) {
          anySmall = true;
          await addCLog(env, wName, "small");
        }
      }

      await kvDel(env, key.name);

      // Retry only for small images (censored), not for sfwTest
      if (anySmall && !anySent && !data.sfwTest) {
        const rc = (data.retryCount || 0) + 1;
        if (rc < MAX_RETRIES) {
          try {
            const nr = await hordeSubmit(data.prompt, config, env);
            if (nr.id) {
              await kvPut(env, `pending:${nr.id}`, JSON.stringify({
                ...data, submittedAt: Date.now(), retryCount: rc
              }), { expirationTtl: 3600 });
              if (data.notifyChat) await tg.msg(data.notifyChat, `🔄 Retry ${rc}/${MAX_RETRIES}: <code>${nr.id}</code>`);
            }
          } catch (e) { console.error("[C] retry:", e.message); }
        } else {
          if (data.notifyChat) await tg.msg(data.notifyChat,
            `❌ ${MAX_RETRIES}× маленькие картинки!\n\n/testsfw — проверь модель\n/checkkey — проверь ключ\n/setmodel — смени модель\n/censorlog`
          );
        }
      }

      if (anySent && data.notifyChat && data.notifyChat !== data.chatId) {
        await tg.msg(data.notifyChat, "✅!");
      }

    } catch (e) { console.error(`[C] ${id}:`, e.message); }
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
      if (result.id) await kvPut(env, `pending:${result.id}`, JSON.stringify({
        chatId: config.chatId, prompt, submittedAt: now, notifyChat: null, retryCount: 0
      }), { expirationTtl: 3600 });
    } catch (e) { console.error("[C]", e.message); }
  }
}

// ──────────── ENTRY ────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("POST", { status: 405 });
      let upd; try { upd = await request.json(); } catch { return new Response("Bad", { status: 400 }); }
      if (upd.message?.text) {
        try { await handleCommand(upd.message, env); }
        catch (e) { console.error("[W]", e.message); try { new TG(env.TELEGRAM_BOT_TOKEN).msg(upd.message.chat.id, `💥 <code>${e.message}</code>`); } catch {} }
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
      return new Response(`${wh}\n${JSON.stringify(res, null, 2)}\nKV:${env.BOT_KV ? "OK" : "!"} Horde:${apiKey(env) === "0000000000" ? "ANON!" : "OK"}`, { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/health") return new Response(JSON.stringify({ kv: !!env.BOT_KV, tg: !!env.TELEGRAM_BOT_TOKEN, horde: apiKey(env) !== "0000000000", or: !!env.OPENROUTER_API_KEY }));
    return new Response("v9 /setup /health");
  },

  async scheduled(event, env, ctx) {
    try { await processScheduled(env); } catch (e) { console.error("[C]", e.message, e.stack); }
  },
};