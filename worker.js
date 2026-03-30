const DEFAULT_CONFIG = {
    enabled: false,
    groupId: null,
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
    captionPrompt: "Опиши эту картинку для поста в Telegram-канале на русском языке, креативно и с эмодзи. Без лишних вступлений.",
    useSpoiler: false,
    ratingEnabled: false,
    ratingType: "buttons"
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:16.1:tg" };
const MIN_IMAGE_KB = 10;

function escapeHtml(text) {
    return text == null ? "" : String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isHttpUrl(text) {
    return typeof text === "string" && /^https?:\/\//i.test(text);
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
        form.append("photo", new File([buffer], "image.webp", { type: "image/webp" }));
        if (caption) {
            form.append("caption", caption.substring(0, 1024));
            form.append("parse_mode", "HTML");
        }
        if (extra.hasSpoiler) form.append("has_spoiler", "true");
        if (extra.replyMarkup) form.append("reply_markup", JSON.stringify(extra.replyMarkup));
        return (await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form })).json();
    }
    async sendDocument(chatId, buffer, caption = "", extra = {}) {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("document", new File([buffer], "image.webp", { type: "image/webp" }));
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

const Redis = {
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

const KV = Redis;

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

async function hordeSubmit(prompt, config, env, extra = {}) {
    const key = getApiKey(env);
    const params = {
        sampler_name: config.sampler,
        cfg_scale: config.cfgScale,
        width: config.width,
        height: config.height,
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
            model: l.strength ?? 1,
            clip: l.clip ?? 1,
            inject_trigger: "any",
            is_version: false
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

function base64ToBuffer(b64) {
    try {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr.buffer;
    } catch { return null; }
}

async function deliverImage(tg, chatId, imgData, caption, notifyId, config) {
    if (!imgData) {
        if (notifyId) await tg.send(notifyId, "❌ Нет данных картинки от воркера");
        return { sent: false, tooSmall: false, sizeKB: 0 };
    }

    const isUrl = isHttpUrl(imgData);
    let buffer = null;
    const extra = { hasSpoiler: config.useSpoiler };

    if (config.ratingEnabled && config.ratingType === "buttons") {
        extra.replyMarkup = { inline_keyboard: [[{ text: "👍 0", callback_data: "rate_up" }, { text: "👎 0", callback_data: "rate_down" }]] };
    }

    if (isUrl) {
        buffer = await downloadImage(imgData);
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
        if (notifyId) await tg.send(notifyId, `🚫 <b>Похоже на заглушку/цензуру</b>\nРазмер: ${sizeKB}KB`);
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

    if (notifyId) await tg.send(notifyId, `❌ Не удалось отправить изображение: ${escapeHtml(r?.description || "unknown error")}`);
    return { sent: false, tooSmall: false, sizeKB };
}

async function callOpenRouter(env, model, messages, maxTokens = 2048, retries = 2) {
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

async function generatePrompt(basePrompt, env, config) {
    if (!env.OPENROUTER_API_KEY) return basePrompt;
    const llmModel = config.llmModel || "openrouter/free";
    let sysPrompt, userPrompt;
    const match = basePrompt.match(/\[([\s\S]*?)\]/);

    if (match) {
        const instruction = match[1];
        const cleanPrompt = basePrompt.replace(match[0], "").trim();
        sysPrompt = "You are a Stable Diffusion prompt engineer. Output ONLY the final prompt as comma-separated tags. No explanations, no markdown. CRITICAL: Ensure the output is complete and NEVER cut off mid-sentence.";
        userPrompt = `Base prompt: ${cleanPrompt}\nInstruction: ${instruction}`;
    } else {
        sysPrompt = "You are a Stable Diffusion prompt engineer. Output ONLY the final prompt as comma-separated tags. No explanations, no markdown. CRITICAL: Ensure the output is complete and NEVER cut off mid-sentence.";
        userPrompt = `Create a detailed image generation prompt based on this theme: ${basePrompt}`;
    }

    const result = await callOpenRouter(env, llmModel, [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt }
    ], 2048);

    if (result) return result.replace(/^["'`*\n]+|["'`*\n]+$/g, "").trim();

    if (match) {
        console.error("[LLM] OpenRouter API failed to process prompt instruction.");
        throw new Error("Не удалось обработать инструкцию для промпта через OpenRouter. Повторите позже.");
    }
    return basePrompt;
}

async function generateAiCaption(imagePrompt, env, config) {
    if (!env.OPENROUTER_API_KEY) return `🎨 <i>${escapeHtml(imagePrompt.substring(0, 300))}</i>`;
    const result = await callOpenRouter(env, config.llmModel || "openrouter/free", [
        { role: "system", content: config.captionPrompt || "Опиши картинку для Telegram-канала. Пиши интересно, используй эмодзи. Без вступлений." },
        { role: "user", content: `Промпт картинки: ${imagePrompt.substring(0, 1000)}` }
    ], 2048);

    if (!result || result.trim().length === 0 || result.includes("HTTP ")) {
        return `🎨 <i>${escapeHtml(imagePrompt.substring(0, 300))}</i>`;
    }
    return result;
}

async function handleCommand(msg, env) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || "";

    if (!env.TELEGRAM_BOT_TOKEN) return;
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);

    if (!text.startsWith("/")) return;

    const args = text.split(/\s+/);
    const cmd = args[0].split("@")[0].toLowerCase();
    const params = args.slice(1);

    if (cmd === "/ping") {
        const key = getApiKey(env);
        return await tg.send(chatId, `🏓 <b>Pong!</b>\n📍 Chat: <code>${chatId}</code>\n💾 Redis: ${env.UPSTASH_REDIS_REST_URL ? "✅" : "❌"}\n🎨 Horde: ${key === "0000000000" ? "🔴 anon" : "✅ ok"}\n🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "❌"}`);
    }

    let config = await getConfig(env);
    if (!config.adminId) {
        config.adminId = userId;
        await saveConfig(env, config);
        await tg.send(chatId, `👑 Ты теперь админ. Твой ID: <code>${userId}</code>`);
    }

    if (config.adminId !== userId) {
        return await tg.send(chatId, `🔒 Доступ только для админа.`);
    }

    switch (cmd) {
        case "/start":
        case "/help":
            await tg.send(chatId, `🤖 <b>Image Bot</b>\n\n<b>Постинг:</b>\n/setgroup | /setchannel &lt;@name&gt; | /ungroup | /unchannel\n/setinterval &lt;мин&gt; | /setcount &lt;1-10&gt; | /enable | /disable | /generate\n\n<b>Промпты:</b>\n/setprompt &lt;текст&gt; | /setneg &lt;текст&gt;\n\n<b>Подписи и ИИ:</b>\n/setcaptionmode &lt;0|1|2&gt; | /setcaptionprompt &lt;инстр&gt; | /setllm &lt;model&gt;\n\n<b>Параметры и Модели:</b>\n/setmodel &lt;имя&gt; | /listmodels | /searchmodel &lt;запрос&gt;\n/addlora &lt;id&gt; [str] [clip] | /listloras | /clearloras\n/setenhancer &lt;FaceFix AnimeUpscale и т.д. | clear&gt;\n/setsize &lt;W&gt; &lt;H&gt; | /setsteps &lt;N&gt; | /setcfg &lt;N&gt; | /setsampler &lt;name&gt;\n/setspoiler &lt;on|off&gt;\n\n<b>Оценки и Статистика:</b>\n/setratings &lt;on|off&gt; | /setratingtype &lt;button|emoji&gt; | /analytics\n\n<b>Статус:</b>\n/status | /pending | /cancel | /workerbl | /ping`);
            break;

        case "/setgroup":
            config.groupId = chatId; await saveConfig(env, config);
            await tg.send(chatId, `✅ Группа установлена: <code>${chatId}</code>`);
            break;

        case "/setchannel":
            if (!params[0]) return await tg.send(chatId, "❌ /setchannel &lt;@username&gt; или ID");
            config.channelId = params[0]; await saveConfig(env, config);
            await tg.send(chatId, `✅ Канал установлен: <code>${params[0]}</code>`);
            break;

        case "/ungroup":
            config.groupId = null; await saveConfig(env, config);
            await tg.send(chatId, "✅ Группа отвязана");
            break;

        case "/unchannel":
            config.channelId = null; await saveConfig(env, config);
            await tg.send(chatId, "✅ Канал отвязан");
            break;

        case "/setprompt":
            if (!params.length) return await tg.send(chatId, "❌ /setprompt &lt;тема&gt;");
            config.generalPrompt = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `✅ Промпт:\n<code>${escapeHtml(config.generalPrompt)}</code>`);
            break;

        case "/setcaptionmode": {
            const mode = parseInt(params[0]);
            if (![0, 1, 2].includes(mode)) return await tg.send(chatId, "❌ /setcaptionmode &lt;0|1|2&gt;");
            config.captionMode = mode; await saveConfig(env, config);
            await tg.send(chatId, `✅ Режим подписи: ${mode}`);
            break;
        }

        case "/setcaptionprompt":
            if (!params.length) return await tg.send(chatId, "❌ /setcaptionprompt &lt;инструкция&gt;");
            config.captionPrompt = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, "✅ Инструкция для подписей обновлена");
            break;

        case "/setenhancer": {
            if (!params.length) return await tg.send(chatId, "❌ /setenhancer <FaceFix|Upscale|AnimeUpscale|CodeFormers|clear>\nМожно перечислить несколько через пробел.");
            if (params[0].toLowerCase() === "clear") {
                config.postProcessors = [];
                await tg.send(chatId, "✅ Улучшайзеры сброшены");
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
                await tg.send(chatId, `✅ Улучшайзеры: ${config.postProcessors.join(", ")}`);
            }
            await saveConfig(env, config);
            break;
        }

        case "/setmodel":
            if (!params.length) return await tg.send(chatId, "❌ /setmodel &lt;имя&gt;");
            config.model = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `✅ Модель: <code>${escapeHtml(config.model)}</code>`);
            break;

        case "/listmodels":
            await tg.send(chatId, "⏳ Загружаю топ-40 моделей...");
            try {
                const models = (await hordeGetModels() || []).filter(m => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 40);
                let txt = "📋 <b>Модели (топ-40):</b>\n\n";
                models.forEach(m => txt += `${m.name?.includes("XL") ? "🟢" : "⚪"} <code>${escapeHtml(m.name)}</code> (${m.count}w)\n`);
                await tg.send(chatId, txt);
            } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
            break;

        case "/searchmodel": {
            const qm = params.join(" ").toLowerCase();
            if (!qm) return await tg.send(chatId, "❌ /searchmodel &lt;запрос&gt;");
            try {
                const models = (await hordeGetModels() || []).filter(m => m.name.toLowerCase().includes(qm)).sort((a, b) => b.count - a.count).slice(0, 20);
                if (!models.length) return await tg.send(chatId, "😕 Ничего не найдено");
                let txt = `🔍 <b>Найдено (${models.length}):</b>\n\n`;
                models.forEach(m => txt += `<code>${escapeHtml(m.name)}</code> (${m.count}w)\n`);
                await tg.send(chatId, txt);
            } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
            break;
        }

        case "/addlora": {
            if (!params.length) return await tg.send(chatId, "❌ /addlora &lt;ID&gt; [strength=1] [clip=1]");
            const loraId = params[0];
            const loraStr = parseFloat(params[1]) || 1;
            const loraClip = parseFloat(params[2]) || 1;
            if (!config.loras) config.loras = [];
            if (config.loras.find(l => String(l.name) === String(loraId))) {
                return await tg.send(chatId, `⚠️ LoRA <code>${loraId}</code> уже в списке`);
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
                    if (base) compatMsg = `\n📦 <b>${escapeHtml(loraTitle)}</b> [${base}]`;
                    if (isXL !== loraIsXL) compatMsg += `\n⚠️ <b>Внимание:</b> LoRA обучена на <b>${base}</b>. Скорее всего не применится!`;
                    else compatMsg += `\n✅ Совместима с текущей моделью`;
                }
            } catch (_) {}
            config.loras.push({ name: loraId, title: loraTitle, strength: loraStr, clip: loraClip });
            await saveConfig(env, config);
            await tg.send(chatId, `✅ LoRA <code>${loraId}</code> добавлена (str: ${loraStr}, clip: ${loraClip})${compatMsg}`);
            break;
        }

        case "/listloras":
            if (!config.loras?.length) return await tg.send(chatId, "📋 Список LoRA пуст.");
            let lt = "📋 <b>Активные LoRA:</b>\n\n";
            config.loras.forEach((l, i) => {
                const nameStr = l.title && l.title !== l.name ? `${escapeHtml(l.title)} (ID: ${l.name})` : l.name;
                lt += `${i + 1}. <b>${nameStr}</b> (str: ${l.strength}, clip: ${l.clip})\n`;
            });
            await tg.send(chatId, lt);
            break;

        case "/clearloras":
            config.loras = []; await saveConfig(env, config);
            await tg.send(chatId, "✅ Список LoRA очищен");
            break;

        case "/setsampler":
            if (!params[0]) return await tg.send(chatId, "❌ /setsampler &lt;имя&gt;");
            config.sampler = params[0]; await saveConfig(env, config);
            await tg.send(chatId, `✅ Sampler: ${config.sampler}`);
            break;

        case "/setcfg":
            if (!params[0]) return await tg.send(chatId, "❌ /setcfg &lt;число&gt;");
            config.cfgScale = parseFloat(params[0]); await saveConfig(env, config);
            await tg.send(chatId, `✅ CFG: ${config.cfgScale}`);
            break;

        case "/setsteps":
            if (!params[0]) return await tg.send(chatId, "❌ /setsteps &lt;число&gt;");
            config.steps = parseInt(params[0]); await saveConfig(env, config);
            await tg.send(chatId, `✅ Steps: ${config.steps}`);
            break;

        case "/setneg":
            if (!params.length) return await tg.send(chatId, "❌ /setneg &lt;текст&gt;");
            config.negativePrompt = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, "✅ Негативный промпт сохранён");
            break;

        case "/setllm":
            if (!params.length) return await tg.send(chatId, "❌ /setllm &lt;модель&gt;");
            config.llmModel = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `✅ LLM: <code>${config.llmModel}</code>`);
            break;

        case "/setspoiler":
            if (!params[0]) return await tg.send(chatId, "❌ /setspoiler <on|off>");
            config.useSpoiler = params[0].toLowerCase() === "on";
            await saveConfig(env, config);
            await tg.send(chatId, `✅ Спойлер: ${config.useSpoiler ? "ВКЛ" : "ВЫКЛ"}`);
            break;

        case "/setratings":
            if (!params[0]) return await tg.send(chatId, "❌ /setratings <on|off>");
            config.ratingEnabled = params[0].toLowerCase() === "on";
            await saveConfig(env, config);
            await tg.send(chatId, `✅ Рейтинги: ${config.ratingEnabled ? "ВКЛ" : "ВЫКЛ"}`);
            break;

        case "/setratingtype":
            if (!params[0] || !["button", "emoji"].includes(params[0].toLowerCase())) return await tg.send(chatId, "❌ /setratingtype <button|emoji>");
            config.ratingType = params[0].toLowerCase() === "button" ? "buttons" : "reactions";
            await saveConfig(env, config);
            await tg.send(chatId, `✅ Тип рейтинга: ${config.ratingType}`);
            break;

        case "/analytics": {
            const histList = await KV.list(env, "hist:");
            if (!histList.keys.length) return await tg.send(chatId, "📊 Нет данных для аналитики.");

            const entries = [];
            for (const k of histList.keys) {
                const data = await KV.get(env, k.name, "json");
                if (data) entries.push(data);
            }
            entries.sort((a, b) => b.time - a.time);
            const recent = entries.slice(0, 15);

            let text = "📊 <b>Последние генерации:</b>\n\n";
            for (const e of recent) {
                const scoreData = await KV.get(env, `score:${e.chatId}:${e.msgId}`, "json") || { up: 0, down: 0 };
                const net = scoreData.up - scoreData.down;
                const link = `t.me/c/${String(e.chatId).replace("-100", "")}/${e.msgId}`;
                text += `🔗 <a href="${link}">Post</a> | ⭐️ Score: ${net > 0 ? "+"+net : net} (👍${scoreData.up}/👎${scoreData.down})\n`;
            }
            await tg.send(chatId, text, { disable_web_page_preview: true });
            break;
        }

        case "/setinterval": {
            const inv = parseInt(params[0]);
            if (inv > 0) { config.interval = inv; await saveConfig(env, config); await tg.send(chatId, `✅ Интервал: ${inv} мин`); }
            else await tg.send(chatId, "❌ /setinterval &lt;минуты&gt;");
            break;
        }

        case "/setcount": {
            const cnt = parseInt(params[0]);
            if (cnt > 0 && cnt <= 10) { config.count = cnt; await saveConfig(env, config); await tg.send(chatId, `✅ Количество: ${cnt}`); }
            else await tg.send(chatId, "❌ /setcount &lt;1-10&gt;");
            break;
        }

        case "/setsize": {
            const w = parseInt(params[0]); const h = parseInt(params[1]);
            if (w > 255 && h > 255) {
                config.width = 64 * Math.round(w / 64);
                config.height = 64 * Math.round(h / 64);
                await saveConfig(env, config);
                await tg.send(chatId, `✅ Размер: ${config.width}x${config.height}`);
            } else await tg.send(chatId, "❌ /setsize &lt;W&gt; &lt;H&gt;");
            break;
        }

        case "/enable":
            if (!config.groupId && !config.channelId) return await tg.send(chatId, "❌ Сначала привяжи группу (/setgroup) или канал (/setchannel)");
            if (!config.generalPrompt) return await tg.send(chatId, "❌ Сначала задай промпт (/setprompt)");
            config.enabled = true; await saveConfig(env, config);
            await tg.send(chatId, "🟢 Автопостинг включён!");
            break;

        case "/disable":
            config.enabled = false; await saveConfig(env, config);
            await tg.send(chatId, "🔴 Автопостинг выключен");
            break;

        case "/generate":
            if (!config.generalPrompt) return await tg.send(chatId, "❌ Сначала задай промпт (/setprompt)");
            await tg.send(chatId, `⏳ Генерирую ${config.count} фото...`);
            {
                const bl = (await getWorkerBlacklist(env)).map(w => w.id).filter(Boolean);
                for (let i = 0; i < config.count; i++) {
                    try {
                        const finalPrompt = await generatePrompt(config.generalPrompt, env, config);
                        await tg.send(chatId, `🎨 #${i + 1}:\n<code>${escapeHtml(finalPrompt.substring(0, 300))}</code>`);
                        const res = await hordeSubmit(finalPrompt, config, env, { workerBlacklist: bl });
                        if (res.id) {
                            await KV.put(env, `pending:${res.id}`, { targets: [chatId], prompt: finalPrompt, at: Date.now(), notify: chatId, retries: 0 }, { expirationTtl: 3600 });
                            await tg.send(chatId, `📤 ID: <code>${res.id}</code>\n⏳ Отправлено в очередь.`);
                        } else {
                            await tg.send(chatId, `❌ Horde: ${escapeHtml(JSON.stringify(res))}`);
                        }
                    } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
                }
            }
            break;

        case "/status": {
            let queueCount = 0;
            try { queueCount = (await KV.list(env, "pending:")).keys.length; } catch {}
            const pps = config.postProcessors?.length ? config.postProcessors.join(", ") : "нет";
            await tg.send(chatId, `📊 <b>Статус</b>\n\n<b>Автопост:</b> ${config.enabled ? "🟢" : "🔴"}\n<b>Группа:</b> ${config.groupId || "❌"}\n<b>Канал:</b> ${config.channelId || "❌"}\n<b>Улучшайзеры:</b> ${pps}\n<b>Режим подписи:</b> ${config.captionMode}\n<b>Спойлер:</b> ${config.useSpoiler ? "🟢" : "🔴"}\n<b>Рейтинги:</b> ${config.ratingEnabled ? "🟢" : "🔴"} (${config.ratingType})\n\n<b>Промпт:</b>\n<code>${escapeHtml(config.generalPrompt)}</code>\n\n<b>Негативный промпт:</b>\n<code>${escapeHtml(config.negativePrompt)}</code>\n\n<b>Модель:</b> <code>${escapeHtml(config.model)}</code>\n<b>Самплер:</b> <code>${escapeHtml(config.sampler)}</code>\n<b>Размер:</b> ${config.width}x${config.height}\n<b>Steps:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}\n<b>LoRA:</b> ${config.loras?.length || 0} шт\n<b>LLM:</b> <code>${escapeHtml(config.llmModel)}</code>\n<b>Очередь:</b> ${queueCount}`);
            break;
        }

        case "/pending":
            try {
                const pendList = await KV.list(env, "pending:");
                if (!pendList.keys.length) {
                    return await tg.send(chatId, `⏳ В очереди: 0 генераций`);
                }
                
                await tg.send(chatId, `⏳ <b>В очереди: ${pendList.keys.length} генераций</b>\nПроверяю статус серверов...`);

                let count = 0;
                let statusTxt = "";
                for (const k of pendList.keys) {
                    if (count >= 5) {
                        statusTxt += `\n<i>...и еще ${pendList.keys.length - 5}</i>`;
                        break;
                    }
                    const id = k.name.replace("pending:", "");
                    const checkData = await hordeCheck(id);
                    const waitTime = checkData.wait_time ? Math.round(checkData.wait_time) : "?";
                    const qPos = checkData.queue_position !== undefined ? checkData.queue_position : "?";
                    statusTxt += `🔹 ID: <code>${id.substring(0,8)}...</code> | Ожидание: ~${waitTime} сек | Перед вами: ${qPos}\n`;
                    count++;
                }
                await tg.send(chatId, `📊 <b>Статус очереди:</b>\n\n${statusTxt}`);
            } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
            break;

        case "/cancel":
            try {
                const plist = await KV.list(env, "pending:");
                let canceled = 0;
                for (const k of plist.keys) { await KV.del(env, k.name); canceled++; }
                await tg.send(chatId, `✅ Очередь очищена. Удалено задач: ${canceled}`);
            } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
            break;

        case "/workerbl":
            await clearWorkerBlacklist(env);
            await tg.send(chatId, "✅ Блэклист воркеров очищен");
            break;

        default:
            if (cmd.startsWith("/")) await tg.send(chatId, "❓ Неизвестная команда. Введи /help");
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
        await tg.api("answerCallbackQuery", { callback_query_id: cb.id, text: "Вы уже проголосовали!" });
        return;
    }

    await KV.put(env, rateKey, "1", { expirationTtl: 14 * 24 * 3600 });
    const isUp = cb.data === "rate_up";
    const scoreKey = `score:${chatId}:${msgId}`;
    let currentScore = await KV.get(env, scoreKey, "json") || { up: 0, down: 0 };

    if (isUp) currentScore.up++; else currentScore.down++;
    await KV.put(env, scoreKey, currentScore, { expirationTtl: 14 * 24 * 3600 });

    const markup = { inline_keyboard: [[{ text: `👍 ${currentScore.up}`, callback_data: "rate_up" }, { text: `👎 ${currentScore.down}`, callback_data: "rate_down" }]] };
    await tg.api("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: markup });
    await tg.api("answerCallbackQuery", { callback_query_id: cb.id, text: "Голос учтён!" });
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

            if (Date.now() - task.at > 3600000) {
                await KV.del(env, keyObj.name);
                if (task.notify) await tg.send(task.notify, `⏰ Таймаут: <code>${id}</code>`);
                continue;
            }

            const check = await hordeCheck(id);
            if (!check.done) continue;

            const res = await hordeGetResult(id);

            if (res.faulted) {
                await KV.del(env, keyObj.name);
                if (task.notify) await tg.send(task.notify, `❌ Ошибка генерации: <code>${id}</code>`);
                continue;
            }

            const gens = res.generations || [];
            if (!gens.length) {
                await KV.del(env, keyObj.name);
                continue;
            }

            let success = false;
            let censored = false;

            try {
                for (const gen of gens) {
                    const wId = gen.worker_id || "?";
                    const wName = gen.worker_name || "?";
                    const isCens = isCensored(gen);

                    if (isCens) {
                        await addWorkerToBlacklist(env, wId, wName);
                        censored = true;
                        if (task.notify) await tg.send(task.notify, `🔴 Воркер <code>${wName}</code> выдал цензуру. Добавлен в ЧС.`);
                        continue;
                    }

                    if (!gen.img) continue;

                    let captionText = "";
                    if (config.captionMode === 1) captionText = task.prompt ? `🎨 <i>${escapeHtml(task.prompt.substring(0, 300))}</i>` : "";
                    else if (config.captionMode === 2) captionText = await generateAiCaption(task.prompt, env, config);

                    for (const tId of (task.targets || [])) {
                        const { sent, tooSmall, msgId } = await deliverImage(tg, tId, gen.img, captionText, task.notify, config);
                        if (sent) {
                            success = true;
                            if (msgId) {
                                const histObj = { msgId, chatId: tId, time: Date.now() };
                                await KV.put(env, `hist:${Date.now()}_${Math.random().toString(36).substring(2,7)}`, histObj, { expirationTtl: 14 * 24 * 3600 });
                            }
                        }
                        if (tooSmall) {
                            censored = true;
                            await addWorkerToBlacklist(env, wId, wName);
                        }
                    }
                }
            } catch (err) {
                console.error(`[PROCESS] Внутренняя ошибка обработки ${id}:`, err.message);
            }

            if (censored && !success && !task.sfwTest) {
                const retries = (task.retries || 0) + 1;
                if (retries < 3) {
                    const bl = (await getWorkerBlacklist(env)).map(w => w.id).filter(Boolean);
                    const newRes = await hordeSubmit(task.prompt, config, env, { workerBlacklist: bl });
                    if (newRes.id) {
                        await KV.put(env, `pending:${newRes.id}`, { ...task, at: Date.now(), retries }, { expirationTtl: 3600 });
                        if (task.notify) await tg.send(task.notify, `🔄 Ретрай ${retries}/3...`);
                    }
                } else if (task.notify) {
                    await tg.send(task.notify, "❌ 3 попытки неудачны. Скорее всего анонимный ключ или модель цензурит промпт.");
                }
                await KV.del(env, keyObj.name); 
            } else {
                await KV.del(env, keyObj.name); 
            }
        } catch (e) {
            console.error(`[CRON] Ошибка обработки ${id}:`, e.message);
        }
    }

    if (!config.enabled || (!config.groupId && !config.channelId) || !config.generalPrompt) return;
    if ((await KV.list(env, "pending:")).keys.length > 0) return;

    const lastPost = parseInt(await KV.get(env, "last_post_time") || "0", 10);
    const now = Date.now();
    if (now - lastPost < config.interval * 60 * 1000) return;
    await KV.put(env, "last_post_time", String(now));

    const bl = (await getWorkerBlacklist(env)).map(w => w.id).filter(Boolean);
    const targets = [config.groupId, config.channelId].filter(Boolean);

    for (let i = 0; i < config.count; i++) {
        try {
            const prmpt = await generatePrompt(config.generalPrompt, env, config);
            const res = await hordeSubmit(prmpt, config, env, { workerBlacklist: bl });
            if (res.id) {
                await KV.put(env, `pending:${res.id}`, { targets, prompt: prmpt, at: now, notify: config.adminId, retries: 0 }, { expirationTtl: 3600 });
            } else {
                console.error("[CRON] Horde submit failed:", JSON.stringify(res));
            }
        } catch (e) {
            console.error("[CRON] Auto-post error:", e.message);
        }
    }
}

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);

        if (url.pathname === "/webhook") {
            if (req.method !== "POST") return new Response("POST only", { status: 405 });
            try {
                const body = await req.json();
                if (body.message?.text && body.message.text.startsWith("/")) {
                    ctx.waitUntil(handleCommand(body.message, env));
                } else if (body.callback_query) {
                    ctx.waitUntil(handleCallback(body.callback_query, env));
                }
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

        return new Response("🤖 Бот запущен! Перейди на /setup для настройки вебхука.");
    },

    async scheduled(event, env, ctx) {
        try {
            await processScheduled(env);
        } catch (e) {
            console.error("[CRON] CRASH:", e.message);
        }
    }
};
