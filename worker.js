const DEFAULT_CONFIG = {
    enabled: false,
    groupId: null,
    channelId: null,
    adminId: null,
    interval: 60,
    count: "1",
    generalPrompt: "",
    systemContext: "",
    maxTokens: 800,
    model: "AlbedoBase XL (SDXL)",
    loras: [],
    width: 1024,
    height: 1024,
    steps: 25,
    cfgScale: 2,
    sampler: "k_dpmpp_2m",
    nsfw: true,
    negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
    llmModel: "openrouter/free",
    clipSkip: 2,
    hiresFix: false,
    hiresFixDenoising: 0.65,
    karras: true,
    postProcessors: [],
    captionMode: 1,
    captionPrompt: "РћРїРёС€Рё СЌС‚Сѓ РєР°СЂС‚РёРЅРєСѓ РґР»СЏ РїРѕСЃС‚Р° РІ Telegram-РєР°РЅР°Р»Рµ РЅР° СЂСѓСЃСЃРєРѕРј СЏР·С‹РєРµ, РєСЂРµР°С‚РёРІРЅРѕ Рё СЃ СЌРјРѕРґР·Рё. Р‘РµР· Р»РёС€РЅРёС… РІСЃС‚СѓРїР»РµРЅРёР№.",
    useSpoiler: false,
    ratingEnabled: false,
    ratingType: "buttons",
    watermarkData: null,
    watermarkPosition: "random"
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:16.2:tg" };
const MIN_IMAGE_KB = 10;

function escapeHtml(text) {
    return text == null ? "" : String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isHttpUrl(text) {
    return typeof text === "string" && /^https?:\/\//i.test(text);
}

function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToBuffer(b64) {
    try {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr.buffer;
    } catch { return null; }
}

function getActualCount(countConfig) {
    const str = String(countConfig);
    if (str.startsWith("random")) {
        const match = str.match(/random\s+(\d+)\s*-\s*(\d+)/);
        if (match) {
            const min = parseInt(match[1]);
            const max = parseInt(match[2]);
            if (!isNaN(min) && !isNaN(max) && min <= max) {
                return Math.floor(Math.random() * (max - min + 1)) + min;
            }
        }
    }
    return parseInt(str) || 1;
}

class Telegram {
    constructor(token) {
        this.base = `https://api.telegram.org/bot${token}`;
    }
    async api(method, body) {
        const res = await fetch(`${this.base}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.ok) console.error(`[TG] ${method}:`, JSON.stringify(data).substring(0, 400));
        return data;
    }
    send(chatId, text, extra = {}) {
        return this.api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
    }
    async sendPhoto(chatId, buffer, caption = "", extra = {}) {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("photo", new Blob([buffer], { type: "image/webp" }), "image.webp");
        if (caption) {
            form.append("caption", caption.substring(0, 1024));
            form.append("parse_mode", "HTML");
        }
        if (extra.hasSpoiler) form.append("has_spoiler", "true");
        if (extra.replyMarkup) form.append("reply_markup", JSON.stringify(extra.replyMarkup));
        return (await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form })).json();
    }
    async sendMediaGroup(chatId, buffers, caption = "") {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        const media = [];
        buffers.forEach((buf, i) => {
            const filename = `photo${i}.webp`;
            form.append(filename, new Blob([buf], { type: "image/webp" }), filename);
            const item = { type: "photo", media: `attach://${filename}` };
            if (i === 0 && caption) {
                item.caption = caption.substring(0, 1024);
                item.parse_mode = "HTML";
            }
            media.push(item);
        });
        form.append("media", JSON.stringify(media));
        return (await fetch(`${this.base}/sendMediaGroup`, { method: "POST", body: form })).json();
    }
    async sendDocument(chatId, buffer, caption = "", extra = {}) {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("document", new Blob([buffer], { type: "image/webp" }), "image.webp");
        if (caption) {
            form.append("caption", caption.substring(0, 1024));
            form.append("parse_mode", "HTML");
        }
        if (extra.replyMarkup) form.append("reply_markup", JSON.stringify(extra.replyMarkup));
        return (await fetch(`${this.base}/sendDocument`, { method: "POST", body: form })).json();
    }
    sendPhotoUrl(chatId, url, caption = "", extra = {}) {
        const payload = { chat_id: chatId, photo: url, caption: caption.substring(0, 1024), parse_mode: "HTML" };
        if (extra.hasSpoiler) payload.has_spoiler = true;
        if (extra.replyMarkup) payload.reply_markup = extra.replyMarkup;
        return this.api("sendPhoto", payload);
    }
}

const KV = {
    async call(env, ...args) {
        if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
        const base = env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "");
        const res = await fetch(base, {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
            body: JSON.stringify(args)
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data.result;
    },
    async get(env, key, type = "text") {
        const res = await this.call(env, "GET", key);
        if (res === null || res === undefined) return null;
        try { return type === "json" ? JSON.parse(res) : res; } catch { return res; }
    },
    async put(env, key, value, opts = {}) {
        const val = typeof value === "string" ? value : JSON.stringify(value);
        const args = ["SET", key, val];
        if (opts.expirationTtl) args.push("EX", opts.expirationTtl);
        await this.call(env, ...args);
    },
    async del(env, key) {
        await this.call(env, "DEL", key);
    },
    async list(env, prefix) {
        const keys = await this.call(env, "KEYS", `${prefix}*`) || [];
        return { keys: keys.map(k => ({ name: k })) };
    }
};

async function getConfig(env) {
    const data = await KV.get(env, "config", "json");
    return { ...DEFAULT_CONFIG, ...(data || {}) };
}

async function saveConfig(env, config) {
    await KV.put(env, "config", JSON.stringify(config));
}

async function getWorkerBlacklist(env) {
    return await KV.get(env, "worker_blacklist", "json") || [];
}

async function addWorkerToBlacklist(env, id, name) {
    if (!id || id === "?" || String(id).length < 10) return;
    const list = await getWorkerBlacklist(env);
    if (!list.find(w => w.id === id)) {
        list.push({ id, name: name || "?", t: Date.now() });
        if (list.length > 50) list.shift();
        await KV.put(env, "worker_blacklist", JSON.stringify(list));
    }
}

async function clearWorkerBlacklist(env) {
    await KV.put(env, "worker_blacklist", "[]");
}

function isCensored(gen) {
    return !!(gen && (gen.gen_metadata?.some(m => m.type === "censorship") || gen.censored === true || gen.state === "censored"));
}

function getApiKey(env) {
    return (env.HORDE_API_KEY || "").trim() || "0000000000";
}

async function hordeCheckKey(env) {
    const key = getApiKey(env);
    try {
        const res = await fetch(`${HORDE_API}/find_user`, { headers: { apikey: key, ...HORDE_HEADERS } });
        if (res.status === 401 || res.status === 403) return { ok: false, anon: key === "0000000000" };
        const data = await res.json();
        return { ok: true, anon: key === "0000000000", user: data.username, kudos: data.kudos, trusted: data.trusted, flagged: data.flagged };
    } catch (e) {
        return { ok: false, anon: key === "0000000000", err: e.message };
    }
}

function getRandomPromptSegment(generalPrompt) {
    if (!generalPrompt) return "";
    const segments = generalPrompt.split(';').map(s => s.trim()).filter(Boolean);
    if (segments.length === 0) return generalPrompt;
    return segments[Math.floor(Math.random() * segments.length)];
}

async function callOpenRouter(env, model, messages, maxTokens = 8000, retries = 2) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                    "HTTP-Referer": "https://t.me",
                    "X-Title": "TgImageBot"
                },
                body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: maxTokens })
            });

            if (!res.ok) {
                const errBody = await res.text();
                lastErr = `HTTP ${res.status}: ${errBody.substring(0, 200)}`;
                console.error(`[LLM] Attempt ${attempt + 1} failed:`, lastErr);
                if (res.status === 429 || res.status >= 500) {
                    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                    continue;
                }
                break;
            }

            const data = await res.json();
            if (data.error) {
                lastErr = data.error.message || JSON.stringify(data.error);
                console.error(`[LLM] API error:`, lastErr);
                continue;
            }

            const text = data.choices?.[0]?.message?.content?.trim();
            if (text && text.length > 3) return text;

            lastErr = "Empty response from model";
        } catch (e) {
            lastErr = e.message;
            console.error(`[LLM] Attempt ${attempt + 1} exception:`, e.message);
            if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        }
    }
    console.error("[LLM] All attempts failed:", lastErr);
    return null;
}

async function determineResolution(prompt, env, config) {
    const presets = [[1024, 1024], [832, 1216], [1216, 832], [768, 1344]];
    if (!env.OPENROUTER_API_KEY) {
        const r = presets[Math.floor(Math.random() * presets.length)];
        return { width: r[0], height: r[1] };
    }
    try {
        const sysPrompt = "You are an AI choosing aspect ratios. Read the prompt and output ONLY one of these exact strings based on what visually fits best: '1024x1024' (Square), '832x1216' (Portrait/Characters), '1216x832' (Landscape/Scenery), or '768x1344' (Cinematic/Tall). NO explanations, NO markdown.";
        const result = await callOpenRouter(env, config.llmModel || "openrouter/free", [
            { role: "system", content: sysPrompt },
            { role: "user", content: `Prompt: ${prompt}` }
        ], 50);

        if (result) {
            const clean = result.replace(/['"`]/g, '').trim().toLowerCase();
            if (clean.includes("1024x1024")) return { width: 1024, height: 1024 };
            if (clean.includes("832x1216")) return { width: 832, height: 1216 };
            if (clean.includes("1216x832")) return { width: 1216, height: 832 };
            if (clean.includes("768x1344")) return { width: 768, height: 1344 };
        }
    } catch (e) { console.error("[LLM Resolution error]", e); }

    const r = presets[Math.floor(Math.random() * presets.length)];
    return { width: r[0], height: r[1] };
}

async function generatePrompt(basePrompt, env, config) {
    if (!env.OPENROUTER_API_KEY) return basePrompt;
    const llmModel = config.llmModel || "openrouter/free";
    let sysPrompt, userPrompt;
    const match = basePrompt.match(/\[([\s\S]*?)\]/);

    const baseContext = config.systemContext || "You are a Stable Diffusion prompt engineer. Output ONLY the final prompt as comma-separated tags. IMPORTANT: Keep the prompt highly detailed but strictly UNDER 800 characters to prevent truncation by the Horde API. NEVER cut off mid-sentence.";

    if (match) {
        const instruction = match[1];
        const cleanPrompt = basePrompt.replace(match[0], "").trim();
        sysPrompt = `${baseContext} Include all elements requested.`;
        userPrompt = `Base prompt: ${cleanPrompt}\nInstruction: ${instruction}`;
    } else {
        sysPrompt = `${baseContext} Expand the theme deeply.`;
        userPrompt = `Create a highly detailed image generation prompt based on this theme: ${basePrompt}`;
    }

    const maxTokens = config.maxTokens || 800;

    const result = await callOpenRouter(env, llmModel, [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt }
    ], maxTokens);

    if (result) return result.replace(/^["'`*\n]+|["'`*\n]+$/g, "").trim();

    if (match) {
        console.error("[LLM] OpenRouter API failed to process prompt instruction.");
        throw new Error("РќРµ СѓРґР°Р»РѕСЃСЊ РѕР±СЂР°Р±РѕС‚Р°С‚СЊ РёРЅСЃС‚СЂСѓРєС†РёСЋ РґР»СЏ РїСЂРѕРјРїС‚Р° С‡РµСЂРµР· OpenRouter. РџРѕРІС‚РѕСЂРёС‚Рµ РїРѕР·Р¶Рµ.");
    }
    return basePrompt;
}

async function generateAiCaption(imagePrompt, env, config) {
    if (!env.OPENROUTER_API_KEY) return `рџЋЁ <i>${escapeHtml(imagePrompt.substring(0, 300))}</i>`;
    const result = await callOpenRouter(env, config.llmModel || "openrouter/free", [
        { role: "system", content: config.captionPrompt || "РћРїРёС€Рё РєР°СЂС‚РёРЅРєСѓ РґР»СЏ Telegram-РєР°РЅР°Р»Р°. РџРёС€Рё РёРЅС‚РµСЂРµСЃРЅРѕ, РёСЃРїРѕР»СЊР·СѓР№ СЌРјРѕРґР·Рё. Р‘РµР· РІСЃС‚СѓРїР»РµРЅРёР№." },
        { role: "user", content: `РџСЂРѕРјРїС‚ РєР°СЂС‚РёРЅРєРё: ${imagePrompt.substring(0, 1000)}` }
    ], 8000);

    if (!result || result.trim().length === 0 || result.includes("HTTP ")) {
        return `рџЋЁ <i>${escapeHtml(imagePrompt.substring(0, 300))}</i>`;
    }
    return result;
}

async function hordeSubmit(prompt, config, env, extra = {}) {
    const key = getApiKey(env);
    const params = {
        sampler_name: config.sampler,
        cfg_scale: config.cfgScale,
        width: extra.width || config.width,
        height: extra.height || config.height,
        steps: config.steps,
        karras: config.karras !== false,
        clip_skip: config.clipSkip || 2,
        n: 1
    };

    if (config.hiresFix) {
        params.hires_fix = true;
        params.hires_fix_denoising_strength = config.hiresFixDenoising || 0.65;
    }

    if (config.postProcessors?.length > 0) {
        params.post_processing = config.postProcessors;
    }

    if (!extra.skipLoras && config.loras?.length > 0) {
        params.loras = config.loras.map(l => ({
            name: String(l.name),
            model: parseFloat(l.strength) || 1,
            clip: parseFloat(l.clip) || 1
        }));
    }

    const payload = {
        prompt: config.negativePrompt ? `${prompt} ### ${config.negativePrompt}` : prompt,
        params,
        nsfw: config.nsfw !== false,
        censor_nsfw: false,
        trusted_workers: false,
        replacement_filter: false,
        models: [config.model],
        r2: true,
        shared: false,
        allow_downgrade: true
    };

    if (extra.workerBlacklist?.length > 0) {
        payload.workers = extra.workerBlacklist;
        payload.worker_blacklist = true;
    }

    const res = await fetch(`${HORDE_API}/generate/async`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key, ...HORDE_HEADERS },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errText = await res.text();
        console.error("[Horde Submit Error]", res.status, errText.substring(0, 300));
        return { error: errText, status: res.status };
    }

    return res.json();
}

async function hordeCheck(id) {
    return (await fetch(`${HORDE_API}/generate/check/${id}`, { headers: HORDE_HEADERS })).json();
}

async function hordeGetResult(id) {
    return (await fetch(`${HORDE_API}/generate/status/${id}`, { headers: HORDE_HEADERS })).json();
}

async function hordeGetModels() {
    return (await fetch(`${HORDE_API}/status/models?type=image`, { headers: HORDE_HEADERS })).json();
}

async function downloadImage(url) {
    try {
        const res = await fetch(url);
        return res.ok ? await res.arrayBuffer() : null;
    } catch { return null; }
}

async function getWatermarkedUrl(imgUrl, config, env) {
    if (!config.watermarkData || !isHttpUrl(imgUrl)) return imgUrl;

    const workerOrigin = await KV.get(env, "worker_origin");
    if (!workerOrigin) return imgUrl;

    const wmUrl = `${workerOrigin}/watermark.png`;
    let markpos = "southeast";

    if (config.watermarkPosition === "random") {
        const pos = ["northwest", "northeast", "southwest", "southeast", "center"];
        markpos = pos[Math.floor(Math.random() * pos.length)];
    } else if (config.watermarkPosition === "corner") {
        markpos = "southeast";
    } else {
        markpos = config.watermarkPosition || "southeast";
    }

    return `https://wsrv.nl/?url=${encodeURIComponent(imgUrl)}&mark=${encodeURIComponent(wmUrl)}&markpos=${markpos}&markpad=5&markalpha=90`;
}

async function deliverImage(tg, chatId, imgData, caption, notifyId, config, env) {
    if (!imgData) {
        if (notifyId) await tg.send(notifyId, "вќЊ РќРµС‚ РґР°РЅРЅС‹С… РєР°СЂС‚РёРЅРєРё РѕС‚ РІРѕСЂРєРµСЂР°");
        return { sent: false, tooSmall: false, sizeKB: 0 };
    }

    const isUrl = isHttpUrl(imgData);
    let targetUrl = imgData;

    if (isUrl) {
        targetUrl = await getWatermarkedUrl(imgData, config, env);
    }

    let buffer = null;
    const extra = { hasSpoiler: config.useSpoiler };

    if (config.ratingEnabled && config.ratingType === "buttons") {
        extra.replyMarkup = { inline_keyboard: [[{ text: "рџ‘Ќ 0", callback_data: "rate_up" }, { text: "рџ‘Ћ 0", callback_data: "rate_down" }]] };
    }

    if (isUrl) {
        buffer = await downloadImage(targetUrl);
        if (!buffer) {
            buffer = await downloadImage(imgData);
        }
        if (!buffer) {
            const r = await tg.sendPhotoUrl(chatId, imgData, caption, extra);
            return { sent: r.ok, tooSmall: false, sizeKB: 0, msgId: r.result?.message_id };
        }
    } else {
        buffer = base64ToBuffer(imgData);
        if (!buffer) return { sent: false, tooSmall: false, sizeKB: 0 };
    }

    const sizeKB = Math.round(buffer.byteLength / 1024);
    if (sizeKB < MIN_IMAGE_KB) {
        if (notifyId) await tg.send(notifyId, `рџљ« <b>РџРѕС…РѕР¶Рµ РЅР° Р·Р°РіР»СѓС€РєСѓ/С†РµРЅР·СѓСЂСѓ</b>\nР Р°Р·РјРµСЂ: ${sizeKB}KB`);
        return { sent: false, tooSmall: true, sizeKB };
    }

    let r = await tg.sendPhoto(chatId, buffer, caption, extra);
    if (r.ok) return { sent: true, tooSmall: false, sizeKB, msgId: r.result?.message_id };

    r = await tg.sendDocument(chatId, buffer, caption, extra);
    if (r.ok) return { sent: true, tooSmall: false, sizeKB, msgId: r.result?.message_id };

    if (isUrl) {
        r = await tg.sendPhotoUrl(chatId, imgData, caption, extra);
        if (r.ok) return { sent: true, tooSmall: false, sizeKB, msgId: r.result?.message_id };
    }

    if (notifyId) await tg.send(notifyId, `вќЊ РќРµ СѓРґР°Р»РѕСЃСЊ РѕС‚РїСЂР°РІРёС‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ: ${escapeHtml(r?.description || "unknown error")}`);
    return { sent: false, tooSmall: false, sizeKB };
}

async function handleCommand(msg, env) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || msg.caption || "";

    if (!env.TELEGRAM_BOT_TOKEN) return;
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);

    if (!text.startsWith("/")) return;

    const args = text.split(/\s+/);
    const cmd = args[0].split("@")[0].toLowerCase();
    const params = args.slice(1);

    if (cmd === "/ping") {
        const key = getApiKey(env);
        return await tg.send(chatId, `рџЏ“ <b>Pong!</b>\nрџ“Ќ Chat: <code>${chatId}</code>\nрџ’ѕ Redis: ${env.UPSTASH_REDIS_REST_URL ? "вњ…" : "вќЊ"}\nрџЋЁ Horde: ${key === "0000000000" ? "рџ”ґ anon" : "вњ… ok"}\nрџ¤– OpenRouter: ${env.OPENROUTER_API_KEY ? "вњ…" : "вќЊ"}`);
    }

    let config = await getConfig(env);
    if (!config.adminId) {
        config.adminId = userId;
        await saveConfig(env, config);
        await tg.send(chatId, `рџ‘‘ РўС‹ С‚РµРїРµСЂСЊ Р°РґРјРёРЅ. РўРІРѕР№ ID: <code>${userId}</code>`);
    }

    if (config.adminId !== userId) {
        return await tg.send(chatId, `рџ”’ Р”РѕСЃС‚СѓРї С‚РѕР»СЊРєРѕ РґР»СЏ Р°РґРјРёРЅР°.`);
    }

    switch (cmd) {
        case "/start":
        case "/help":
            await tg.send(chatId, `рџ¤– <b>Image Bot</b>\n\n<b>РџРѕСЃС‚РёРЅРі:</b>\n/setgroup | /setchannel &lt;@name&gt; | /ungroup | /unchannel\n/setinterval &lt;РјРёРЅ&gt; | /setcount &lt;1-10&gt; РёР»Рё &lt;random 1-5&gt; | /enable | /disable | /generate\n\n<b>РџСЂРѕРјРїС‚С‹:</b>\n/setprompt &lt;С‚РµРјР°1; С‚РµРјР°2&gt; | /setneg &lt;С‚РµРєСЃС‚&gt;\n/setcontext &lt;СЃРёСЃС‚РµРјРЅС‹Р№ РїСЂРѕРјРїС‚ LLM&gt; | /settokens &lt;Р»РёРјРёС‚&gt;\n\n<b>РџРѕРґРїРёСЃРё Рё РР:</b>\n/setcaptionmode &lt;0|1|2&gt; | /setcaptionprompt &lt;РёРЅСЃС‚СЂ&gt; | /setllm &lt;model&gt;\n\n<b>РџР°СЂР°РјРµС‚СЂС‹ Рё РњРѕРґРµР»Рё:</b>\n/setmodel &lt;РёРјСЏ&gt; | /listmodels | /searchmodel &lt;Р·Р°РїСЂРѕСЃ&gt;\n/addlora &lt;id&gt; [str] [clip] | /listloras | /clearloras\n/setenhancer &lt;FaceFix AnimeUpscale Рё С‚.Рґ. | clear&gt;\n/setsize &lt;W&gt; &lt;H&gt; | /setsteps &lt;N&gt; | /setcfg &lt;N&gt; | /setsampler &lt;name&gt;\n/setspoiler &lt;on|off&gt;\n/setwatermark &lt;random|corner&gt; (РџСЂРёРєСЂРµРїРёС‚Рµ С„Р°Р№Р» PNG)\n\n<b>РћС†РµРЅРєРё Рё РЎС‚Р°С‚РёСЃС‚РёРєР°:</b>\n/setratings &lt;on|off&gt; | /setratingtype &lt;button|emoji&gt; | /analytics\n\n<b>РЎС‚Р°С‚СѓСЃ:</b>\n/status | /pending | /cancel | /workerbl | /ping`);
            break;

        case "/setgroup":
            config.groupId = chatId; await saveConfig(env, config);
            await tg.send(chatId, `вњ… Р“СЂСѓРїРїР° СѓСЃС‚Р°РЅРѕРІР»РµРЅР°: <code>${chatId}</code>`);
            break;

        case "/setchannel":
            if (!params[0]) return await tg.send(chatId, "вќЊ /setchannel &lt;@username&gt; РёР»Рё ID");
            config.channelId = params[0]; await saveConfig(env, config);
            await tg.send(chatId, `вњ… РљР°РЅР°Р» СѓСЃС‚Р°РЅРѕРІР»РµРЅ: <code>${params[0]}</code>`);
            break;

        case "/ungroup":
            config.groupId = null; await saveConfig(env, config);
            await tg.send(chatId, "вњ… Р“СЂСѓРїРїР° РѕС‚РІСЏР·Р°РЅa");
            break;

        case "/unchannel":
            config.channelId = null; await saveConfig(env, config);
            await tg.send(chatId, "вњ… РљР°РЅР°Р» РѕС‚РІСЏР·Р°РЅ");
            break;

        case "/setprompt":
            if (!params.length) return await tg.send(chatId, "вќЊ /setprompt &lt;С‚РµРјР°1; С‚РµРјР°2&gt;");
            config.generalPrompt = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `вњ… РџСЂРѕРјРїС‚ СЃРѕС…СЂР°РЅРµРЅ. РўРµРјС‹ Р±СѓРґСѓС‚ РІС‹Р±РёСЂР°С‚СЊСЃСЏ СЃР»СѓС‡Р°Р№РЅРѕ, РµСЃР»Рё СЂР°Р·РґРµР»РµРЅС‹ ";"\n<code>${escapeHtml(config.generalPrompt)}</code>`);
            break;

        case "/setcontext":
            if (!params.length) {
                config.systemContext = "";
                await saveConfig(env, config);
                return await tg.send(chatId, "вњ… РЎРёСЃС‚РµРјРЅС‹Р№ РєРѕРЅС‚РµРєСЃС‚ СЃР±СЂРѕС€РµРЅ РЅР° РґРµС„РѕР»С‚РЅС‹Р№.");
            }
            config.systemContext = params.join(" ");
            await saveConfig(env, config);
            await tg.send(chatId, "вњ… РЎРёСЃС‚РµРјРЅС‹Р№ РєРѕРЅС‚РµРєСЃС‚ LLM РѕР±РЅРѕРІР»РµРЅ.");
            break;

        case "/settokens": {
            const t = parseInt(params[0]);
            if (t > 0 && t <= 8000) {
                config.maxTokens = t;
                await saveConfig(env, config);
                await tg.send(chatId, `вњ… Р›РёРјРёС‚ С‚РѕРєРµРЅРѕРІ РіРµРЅРµСЂР°С†РёРё РїСЂРѕРјРїС‚Р° СѓСЃС‚Р°РЅРѕРІР»РµРЅ: ${t}`);
            } else {
                await tg.send(chatId, "вќЊ /settokens <С‡РёСЃР»Рѕ РѕС‚ 1 РґРѕ 8000>");
            }
            break;
        }

        case "/setcaptionmode": {
            const mode = parseInt(params[0]);
            if (![0, 1, 2].includes(mode)) return await tg.send(chatId, "вќЊ /setcaptionmode &lt;0|1|2&gt;");
            config.captionMode = mode; await saveConfig(env, config);
            await tg.send(chatId, `вњ… Р РµР¶РёРј РїРѕРґРїРёСЃРё: ${mode}`);
            break;
        }

        case "/setcaptionprompt":
            if (!params.length) return await tg.send(chatId, "вќЊ /setcaptionprompt &lt;РёРЅСЃС‚СЂСѓРєС†РёСЏ&gt;");
            config.captionPrompt = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, "вњ… РРЅСЃС‚СЂСѓРєС†РёСЏ РґР»СЏ РїРѕРґРїРёСЃРµР№ РѕР±РЅРѕРІР»РµРЅР°");
            break;

        case "/setwatermark": {
            const doc = msg.document || msg.reply_to_message?.document;
            if (!doc) return await tg.send(chatId, "вќЊ РџСЂРёРєСЂРµРїРёС‚Рµ РїСЂРѕР·СЂР°С‡РЅС‹Р№ PNG С„Р°Р№Р» РєР°Рє РґРѕРєСѓРјРµРЅС‚ Рє РєРѕРјР°РЅРґРµ /setwatermark РёР»Рё РѕС‚РІРµС‚СЊС‚Рµ РЅР° РґРѕРєСѓРјРµРЅС‚.");
            if (doc.mime_type !== "image/png") return await tg.send(chatId, "вќЊ РўРѕР»СЊРєРѕ PNG С„Р°Р№Р»С‹ РїРѕРґРґРµСЂР¶РёРІР°СЋС‚СЃСЏ!");

            try {
                const fileReq = await tg.api("getFile", { file_id: doc.file_id });
                if (fileReq.ok) {
                    const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileReq.result.file_path}`;
                    const fileRes = await fetch(fileUrl);
                    const arrayBuffer = await fileRes.arrayBuffer();

                    config.watermarkData = bufferToBase64(arrayBuffer);
                    config.watermarkPosition = params[0] || "random";
                    await saveConfig(env, config);
                    await tg.send(chatId, `вњ… Р’РѕРґСЏРЅРѕР№ Р·РЅР°Рє СЃРѕС…СЂР°РЅРµРЅ Рё Р±СѓРґРµС‚ СЃРєР»РµРёРІР°С‚СЊСЃСЏ СЃ РєР°СЂС‚РёРЅРєР°РјРё Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё! РџРѕР·РёС†РёСЏ: ${config.watermarkPosition}`);
                } else {
                    await tg.send(chatId, `вќЊ РћС€РёР±РєР° API Telegram: ${fileReq.description}`);
                }
            } catch (e) { await tg.send(chatId, `вќЊ РћС€РёР±РєР°: ${e.message}`); }
            break;
        }

        case "/setenhancer": {
            if (!params.length) return await tg.send(chatId, "вќЊ /setenhancer <FaceFix|Upscale|AnimeUpscale|CodeFormers|clear>");
            if (params[0].toLowerCase() === "clear") {
                config.postProcessors = [];
                await tg.send(chatId, "вњ… РЈР»СѓС‡С€Р°Р№Р·РµСЂС‹ СЃР±СЂРѕС€РµРЅС‹");
            } else {
                const map = {
                    facefix: "GFPGAN",
                    upscale: "RealESRGAN_x4plus",
                    animeupscale: "RealESRGAN_x4plus_anime_6B",
                    codeformers: "CodeFormers"
                };
                const argsClean = params.join(" ").split(/[\s,]+/);
                const newPps = [];
                for (const arg of argsClean) {
                    if (!arg) continue;
                    const key = arg.toLowerCase();
                    if (map[key]) newPps.push(map[key]);
                    else newPps.push(arg);
                }
                config.postProcessors = [...new Set(newPps)];
                await tg.send(chatId, `вњ… РЈР»СѓС‡С€Р°Р№Р·РµСЂС‹: ${config.postProcessors.join(", ")}`);
            }
            await saveConfig(env, config);
            break;
        }

        case "/setmodel":
            if (!params.length) return await tg.send(chatId, "вќЊ /setmodel &lt;РёРјСЏ&gt;");
            config.model = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `вњ… РњРѕРґРµР»СЊ: <code>${escapeHtml(config.model)}</code>`);
            break;

        case "/listmodels":
            await tg.send(chatId, "вЏі Р—Р°РіСЂСѓР¶Р°СЋ С‚РѕРї-40 РјРѕРґРµР»РµР№...");
            try {
                const models = (await hordeGetModels() || []).filter(m => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 40);
                let txt = "рџ“‹ <b>РњРѕРґРµР»Рё (С‚РѕРї-40):</b>\n\n";
                models.forEach(m => txt += `${m.name?.includes("XL") ? "рџџў" : "вљЄ"} <code>${escapeHtml(m.name)}</code> (${m.count}w)\n`);
                await tg.send(chatId, txt);
            } catch (e) { await tg.send(chatId, `вќЊ РћС€РёР±РєР°: ${e.message}`); }
            break;

        case "/searchmodel": {
            const qm = params.join(" ").toLowerCase();
            if (!qm) return await tg.send(chatId, "вќЊ /searchmodel &lt;Р·Р°РїСЂРѕСЃ&gt;");
            try {
                const models = (await hordeGetModels() || []).filter(m => m.name.toLowerCase().includes(qm)).sort((a, b) => b.count - a.count).slice(0, 20);
                if (!models.length) return await tg.send(chatId, "рџ• РќРёС‡РµРіРѕ РЅРµ РЅР°Р№РґРµРЅРѕ");
                let txt = `рџ”Ќ <b>РќР°Р№РґРµРЅРѕ (${models.length}):</b>\n\n`;
                models.forEach(m => txt += `<code>${escapeHtml(m.name)}</code> (${m.count}w)\n`);
                await tg.send(chatId, txt);
            } catch (e) { await tg.send(chatId, `вќЊ РћС€РёР±РєР°: ${e.message}`); }
            break;
        }

        case "/addlora": {
            if (!params.length) return await tg.send(chatId, "вќЊ /addlora &lt;ID&gt; [strength=1] [clip=1]");
            const loraId = params[0];
            const loraStr = parseFloat(params[1]) || 1;
            const loraClip = parseFloat(params[2]) || 1;
            if (!config.loras) config.loras = [];
            if (config.loras.find(l => String(l.name) === String(loraId))) {
                return await tg.send(chatId, `вљ пёЏ LoRA <code>${loraId}</code> СѓР¶Рµ РІ СЃРїРёСЃРєРµ`);
            }
            let compatMsg = "";
            let loraTitle = loraId;
            try {
                const civRes = await fetch(`https://civitai.com/api/v1/models/${loraId}`);
                if (civRes.ok) {
                    const civData = await civRes.json();
                    const base = civData.modelVersions?.[0]?.baseModel || "";
                    loraTitle = civData.name || loraId;
                    const isXL = config.model?.toLowerCase().includes("xl");
                    const loraIsXL = base.toLowerCase().includes("xl");
                    if (base) compatMsg = `\nрџ“¦ <b>${escapeHtml(loraTitle)}</b> [${base}]`;
                    if (isXL !== loraIsXL) compatMsg += `\nвљ пёЏ <b>Р’РЅРёРјР°РЅРёРµ:</b> LoRA РѕР±СѓС‡РµРЅР° РЅР° <b>${base}</b>. РЎРєРѕСЂРµРµ РІСЃРµРіРѕ РЅРµ РїСЂРёРјРµРЅРёС‚СЃСЏ!`;
                    else compatMsg += `\nвњ… РЎРѕРІРјРµСЃС‚РёРјР° СЃ С‚РµРєСѓС‰РµР№ РјРѕРґРµР»СЊСЋ`;
                }
            } catch (_) {}
            config.loras.push({ name: loraId, title: loraTitle, strength: loraStr, clip: loraClip });
            await saveConfig(env, config);
            await tg.send(chatId, `вњ… LoRA <code>${loraId}</code> РґРѕР±Р°РІР»РµРЅР° (str: ${loraStr}, clip: ${loraClip})${compatMsg}`);
            break;
        }

        case "/listloras":
            if (!config.loras?.length) return await tg.send(chatId, "рџ“‹ РЎРїРёСЃРѕРє LoRA РїСѓСЃС‚.");
            let lt = "рџ“‹ <b>РђРєС‚РёРІРЅС‹Рµ LoRA:</b>\n\n";
            config.loras.forEach((l, i) => {
                const nameStr = l.title && l.title !== l.name ? `${escapeHtml(l.title)} (ID: ${l.name})` : l.name;
                lt += `${i + 1}. <b>${nameStr}</b> (str: ${l.strength}, clip: ${l.clip})\n`;
            });
            await tg.send(chatId, lt);
            break;

        case "/clearloras":
            config.loras = []; await saveConfig(env, config);
            await tg.send(chatId, "вњ… РЎРїРёСЃРѕРє LoRA РѕС‡РёС‰РµРЅ");
            break;

        case "/setsampler":
            if (!params[0]) return await tg.send(chatId, "вќЊ /setsampler &lt;РёРјСЏ&gt;");
            config.sampler = params[0]; await saveConfig(env, config);
            await tg.send(chatId, `вњ… Sampler: ${config.sampler}`);
            break;

        case "/setcfg":
            if (!params[0]) return await tg.send(chatId, "вќЊ /setcfg &lt;С‡РёСЃР»Рѕ&gt;");
            config.cfgScale = parseFloat(params[0]); await saveConfig(env, config);
            await tg.send(chatId, `вњ… CFG: ${config.cfgScale}`);
            break;

        case "/setsteps":
            if (!params[0]) return await tg.send(chatId, "вќЊ /setsteps &lt;С‡РёСЃР»Рѕ&gt;");
            config.steps = parseInt(params[0]); await saveConfig(env, config);
            await tg.send(chatId, `вњ… Steps: ${config.steps}`);
            break;

        case "/setneg":
            if (!params.length) return await tg.send(chatId, "вќЊ /setneg &lt;С‚РµРєСЃС‚&gt;");
            config.negativePrompt = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, "вњ… РќРµРіР°С‚РёРІРЅС‹Р№ РїСЂРѕРјРїС‚ СЃРѕС…СЂР°РЅС‘РЅ");
            break;

        case "/setllm":
            if (!params.length) return await tg.send(chatId, "вќЊ /setllm &lt;РјРѕРґРµР»СЊ&gt;");
            config.llmModel = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `вњ… LLM: <code>${config.llmModel}</code>`);
            break;

        case "/setspoiler":
            if (!params[0]) return await tg.send(chatId, "вќЊ /setspoiler <on|off>");
            config.useSpoiler = params[0].toLowerCase() === "on";
            await saveConfig(env, config);
            await tg.send(chatId, `вњ… РЎРїРѕР№Р»РµСЂ: ${config.useSpoiler ? "Р’РљР›" : "Р’Р«РљР›"}`);
            break;

        case "/setratings":
            if (!params[0]) return await tg.send(chatId, "вќЊ /setratings <on|off>");
            config.ratingEnabled = params[0].toLowerCase() === "on";
            await saveConfig(env, config);
            await tg.send(chatId, `вњ… Р РµР№С‚РёРЅРіРё: ${config.ratingEnabled ? "Р’РљР›" : "Р’Р«РљР›"}`);
            break;

        case "/setratingtype":
            if (!params[0] || !["button", "emoji"].includes(params[0].toLowerCase())) return await tg.send(chatId, "вќЊ /setratingtype <button|emoji>");
            config.ratingType = params[0].toLowerCase() === "button" ? "buttons" : "reactions";
            await saveConfig(env, config);
            await tg.send(chatId, `вњ… РўРёРї СЂРµР№С‚РёРЅРіР°: ${config.ratingType}`);
            break;

        case "/analytics": {
            const histList = await KV.list(env, "hist:");
            if (!histList.keys.length) return await tg.send(chatId, "рџ“Љ РќРµС‚ РґР°РЅРЅС‹С… РґР»СЏ Р°РЅР°Р»РёС‚РёРєРё.");

            const entries = [];
            for (const k of histList.keys) {
                const data = await KV.get(env, k.name, "json");
                if (data) entries.push(data);
            }
            entries.sort((a, b) => b.time - a.time);
            const recent = entries.slice(0, 15);

            let text = "рџ“Љ <b>РџРѕСЃР»РµРґРЅРёРµ РіРµРЅРµСЂР°С†РёРё:</b>\n\n";
            for (const e of recent) {
                const scoreData = await KV.get(env, `score:${e.chatId}:${e.msgId}`, "json") || { up: 0, down: 0 };
                const net = scoreData.up - scoreData.down;
                const link = `t.me/c/${String(e.chatId).replace("-100", "")}/${e.msgId}`;
                text += `рџ”— <a href="${link}">Post</a> | в­ђпёЏ Score: ${net > 0 ? "+"+net : net} (рџ‘Ќ${scoreData.up}/рџ‘Ћ${scoreData.down})\n`;
            }
            await tg.send(chatId, text, { disable_web_page_preview: true });
            break;
        }

        case "/setinterval": {
            const inv = parseInt(params[0]);
            if (inv > 0) { config.interval = inv; await saveConfig(env, config); await tg.send(chatId, `вњ… РРЅС‚РµСЂРІР°Р»: ${inv} РјРёРЅ`); }
            else await tg.send(chatId, "вќЊ /setinterval &lt;РјРёРЅСѓС‚С‹&gt;");
            break;
        }

        case "/setcount": {
            const val = params.join(" ").toLowerCase();
            if (val.startsWith("random")) {
                const match = val.match(/random\s+(\d+)\s*-\s*(\d+)/);
                if (match) {
                    const min = parseInt(match[1]);
                    const max = parseInt(match[2]);
                    if (min > 0 && max <= 10 && min <= max) {
                        config.count = `random ${min}-${max}`;
                        await saveConfig(env, config);
                        await tg.send(chatId, `вњ… РљРѕР»РёС‡РµСЃС‚РІРѕ РІ Р±Р°С‚С‡Рµ: СЃР»СѓС‡Р°Р№РЅРѕРµ РѕС‚ ${min} РґРѕ ${max}`);
                        break;
                    }
                }
            }
            const cnt = parseInt(params[0]);
            if (cnt > 0 && cnt <= 10) {
                config.count = cnt.toString();
                await saveConfig(env, config);
                await tg.send(chatId, `вњ… РљРѕР»РёС‡РµСЃС‚РІРѕ РІ Р±Р°С‚С‡Рµ: ${cnt}`);
            } else {
                await tg.send(chatId, "вќЊ /setcount <1-10> РёР»Рё /setcount random <min>-<max> (РЅР°РїСЂРёРјРµСЂ: random 1-5)");
            }
            break;
        }

        case "/setsize": {
            const w = parseInt(params[0]); const h = parseInt(params[1]);
            if (w > 255 && h > 255) {
                config.width = 64 * Math.round(w / 64);
                config.height = 64 * Math.round(h / 64);
                await saveConfig(env, config);
                await tg.send(chatId, `вњ… Р‘Р°Р·РѕРІС‹Р№ СЂР°Р·РјРµСЂ: ${config.width}x${config.height} (AI РјРѕР¶РµС‚ РїРµСЂРµРѕРїСЂРµРґРµР»СЏС‚СЊ)`);
            } else await tg.send(chatId, "вќЊ /setsize &lt;W&gt; &lt;H&gt;");
            break;
        }

        case "/enable":
            if (!config.groupId && !config.channelId) return await tg.send(chatId, "вќЊ РЎРЅР°С‡Р°Р»Р° РїСЂРёРІСЏР¶Рё РіСЂСѓРїРїСѓ (/setgroup) РёР»Рё РєР°РЅР°Р» (/setchannel)");
            if (!config.generalPrompt) return await tg.send(chatId, "вќЊ РЎРЅР°С‡Р°Р»Р° Р·Р°РґР°Р№ РїСЂРѕРјРїС‚ (/setprompt)");
            config.enabled = true; await saveConfig(env, config);
            await tg.send(chatId, "рџџў РђРІС‚РѕРїРѕСЃС‚РёРЅРі РІРєР»СЋС‡С‘РЅ!");
            break;

        case "/disable":
            config.enabled = false; await saveConfig(env, config);
            await tg.send(chatId, "рџ”ґ РђРІС‚РѕРїРѕСЃС‚РёРЅРі РІС‹РєР»СЋС‡РµРЅ");
            break;

        case "/generate":
            if (!config.generalPrompt) return await tg.send(chatId, "вќЊ РЎРЅР°С‡Р°Р»Р° Р·Р°РґР°Р№ РїСЂРѕРјРїС‚ (/setprompt)");

            const actualCount = getActualCount(config.count);
            await tg.send(chatId, `вЏі Р“РµРЅРµСЂРёСЂСѓСЋ ${actualCount} С„РѕС‚Рѕ... (РћР±СЂР°Р±РѕС‚РєР° Batch)`);

            {
                const bl = (await getWorkerBlacklist(env)).map(w => w.id).filter(Boolean);
                const batchId = Date.now() + "_" + Math.random().toString(36).substring(2,7);
                const targets = [chatId];

                await KV.put(env, `batch:${batchId}`, { expected: actualCount, ready: [], targets, notify: chatId, prompt: "" }, { expirationTtl: 3600 });

                const segment = getRandomPromptSegment(config.generalPrompt);

                for (let i = 0; i < actualCount; i++) {
                    try {
                        const finalPrompt = await generatePrompt(segment, env, config);
                        const bestRes = await determineResolution(finalPrompt, env, config);

                        await tg.send(chatId, `рџЋЁ #${i + 1}:\n<code>${escapeHtml(finalPrompt.substring(0, 300))}</code>\nрџ“Џ Р РµР·РѕР»СЋС†РёСЏ: ${bestRes.width}x${bestRes.height}`);

                        const res = await hordeSubmit(finalPrompt, config, env, { workerBlacklist: bl, width: bestRes.width, height: bestRes.height });
                        if (res.id) {
                            await KV.put(env, `pending:${res.id}`, { targets, prompt: finalPrompt, at: Date.now(), notify: chatId, retries: 0, batchId }, { expirationTtl: 3600 });
                        } else {
                            await tg.send(chatId, `вќЊ Horde: ${escapeHtml(JSON.stringify(res))}`);
                            let batch = await KV.get(env, `batch:${batchId}`, "json");
                            if (batch) { batch.expected--; await KV.put(env, `batch:${batchId}`, batch, { expirationTtl: 3600 }); }
                        }
                    } catch (e) {
                        await tg.send(chatId, `вќЊ РћС€РёР±РєР°: ${e.message}`);
                        let batch = await KV.get(env, `batch:${batchId}`, "json");
                        if (batch) { batch.expected--; await KV.put(env, `batch:${batchId}`, batch, { expirationTtl: 3600 }); }
                    }
                }
            }
            break;

        case "/status": {
            let queueCount = 0;
            try { queueCount = (await KV.list(env, "pending:")).keys.length; } catch {}
            const pps = config.postProcessors?.length ? config.postProcessors.join(", ") : "РЅРµС‚";
            await tg.send(chatId, `рџ“Љ <b>РЎС‚Р°С‚СѓСЃ</b>\n\n<b>РђРІС‚РѕРїРѕСЃС‚:</b> ${config.enabled ? "рџџў" : "рџ”ґ"}\n<b>Р“СЂСѓРїРїР°:</b> ${config.groupId || "вќЊ"}\n<b>РљР°РЅР°Р»:</b> ${config.channelId || "вќЊ"}\n<b>Р‘Р°С‚С‡:</b> ${config.count} С€С‚\n<b>Р’РѕС‚РµСЂРјР°СЂРєР°:</b> ${config.watermarkData ? "рџџў" : "рџ”ґ"}\n<b>РЈР»СѓС‡С€Р°Р№Р·РµСЂС‹:</b> ${pps}\n<b>Р РµР¶РёРј РїРѕРґРїРёСЃРё:</b> ${config.captionMode}\n<b>РЎРїРѕР№Р»РµСЂ:</b> ${config.useSpoiler ? "рџџў" : "рџ”ґ"}\n<b>Р РµР№С‚РёРЅРіРё:</b> ${config.ratingEnabled ? "рџџў" : "рџ”ґ"} (${config.ratingType})\n\n<b>РџСЂРѕРјРїС‚:</b>\n<code>${escapeHtml(config.generalPrompt)}</code>\n\n<b>РљРѕРЅС‚РµРєСЃС‚ LLM:</b> ${config.systemContext ? "Р—Р°РґР°РЅ" : "Р”РµС„РѕР»С‚"}\n<b>РўРѕРєРµРЅС‹:</b> ${config.maxTokens}\n\n<b>РќРµРіР°С‚РёРІРЅС‹Р№ РїСЂРѕРјРїС‚:</b>\n<code>${escapeHtml(config.negativePrompt)}</code>\n\n<b>РњРѕРґРµР»СЊ:</b> <code>${escapeHtml(config.model)}</code>\n<b>РЎР°РјРїР»РµСЂ:</b> <code>${escapeHtml(config.sampler)}</code>\n<b>Р‘Р°Р·.Р Р°Р·РјРµСЂ:</b> ${config.width}x${config.height}\n<b>Steps:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}\n<b>LoRA:</b> ${config.loras?.length || 0} С€С‚\n<b>LLM:</b> <code>${escapeHtml(config.llmModel)}</code>\n<b>РћС‡РµСЂРµРґСЊ:</b> ${queueCount}`);
            break;
        }

        case "/pending":
            try {
                const pendList = await KV.list(env, "pending:");
                if (!pendList.keys.length) {
                    return await tg.send(chatId, `вЏі Р’ РѕС‡РµСЂРµРґРё: 0 РіРµРЅРµСЂР°С†РёР№`);
                }

                await tg.send(chatId, `вЏі <b>Р’ РѕС‡РµСЂРµРґРё: ${pendList.keys.length} РіРµРЅРµСЂР°С†РёР№</b>\nРџСЂРѕРІРµСЂСЏСЋ СЃС‚Р°С‚СѓСЃ СЃРµСЂРІРµСЂРѕРІ...`);

                let count = 0;
                let statusTxt = "";
                for (const k of pendList.keys) {
                    if (count >= 5) {
                        statusTxt += `\n<i>...Рё РµС‰Рµ ${pendList.keys.length - 5}</i>`;
                        break;
                    }
                    const id = k.name.replace("pending:", "");
                    const checkData = await hordeCheck(id);

                    let status = "РћР¶РёРґР°РЅРёРµ";
                    let waitTime = checkData.wait_time ? Math.round(checkData.wait_time) : "?";
                    let qPos = checkData.queue_position !== undefined ? checkData.queue_position : "?";

                    if (checkData.done) {
                        status = "вњ… Р“РѕС‚РѕРІРѕ (Р—Р°Р±РёСЂР°СЋ)";
                        waitTime = 0;
                        qPos = 0;
                    } else if (checkData.faulted || checkData.message) {
                        status = "вќЊ РћС€РёР±РєР°/РЈРґР°Р»РµРЅРѕ";
                    }

                    statusTxt += `рџ”№ ID: <code>${id.substring(0,8)}...</code> | ${status}: ~${waitTime} СЃРµРє | РџРµСЂРµРґ РІР°РјРё: ${qPos}\n`;
                    count++;
                }
                await tg.send(chatId, `рџ“Љ <b>РЎС‚Р°С‚СѓСЃ РѕС‡РµСЂРµРґРё:</b>\n\n${statusTxt}`);
            } catch (e) { await tg.send(chatId, `вќЊ РћС€РёР±РєР°: ${e.message}`); }
            break;

        case "/cancel":
            try {
                const plist = await KV.list(env, "pending:");
                let canceled = 0;
                for (const k of plist.keys) { await KV.del(env, k.name); canceled++; }
                const blist = await KV.list(env, "batch:");
                for (const b of blist.keys) { await KV.del(env, b.name); }
                await tg.send(chatId, `вњ… РћС‡РµСЂРµРґСЊ РѕС‡РёС‰РµРЅР°. РЈРґР°Р»РµРЅРѕ Р·Р°РґР°С‡: ${canceled}`);
            } catch (e) { await tg.send(chatId, `вќЊ РћС€РёР±РєР°: ${e.message}`); }
            break;

        case "/workerbl":
            await clearWorkerBlacklist(env);
            await tg.send(chatId, "вњ… Р‘Р»СЌРєР»РёСЃС‚ РІРѕСЂРєРµСЂРѕРІ РѕС‡РёС‰РµРЅ");
            break;

        default:
            if (cmd.startsWith("/")) await tg.send(chatId, "вќ“ РќРµРёР·РІРµСЃС‚РЅР°СЏ РєРѕРјР°РЅРґР°. Р’РІРµРґРё /help");
    }
}

async function handleCallback(cb, env) {
    if (!cb.data.startsWith("rate_")) return;
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    const msgId = cb.message.message_id;
    const chatId = cb.message.chat.id;
    const userId = cb.from.id;
    const rateKey = `usr_rate:${msgId}:${userId}`;

    const hasRated = await KV.get(env, rateKey);
    if (hasRated) {
        await tg.api("answerCallbackQuery", { callback_query_id: cb.id, text: "Р’С‹ СѓР¶Рµ РїСЂРѕРіРѕР»РѕСЃРѕРІР°Р»Рё!" });
        return;
    }

    await KV.put(env, rateKey, "1", { expirationTtl: 14 * 24 * 3600 });
    const isUp = cb.data === "rate_up";
    const scoreKey = `score:${chatId}:${msgId}`;
    let currentScore = await KV.get(env, scoreKey, "json") || { up: 0, down: 0 };

    if (isUp) currentScore.up++; else currentScore.down++;
    await KV.put(env, scoreKey, currentScore, { expirationTtl: 14 * 24 * 3600 });

    const markup = { inline_keyboard: [[{ text: `рџ‘Ќ ${currentScore.up}`, callback_data: "rate_up" }, { text: `рџ‘Ћ ${currentScore.down}`, callback_data: "rate_down" }]] };
    await tg.api("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: markup });
    await tg.api("answerCallbackQuery", { callback_query_id: cb.id, text: "Р“РѕР»РѕСЃ СѓС‡С‚С‘РЅ!" });
}

async function processScheduled(env) {
    if (!env.UPSTASH_REDIS_REST_URL || !env.TELEGRAM_BOT_TOKEN) return;
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    const config = await getConfig(env);

    const pendingList = await KV.list(env, "pending:");
    for (const keyObj of pendingList.keys) {
        const id = keyObj.name.replace("pending:", "");
        try {
            const task = await KV.get(env, keyObj.name, "json");
            if (!task) { await KV.del(env, keyObj.name); continue; }

            const check = await hordeCheck(id);
            if (!check.done) {
                if (Date.now() - task.at > 3600000) {
                    await KV.del(env, keyObj.name);
                    if (task.notify) await tg.send(task.notify, `вЏ° РўР°Р№РјР°СѓС‚: <code>${id}</code>`);
                    if (task.batchId) {
                        let batch = await KV.get(env, `batch:${task.batchId}`, "json");
                        if (batch) { batch.expected--; await KV.put(env, `batch:${task.batchId}`, batch, { expirationTtl: 3600 }); }
                    }
                }
                continue;
            }

            const res = await hordeGetResult(id);

            if (res.faulted || res.message) {
                await KV.del(env, keyObj.name);
                if (task.notify) await tg.send(task.notify, `вќЊ РћС€РёР±РєР° РіРµРЅРµСЂР°С†РёРё: <code>${id}</code>`);
                if (task.batchId) {
                    let batch = await KV.get(env, `batch:${task.batchId}`, "json");
                    if (batch) { batch.expected--; await KV.put(env, `batch:${task.batchId}`, batch, { expirationTtl: 3600 }); }
                }
                continue;
            }

            const gens = res.generations || [];
            if (!gens.length) {
                await KV.del(env, keyObj.name);
                if (task.notify) await tg.send(task.notify, `вљ пёЏ РР·РѕР±СЂР°Р¶РµРЅРёРµ <code>${id}</code> РїСѓСЃС‚РѕРµ.`);
                if (task.batchId) {
                    let batch = await KV.get(env, `batch:${task.batchId}`, "json");
                    if (batch) { batch.expected--; await KV.put(env, `batch:${task.batchId}`, batch, { expirationTtl: 3600 }); }
                }
                continue;
            }

            let censored = false;
            let finalImageBase64 = null;
            let workerId = "?";
            let workerName = "?";

            for (const gen of gens) {
                workerId = gen.worker_id || "?";
                workerName = gen.worker_name || "?";
                if (isCensored(gen)) { censored = true; break; }
                if (gen.img) finalImageBase64 = gen.img;
            }

            if (censored) {
                await addWorkerToBlacklist(env, workerId, workerName);
                if (task.notify) await tg.send(task.notify, `рџ”ґ Р’РѕСЂРєРµСЂ <code>${workerName}</code> РІС‹РґР°Р» С†РµРЅР·СѓСЂСѓ. Р”РѕР±Р°РІР»РµРЅ РІ Р§РЎ.`);
                const retries = (task.retries || 0) + 1;
                if (retries < 3) {
                    const bl = (await getWorkerBlacklist(env)).map(w => w.id).filter(Boolean);
                    const newRes = await hordeSubmit(task.prompt, config, env, { workerBlacklist: bl });
                    if (newRes.id) {
                        await KV.put(env, `pending:${newRes.id}`, { ...task, at: Date.now(), retries }, { expirationTtl: 3600 });
                        if (task.notify) await tg.send(task.notify, `рџ”„ Р РµС‚СЂР°Р№ ${retries}/3...`);
                    }
                } else {
                    if (task.notify) await tg.send(task.notify, "вќЊ 3 РїРѕРїС‹С‚РєРё РЅРµСѓРґР°С‡РЅС‹.");
                    if (task.batchId) {
                        let batch = await KV.get(env, `batch:${task.batchId}`, "json");
                        if (batch) { batch.expected--; await KV.put(env, `batch:${task.batchId}`, batch, { expirationTtl: 3600 }); }
                    }
                }
                await KV.del(env, keyObj.name);
                continue;
            }

            if (finalImageBase64) {
                if (task.batchId) {
                    let batch = await KV.get(env, `batch:${task.batchId}`, "json");
                    if (batch) {
                        if (!batch.prompt) batch.prompt = task.prompt;
                        batch.ready.push(finalImageBase64);

                        if (batch.ready.length >= batch.expected) {
                            let captionText = "";
                            if (config.captionMode === 1) captionText = `рџЋЁ <i>${escapeHtml(batch.prompt.substring(0, 300))}</i>`;
                            else if (config.captionMode === 2) captionText = await generateAiCaption(batch.prompt, env, config);

                            for (const tId of batch.targets) {
                                if (batch.ready.length === 1) {
                                    await deliverImage(tg, tId, batch.ready[0], captionText, batch.notify, config, env);
                                } else {
                                    const processedBuffers = [];
                                    for (const b64 of batch.ready) {
                                        let targetUrl = b64;
                                        if (isHttpUrl(targetUrl)) {
                                            targetUrl = await getWatermarkedUrl(targetUrl, config, env);
                                        }
                                        let buf = isHttpUrl(targetUrl) ? await downloadImage(targetUrl) : base64ToBuffer(b64);
                                        if (!buf && isHttpUrl(targetUrl)) {
                                            buf = await downloadImage(b64);
                                        }
                                        if (buf) {
                                            processedBuffers.push(buf);
                                        }
                                    }
                                    if (processedBuffers.length > 0) {
                                        await tg.sendMediaGroup(tId, processedBuffers, captionText);
                                    }
                                }
                            }
                            await KV.del(env, `batch:${task.batchId}`);
                        } else {
                            await KV.put(env, `batch:${task.batchId}`, batch, { expirationTtl: 3600 });
                        }
                    } else {
                        await deliverImage(tg, task.targets[0], finalImageBase64, "", task.notify, config, env);
                    }
                } else {
                    let captionText = "";
                    if (config.captionMode === 1) captionText = task.prompt ? `рџЋЁ <i>${escapeHtml(task.prompt.substring(0, 300))}</i>` : "";
                    else if (config.captionMode === 2) captionText = await generateAiCaption(task.prompt, env, config);

                    for (const tId of (task.targets || [])) {
                        await deliverImage(tg, tId, finalImageBase64, captionText, task.notify, config, env);
                    }
                }
            }
            await KV.del(env, keyObj.name);

        } catch (e) {
            console.error(`[CRON] РћС€РёР±РєР° РѕР±СЂР°Р±РѕС‚РєРё ${id}:`, e.message);
        }
    }

    const activeBatches = await KV.list(env, "batch:");
    for (const bKey of activeBatches.keys) {
        let batch = await KV.get(env, bKey.name, "json");
        if (batch && batch.expected <= 0 && batch.ready.length > 0) {
            let captionText = config.captionMode === 1 ? `рџЋЁ <i>${escapeHtml(batch.prompt.substring(0, 300))}</i>` : "";
            for (const tId of batch.targets) {
                if (batch.ready.length === 1) {
                    await deliverImage(tg, tId, batch.ready[0], captionText, batch.notify, config, env);
                } else {
                    const processedBuffers = [];
                    for (const b64 of batch.ready) {
                        let targetUrl = b64;
                        if (isHttpUrl(targetUrl)) targetUrl = await getWatermarkedUrl(targetUrl, config, env);
                        let buf = isHttpUrl(targetUrl) ? await downloadImage(targetUrl) : base64ToBuffer(b64);
                        if (!buf && isHttpUrl(targetUrl)) buf = await downloadImage(b64);
                        if (buf) processedBuffers.push(buf);
                    }
                    if (processedBuffers.length > 0) await tg.sendMediaGroup(tId, processedBuffers, captionText);
                }
            }
            await KV.del(env, bKey.name);
        } else if (batch && batch.expected <= 0) {
            await KV.del(env, bKey.name);
        }
    }

    if (!config.enabled || (!config.groupId && !config.channelId) || !config.generalPrompt) return;
    if ((await KV.list(env, "pending:")).keys.length > 0) return;

    const lastPost = parseInt(await KV.get(env, "last_post_time") || "0", 10);
    const now = Date.now();
    if (now - lastPost < config.interval * 60 * 1000) return;

    const bl = (await getWorkerBlacklist(env)).map(w => w.id).filter(Boolean);
    const targets = [config.groupId, config.channelId].filter(Boolean);
    let queuedCount = 0;

    const segment = getRandomPromptSegment(config.generalPrompt);
    const batchId = Date.now() + "_" + Math.random().toString(36).substring(2,7);
    const actualCount = getActualCount(config.count);

    await KV.put(env, `batch:${batchId}`, { expected: actualCount, ready: [], targets, notify: config.adminId, prompt: "" }, { expirationTtl: 3600 });

    for (let i = 0; i < actualCount; i++) {
        try {
            const prmpt = await generatePrompt(segment, env, config);
            const bestRes = await determineResolution(prmpt, env, config);
            const res = await hordeSubmit(prmpt, config, env, { workerBlacklist: bl, width: bestRes.width, height: bestRes.height });

            if (res.id) {
                await KV.put(env, `pending:${res.id}`, { targets, prompt: prmpt, at: now, notify: config.adminId, retries: 0, batchId }, { expirationTtl: 3600 });
                queuedCount++;
            } else {
                if (config.adminId) await tg.send(config.adminId, `вќЊ <b>РћС€РёР±РєР° Р°РІС‚РѕРіРµРЅРµСЂР°С†РёРё (Horde):</b>\n<code>${escapeHtml(JSON.stringify(res))}</code>`);
                let batch = await KV.get(env, `batch:${batchId}`, "json");
                if (batch) { batch.expected--; await KV.put(env, `batch:${batchId}`, batch, { expirationTtl: 3600 }); }
            }
        } catch (e) {
            if (config.adminId) await tg.send(config.adminId, `вќЊ <b>РћС€РёР±РєР° Р°РІС‚РѕРіРµРЅРµСЂР°С†РёРё:</b>\n${escapeHtml(e.message)}`);
            let batch = await KV.get(env, `batch:${batchId}`, "json");
            if (batch) { batch.expected--; await KV.put(env, `batch:${batchId}`, batch, { expirationTtl: 3600 }); }
        }
    }

    if (queuedCount > 0) {
        await KV.put(env, "last_post_time", String(now));
    } else {
        await KV.put(env, "last_post_time", String(now - (config.interval * 60 * 1000) + 120000));
    }
}

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);

        ctx.waitUntil(KV.put(env, "worker_origin", url.origin));

        if (url.pathname === "/watermark.png") {
            const config = await getConfig(env);
            if (config.watermarkData) {
                const buf = base64ToBuffer(config.watermarkData);
                if (buf) {
                    return new Response(buf, { headers: { "Content-Type": "image/png" } });
                }
            }
            return new Response("Not found", { status: 404 });
        }

        if (url.pathname === "/webhook") {
            if (req.method !== "POST") return new Response("POST only", { status: 405 });
            try {
                const body = await req.json();
                if (body.message && (body.message.text?.startsWith("/") || body.message.caption?.startsWith("/"))) {
                    ctx.waitUntil(handleCommand(body.message, env));
                } else if (body.callback_query) {
                    ctx.waitUntil(handleCallback(body.callback_query, env));
                }

                ctx.waitUntil(processScheduled(env));
            } catch (e) { console.error("[WH]", e.message); }
            return new Response("OK", { status: 200 });
        }

        if (url.pathname === "/setup") {
            if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TELEGRAM_BOT_TOKEN!", { status: 500 });
            const webhookUrl = `${url.origin}/webhook`;
            const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message", "callback_query"], drop_pending_updates: true })
            });
            return new Response(`Webhook: ${webhookUrl}\n\n${JSON.stringify(await res.json(), null, 2)}`);
        }

        return new Response("рџ¤– Р‘РѕС‚ Р·Р°РїСѓС‰РµРЅ! РџРµСЂРµР№РґРё РЅР° /setup РґР»СЏ РЅР°СЃС‚СЂРѕР№РєРё РІРµР±С…СѓРєР°.");
    },

    async scheduled(event, env, ctx) {
        try {
            await processScheduled(env);
        } catch (e) {
            console.error("[CRON] CRASH:", e.message);
        }
    }
};