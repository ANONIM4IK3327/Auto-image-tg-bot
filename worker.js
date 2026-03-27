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
    llmModel: "meta-llama/llama-3.3-70b-instruct:free",
    clipSkip: 2,
    hiresFix: false,
    hiresFixDenoising: 0.65,
    karras: true,
    postProcessors: [],
    captionMode: 1,
    captionPrompt: "Опиши эту картинку для поста в Telegram-канале на русском языке, креативно и с эмодзи. Без лишних вступлений."
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = { "Client-Agent": "TgImageBot:15.0:tg" };
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
    async sendPhoto(chatId, buffer, caption = "") {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("photo", new File([buffer], "image.webp", { type: "image/webp" }));
        if (caption) {
            form.append("caption", caption.substring(0, 1024));
            form.append("parse_mode", "HTML");
        }
        return (await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form })).json();
    }
    async sendDocument(chatId, buffer, caption = "") {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("document", new File([buffer], "image.webp", { type: "image/webp" }));
        if (caption) {
            form.append("caption", caption.substring(0, 1024));
            form.append("parse_mode", "HTML");
        }
        return (await fetch(`${this.base}/sendDocument`, { method: "POST", body: form })).json();
    }
    sendPhotoUrl(chatId, url, caption = "") {
        return this.api("sendPhoto", { chat_id: chatId, photo: url, caption: caption.substring(0, 1024), parse_mode: "HTML" });
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
        if (opts.expirationTtl) {
            args.push("EX", opts.expirationTtl);
        }
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
        if (list.length > 30) list.shift();
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

    if (config.postProcessors && config.postProcessors.length > 0) {
        params.post_processing = config.postProcessors;
    }

    if (!extra.skipLoras && config.loras?.length > 0) {
        params.loras = config.loras.map(l => ({ name: String(l.name), model: l.strength ?? 1, clip: l.clip ?? 1, inject_trigger: "any", is_version: true }));
    }

    const payload = {
        prompt: config.negativePrompt ? `${prompt} ### ${config.negativePrompt}` : prompt,
        params,
        nsfw: config.nsfw,
        censor_nsfw: false,
        trusted_workers: false,
        replacement_filter: true,
        models: [config.model],
        r2: true,
        shared: false,
        allow_downgrade: true
    };

    if (extra.workerBlacklist?.length > 0) {
        payload.workers = extra.workerBlacklist.slice(0, 5);
        payload.worker_blacklist = true;
    }

    return (await fetch(`${HORDE_API}/generate/async`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key, ...HORDE_HEADERS },
        body: JSON.stringify(payload)
    })).json();
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

async function deliverImage(tg, chatId, imgData, caption, notifyId) {
    if (!imgData) {
        if (notifyId) await tg.send(notifyId, "❌ Нет данных картинки от воркера");
        return { sent: false, tooSmall: false, sizeKB: 0 };
    }

    const isUrl = isHttpUrl(imgData);
    let buffer = null;

    if (isUrl) {
        buffer = await downloadImage(imgData);
        if (!buffer) {
            const r = await tg.sendPhotoUrl(chatId, imgData, caption);
            return { sent: r.ok, tooSmall: false, sizeKB: 0 };
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

    let r = await tg.sendPhoto(chatId, buffer, caption);
    if (r.ok) return { sent: true, tooSmall: false, sizeKB };

    r = await tg.sendDocument(chatId, buffer, caption);
    if (r.ok || (isUrl && (await tg.sendPhotoUrl(chatId, imgData, caption)).ok)) {
        return { sent: true, tooSmall: false, sizeKB };
    }

    if (notifyId) await tg.send(notifyId, `❌ Не удалось отправить изображение: ${escapeHtml(r.description)}`);
    return { sent: false, tooSmall: false, sizeKB };
}

async function generatePrompt(basePrompt, env, config) {
    let instruction = null;
    let cleanPrompt = basePrompt;

    const match = basePrompt.match(/\[([\s\S]*?)\]/);
    if (match) {
        instruction = match[1];
        cleanPrompt = basePrompt.replace(match[0], '').trim();
    }

    if (env.OPENROUTER_API_KEY) {
        const llmModel = config.llmModel || env.LLM_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
        let sysPrompt, userPrompt;

        if (instruction) {
            sysPrompt = "You are an expert Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. Modify the user's prompt strictly according to their explicit instruction. No explanations, no markdown.";
            userPrompt = `Base prompt: ${cleanPrompt}\nInstruction to apply: ${instruction}`;
        } else {
            sysPrompt = "You are an expert Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations.";
            userPrompt = `Create a unique highly detailed image generation prompt based on this theme: ${cleanPrompt}. Add nice lighting and camera angles.`;
        }

        try {
            const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                    "HTTP-Referer": "https://t.me",
                    "X-Title": "TgImageBot"
                },
                body: JSON.stringify({
                    model: llmModel,
                    messages: [
                        { role: "system", content: sysPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 300
                })
            });
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content?.trim();
            if (text && text.length > 5) return text.replace(/^["'`*]+|["'`*]+$/g, "");
        } catch (e) {
            console.error("[LLM Prompt Error]", e.message);
        }
    }
    return cleanPrompt + ", masterpiece, highly detailed, best quality";
}

async function generateAiCaption(imagePrompt, env, config) {
    if (!env.OPENROUTER_API_KEY) return `🎨 <i>${escapeHtml(imagePrompt)}</i>`;
    try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                "HTTP-Referer": "https://t.me",
                "X-Title": "TgImageBot"
            },
            body: JSON.stringify({
                model: config.llmModel || "meta-llama/llama-3.3-70b-instruct:free",
                messages: [
                    { role: "system", content: config.captionPrompt || "Опиши картинку для Telegram-канала. Пиши интересно, используй эмодзи. Без вступлений." },
                    { role: "user", content: `Промпт картинки: ${imagePrompt}` }
                ],
                temperature: 0.8,
                max_tokens: 250
            })
        });
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        return text ? text : `🎨 <i>${escapeHtml(imagePrompt)}</i>`;
    } catch (e) {
        return `🎨 <i>${escapeHtml(imagePrompt)}</i>`;
    }
}

async function handleCommand(msg, env) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || "";

    if (!env.TELEGRAM_BOT_TOKEN) return;
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);

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
            await tg.send(chatId, `🤖 <b>Image Bot (Upgraded)</b>\n\n<b>Куда постить:</b>\n/setgroup — привязать текущую группу\n/setchannel &lt;@name&gt; — привязать канал\n/ungroup | /unchannel\n\n<b>Базовые:</b>\n/setprompt &lt;текст&gt; — тема (можно юзать [команды для LLM])\n/setinterval &lt;мин&gt; | /setcount &lt;1-10&gt;\n/enable | /disable | /generate\n\n<b>Подписи и ИИ (Caption):</b>\n/setcaptionmode &lt;0|1|2&gt; (0-ничего, 1-промпт, 2-AI текст)\n/setcaptionprompt &lt;инструкция для AI текста&gt;\n\n<b>Модели, LoRA, Фильтры:</b>\n/setmodel &lt;имя&gt; | /listmodels | /searchmodel &lt;запрос&gt;\n/searchlora &lt;запрос&gt; | /addlora &lt;id&gt; | /listloras | /clearloras\n/setenhancer &lt;FaceFix|Upscale|clear&gt;\n\n<b>Параметры:</b>\n/setsize &lt;W&gt; &lt;H&gt; | /setsteps &lt;N&gt; | /setcfg &lt;N&gt;\n/setsampler &lt;name&gt; | /setneg &lt;text&gt; | /setllm &lt;model&gt;\n\n<b>Статус:</b>\n/status | /pending | /cancel | /workerbl`);
            break;

        case "/setgroup":
            config.groupId = chatId; await saveConfig(env, config);
            await tg.send(chatId, `✅ Группа для автопостов установлена: <code>${chatId}</code>`);
            break;
        case "/setchannel":
            if (!params[0]) return await tg.send(chatId, "❌ /setchannel &lt;@channel_username&gt; или ID");
            config.channelId = params[0]; await saveConfig(env, config);
            await tg.send(chatId, `✅ Канал для автопостов установлен: <code>${params[0]}</code>`);
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
            if (!params.length) return await tg.send(chatId, "❌ /setprompt &lt;тема&gt; (Можно использовать [сделай так-то] для LLM)");
            config.generalPrompt = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `✅ Промпт:\n<code>${escapeHtml(config.generalPrompt)}</code>`);
            break;

        case "/setcaptionmode":
            const mode = parseInt(params[0]);
            if (![0, 1, 2].includes(mode)) return await tg.send(chatId, "❌ /setcaptionmode <0|1|2>\n0 - Без текста\n1 - Промпт\n2 - AI Генерация текста");
            config.captionMode = mode; await saveConfig(env, config);
            await tg.send(chatId, `✅ Режим подписи изменен на: ${mode}`);
            break;

        case "/setcaptionprompt":
            if (!params.length) return await tg.send(chatId, "❌ /setcaptionprompt <инструкция для ИИ>");
            config.captionPrompt = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `✅ Инструкция для подписей обновлена!`);
            break;

        case "/setenhancer":
            const enh = params[0]?.toLowerCase();
            if (enh === "clear") {
                config.postProcessors = []; await tg.send(chatId, "✅ Улучшайзеры сброшены");
            } else if (enh === "facefix") {
                config.postProcessors = ["GFPGAN"]; await tg.send(chatId, "✅ Включен FaceFix (GFPGAN)");
            } else if (enh === "upscale") {
                config.postProcessors = ["RealESRGAN_x4plus"]; await tg.send(chatId, "✅ Включен Upscale (RealESRGAN_x4plus)");
            } else {
                if (enh && !["facefix", "upscale", "clear"].includes(enh)) {
                    config.postProcessors = [params[0]]; await tg.send(chatId, `✅ Включен кастомный улучшайзер: ${params[0]}`);
                } else {
                    await tg.send(chatId, "❌ /setenhancer <FaceFix | Upscale | clear>");
                }
            }
            await saveConfig(env, config);
            break;

        case "/setmodel":
            if (!params.length) return await tg.send(chatId, "❌ /setmodel &lt;имя&gt;");
            config.model = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `✅ Модель: <code>${escapeHtml(config.model)}</code>`);
            break;

        case "/listmodels":
            await tg.send(chatId, "⏳ Загружаю топ-40 моделей...");
            try {
                const models = (await hordeGetModels() || []).filter(m => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 40);
                let text = "📋 <b>Модели (топ-40):</b>\n\n";
                models.forEach(m => text += `${m.name?.includes("XL") ? "🟢" : "⚪"} <code>${escapeHtml(m.name)}</code> (${m.count}w)\n`);
                await tg.send(chatId, text);
            } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
            break;

        case "/searchmodel":
            const qm = params.join(" ").toLowerCase();
            if (!qm) return await tg.send(chatId, "❌ /searchmodel <запрос>");
            try {
                const models = (await hordeGetModels() || []).filter(m => m.name.toLowerCase().includes(qm)).sort((a, b) => b.count - a.count).slice(0, 20);
                if (!models.length) return await tg.send(chatId, "😕 Ничего не найдено");
                let text = `🔍 <b>Найдено (${models.length}):</b>\n\n`;
                models.forEach(m => text += `<code>${escapeHtml(m.name)}</code> (${m.count}w)\n`);
                await tg.send(chatId, text);
            } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
            break;

        case "/searchlora":
            const ql = params.join(" ");
            if (!ql) return await tg.send(chatId, "❌ /searchlora <запрос>");
            try {
                const res = await fetch(`https://civitai.com/api/v1/models?query=${encodeURIComponent(ql)}&limit=10`);
                const data = await res.json();
                if (!data.items || !data.items.length) return await tg.send(chatId, "😕 Ничего не найдено");
                let text = `🔍 <b>Найдено LoRA:</b>\n\n`;
                data.items.forEach(m => text += `<code>${m.id}</code> - ${escapeHtml(m.name)}\n`);
                await tg.send(chatId, text);
            } catch (e) { await tg.send(chatId, "❌ Ошибка поиска: " + e.message); }
            break;

        case "/addlora":
            if (!params.length) return await tg.send(chatId, "❌ /addlora <ID> [strength=1] [clip=1]");
            const loraId = params[0];
            const loraStr = parseFloat(params[1] || 1);
            const loraClip = parseFloat(params[2] || 1);
            if (!config.loras) config.loras = [];
            config.loras.push({ name: loraId, strength: loraStr, clip: loraClip });
            await saveConfig(env, config);
            await tg.send(chatId, `✅ LoRA <code>${loraId}</code> добавлена!`);
            break;

        case "/listloras":
            if (!config.loras || !config.loras.length) return await tg.send(chatId, "📋 Список LoRA пуст. Добавь через /addlora.");
            let lt = "📋 <b>Активные LoRA:</b>\n\n";
            config.loras.forEach((l, i) => lt += `${i + 1}. ID: <code>${l.name}</code> (str: ${l.strength}, clip: ${l.clip})\n`);
            lt += "\nОчистить список: /clearloras";
            await tg.send(chatId, lt);
            break;

        case "/clearloras":
            config.loras = []; await saveConfig(env, config);
            await tg.send(chatId, "✅ Список LoRA очищен!");
            break;

        case "/setsampler":
            if (!params[0]) return await tg.send(chatId, "❌ /setsampler <имя>");
            config.sampler = params[0]; await saveConfig(env, config);
            await tg.send(chatId, `✅ Sampler: ${config.sampler}`);
            break;

        case "/setcfg":
            if (!params[0]) return await tg.send(chatId, "❌ /setcfg <число>");
            config.cfgScale = parseFloat(params[0]); await saveConfig(env, config);
            await tg.send(chatId, `✅ CFG: ${config.cfgScale}`);
            break;

        case "/setsteps":
            if (!params[0]) return await tg.send(chatId, "❌ /setsteps <число>");
            config.steps = parseInt(params[0]); await saveConfig(env, config);
            await tg.send(chatId, `✅ Steps: ${config.steps}`);
            break;

        case "/setneg":
            if (!params.length) return await tg.send(chatId, "❌ /setneg <текст>");
            config.negativePrompt = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `✅ Негативный промпт сохранён`);
            break;

        case "/setllm":
            if (!params.length) return await tg.send(chatId, "❌ /setllm <модель>");
            config.llmModel = params.join(" "); await saveConfig(env, config);
            await tg.send(chatId, `✅ LLM Модель: <code>${config.llmModel}</code>`);
            break;

        case "/setinterval":
            const inv = parseInt(params[0]);
            if (inv > 0) { config.interval = inv; await saveConfig(env, config); await tg.send(chatId, `✅ Интервал: ${inv} мин`); }
            break;

        case "/setcount":
            const cnt = parseInt(params[0]);
            if (cnt > 0 && cnt <= 10) { config.count = cnt; await saveConfig(env, config); await tg.send(chatId, `✅ Количество: ${cnt}`); }
            break;

        case "/setsize":
            const w = parseInt(params[0]); const h = parseInt(params[1]);
            if (w > 255 && h > 255) { config.width = 64 * Math.round(w/64); config.height = 64 * Math.round(h/64); await saveConfig(env, config); await tg.send(chatId, `✅ Размер: ${config.width}x${config.height}`); }
            break;

        case "/enable":
            if (!config.groupId && !config.channelId) return await tg.send(chatId, "❌ Сначала привяжи группу (/setgroup) или канал (/setchannel)");
            config.enabled = true; await saveConfig(env, config);
            await tg.send(chatId, `🟢 Автопостинг включен!`);
            break;

        case "/disable":
            config.enabled = false; await saveConfig(env, config);
            await tg.send(chatId, "🔴 Автопостинг выключен");
            break;

        case "/generate":
            if (!config.generalPrompt) return await tg.send(chatId, "❌ Сначала задай промпт через /setprompt");
            await tg.send(chatId, `⏳ Генерирую ${config.count} фото...`);
            const bl = (await getWorkerBlacklist(env)).map(w => w.id).filter(Boolean);

            for (let i = 0; i < config.count; i++) {
                try {
                    const finalPrompt = await generatePrompt(config.generalPrompt, env, config);
                    await tg.send(chatId, `🎨 #${i + 1}:\n<code>${escapeHtml(finalPrompt.substring(0, 300))}</code>`);
                    const res = await hordeSubmit(finalPrompt, config, env, { workerBlacklist: bl });
                    if (res.id) {
                        await KV.put(env, `pending:${res.id}`, { targets: [chatId], prompt: finalPrompt, at: Date.now(), notify: chatId, retries: 0 }, { expirationTtl: 3600 });
                        await tg.send(chatId, `📤 ID: <code>${res.id}</code>`);
                    } else {
                        await tg.send(chatId, `❌ Horde: ${escapeHtml(JSON.stringify(res))}`);
                    }
                } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
            }
            break;

        case "/status":
            let queueCount = 0;
            try { queueCount = (await KV.list(env, "pending:")).keys.length; } catch {}
            const pps = config.postProcessors?.length ? config.postProcessors.join(", ") : "нет";

            await tg.send(chatId, `📊 <b>Статус</b>\n\n<b>Автопост:</b> ${config.enabled ? "🟢" : "🔴"}\n<b>Группа:</b> ${config.groupId || "❌"}\n<b>Канал:</b> ${config.channelId || "❌"}\n<b>Улучшайзеры:</b> ${pps}\n<b>Режим подписи:</b> ${config.captionMode}\n\n<b>Промпт:</b>\n<code>${escapeHtml(config.generalPrompt)}</code>\n\n<b>Модель:</b> <code>${escapeHtml(config.model)}</code>\n<b>Семплер:</b> <code>${escapeHtml(config.sampler)}</code>\n<b>Размер:</b> ${config.width}x${config.height}\n<b>LLM:</b> <code>${escapeHtml(config.llmModel)}</code>\n<b>Очередь:</b> ${queueCount}`);
            break;

        case "/pending":
            try {
                const pendList = await KV.list(env, "pending:");
                await tg.send(chatId, `⏳ В очереди: ${pendList.keys.length} генераций`);
            } catch (e) { await tg.send(chatId, `❌ Ошибка: ${e.message}`); }
            break;

        case "/cancel":
            try {
                const plist = await KV.list(env, "pending:");
                let canceled = 0;
                for (let k of plist.keys) {
                    await KV.del(env, k.name);
                    canceled++;
                }
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
            if (Date.now() - task.at > 1200000) {
                await KV.del(env, keyObj.name);
                if (task.notify) await tg.send(task.notify, `⏰ Таймаут: <code>${id}</code>`);
                continue;
            }

            const check = await hordeCheck(id);
            if (!check.done) continue;

            const res = await hordeGetResult(id);
            await KV.del(env, keyObj.name);

            if (res.faulted) {
                if (task.notify) await tg.send(task.notify, `❌ Ошибка генерации: <code>${id}</code>`);
                continue;
            }

            const gens = res.generations || [];
            if (!gens.length) continue;

            let success = false;
            let censored = false;

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

                const targets = task.targets || [];
                for (const tId of targets) {
                    const { sent, tooSmall } = await deliverImage(tg, tId, gen.img, captionText, task.notify);
                    if (sent) success = true;
                    if (tooSmall) {
                        censored = true;
                        await addWorkerToBlacklist(env, wId, wName);
                    }
                }
            }

            if (censored && !success && !task.sfwTest) {
                const retries = (task.retries || 0) + 1;
                if (retries < 3) {
                    const bl = (await getWorkerBlacklist(env)).map(w => w.id).filter(Boolean);
                    const newRes = await hordeSubmit(task.prompt, config, env, { workerBlacklist: bl });
                    if (newRes.id) {
                        await KV.put(env, `pending:${newRes.id}`, { ...task, at: Date.now(), retries });
                        if (task.notify) await tg.send(task.notify, `🔄 Ретрай ${retries}/3...`);
                    }
                } else if (task.notify) {
                    await tg.send(task.notify, "❌ 3 попытки неудачны. Возможно стоит анонимный ключ (NSFW запрещен) или модель цензурит этот промпт.");
                }
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
            }
        } catch (e) {
            console.error("[CRON] Auto-post error:", e.message);
        }
    }
}

export default {
    async fetch(req, env) {
        const url = new URL(req.url);

        if (url.pathname === "/webhook") {
            if (req.method !== "POST") return new Response("POST only", { status: 405 });
            try {
                const body = await req.json();
                if (body.message?.text) await handleCommand(body.message, env);
            } catch (e) { console.error("[WH]", e.message); }
            return new Response("OK");
        }

        if (url.pathname === "/setup") {
            if (!env.TELEGRAM_BOT_TOKEN) return new Response("No TELEGRAM_BOT_TOKEN!", { status: 500 });
            const webhookUrl = `${url.origin}/webhook`;
            const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message"], drop_pending_updates: true })
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