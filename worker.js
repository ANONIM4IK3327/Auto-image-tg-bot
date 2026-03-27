// Configuration
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
    cfgScale: 7.5,
    sampler: "k_dpmpp_2m",
    nsfw: true,
    negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
    llmModel: "",
    clipSkip: 2,
    hiresFix: false,
    hiresFixDenoising: 0.65,
    karras: true,
    
    // Post-processing
    postProcessing: {
        faceRestore: null, // "GFPGAN", "CodeFormers"
        faceRestoreStrength: 0.8,
        upscale: null, // "RealESRGAN_x4plus", "RealESRGAN_x2plus", etc.
        upscaleStrength: 1.0
    },
    
    // Auto-post caption mode: 0 = no caption, 1 = prompt only, 2 = AI-generated
    captionMode: 1,
    captionPrompt: "", // Initial instruction for AI caption generation
    
    // Advanced settings
    tiling: false,
    seed: -1,
    workerBlacklist: [],
    trustedWorkers: false,
    allowDowngrade: true,
    replacementFilter: true
};

const HORDE_API = "https://stablehorde.net/api/v2";
const HORDE_HEADERS = {
    "Client-Agent": "TgImageBot:15.0:tg"
};

// Upstash Redis functions
const Redis = {
    async get(key, type = "text") {
        if (!globalThis.UPSTASH_REDIS_REST_URL || !globalThis.UPSTASH_REDIS_REST_TOKEN) {
            console.error("[Redis] Not configured");
            return null;
        }
        try {
            const response = await fetch(globalThis.UPSTASH_REDIS_REST_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${globalThis.UPSTASH_REDIS_REST_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(["GET", key])
            });
            const result = await response.json();
            if (result.error) throw new Error(result.error);
            
            const data = result[1];
            if (data === null) return null;
            
            if (type === "json") {
                try {
                    return JSON.parse(data);
                } catch {
                    return data;
                }
            }
            return data;
        } catch (e) {
            console.error("[Redis] GET error:", e.message);
            return null;
        }
    },
    
    async set(key, value, options = {}) {
        if (!globalThis.UPSTASH_REDIS_REST_URL || !globalThis.UPSTASH_REDIS_REST_TOKEN) {
            throw new Error("Redis not configured");
        }
        try {
            const val = typeof value === "object" ? JSON.stringify(value) : String(value);
            const commands = ["SET", key, val];
            
            if (options.expirationTtl) {
                commands.push("EX", options.expirationTtl);
            }
            
            const response = await fetch(globalThis.UPSTASH_REDIS_REST_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${globalThis.UPSTASH_REDIS_REST_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(commands)
            });
            const result = await response.json();
            if (result.error) throw new Error(result.error);
            return result;
        } catch (e) {
            console.error("[Redis] SET error:", e.message);
            throw e;
        }
    },
    
    async del(key) {
        if (!globalThis.UPSTASH_REDIS_REST_URL || !globalThis.UPSTASH_REDIS_REST_TOKEN) return;
        try {
            const response = await fetch(globalThis.UPSTASH_REDIS_REST_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${globalThis.UPSTASH_REDIS_REST_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(["DEL", key])
            });
            return await response.json();
        } catch (e) {
            console.error("[Redis] DEL error:", e.message);
        }
    },
    
    async scan(pattern, count = 100) {
        if (!globalThis.UPSTASH_REDIS_REST_URL || !globalThis.UPSTASH_REDIS_REST_TOKEN) {
            return { keys: [] };
        }
        try {
            const response = await fetch(globalThis.UPSTASH_REDIS_REST_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${globalThis.UPSTASH_REDIS_REST_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(["KEYS", pattern])
            });
            const result = await response.json();
            if (result.error) throw new Error(result.error);
            return { keys: result[1] || [] };
        } catch (e) {
            console.error("[Redis] SCAN error:", e.message);
            return { keys: [] };
        }
    },
    
    async hgetall(key) {
        if (!globalThis.UPSTASH_REDIS_REST_URL || !globalThis.UPSTASH_REDIS_REST_TOKEN) return {};
        try {
            const response = await fetch(globalThis.UPSTASH_REDIS_REST_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${globalThis.UPSTASH_REDIS_REST_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(["HGETALL", key])
            });
            const result = await response.json();
            if (result.error) throw new Error(result.error);
            
            const obj = {};
            const arr = result[1] || [];
            for (let i = 0; i < arr.length; i += 2) {
                obj[arr[i]] = arr[i + 1];
            }
            return obj;
        } catch (e) {
            console.error("[Redis] HGETALL error:", e.message);
            return {};
        }
    }
};

// Utility functions
function escapeHtml(text) {
    if (text == null) return " ";
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function isHttpUrl(str) {
    return typeof str === "string" && /^https?:\/\//i.test(str);
}

function getApiKey(env) {
    return (env.HORDE_API_KEY || "").trim() || "0000000000";
}

// Telegram Bot with inline keyboards
class Telegram {
    constructor(token) {
        this.base = `https://api.telegram.org/bot${token}`;
    }
    
    async api(method, params = {}) {
        const response = await fetch(`${this.base}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params)
        });
        return await response.json();
    }
    
    send(chatId, text, options = {}) {
        return this.api("sendMessage", {
            chat_id: chatId,
            text: text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...options
        });
    }
    
    async sendPhoto(chatId, buffer, caption = "", options = {}) {
        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        formData.append("photo", new File([buffer], "image.webp", { type: "image/webp" }));
        if (caption) {
            formData.append("caption", caption.substring(0, 1024));
            formData.append("parse_mode", "HTML");
        }
        const response = await fetch(`${this.base}/sendPhoto`, {
            method: "POST",
            body: formData
        });
        return await response.json();
    }
    
    sendPhotoUrl(chatId, url, caption = "", options = {}) {
        return this.api("sendPhoto", {
            chat_id: chatId,
            photo: url,
            caption: caption?.substring(0, 1024),
            parse_mode: "HTML",
            ...options
        });
    }
    
    editMessage(chatId, messageId, text, options = {}) {
        return this.api("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...options
        });
    }
    
    answerCallback(callbackQueryId, text, showAlert = false) {
        return this.api("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: text,
            show_alert: showAlert
        });
    }
}

// Inline keyboard builder
class InlineKeyboard {
    constructor() {
        this.rows = [];
        this.currentRow = [];
    }
    
    add(text, callbackData, url = null) {
        this.currentRow.push({
            text,
            callback_data: callbackData,
            url: url || undefined
        });
        return this;
    }
    
    row() {
        if (this.currentRow.length > 0) {
            this.rows.push([...this.currentRow]);
            this.currentRow = [];
        }
        return this;
    }
    
    build() {
        if (this.currentRow.length > 0) {
            this.rows.push([...this.currentRow]);
        }
        return { inline_keyboard: this.rows };
    }
}

// AI Horde functions
async function hordeCheckKey(env) {
    const apiKey = getApiKey(env);
    try {
        const response = await fetch(`${HORDE_API}/find_user`, {
            headers: {
                apikey: apiKey,
                ...HORDE_HEADERS
            }
        });
        
        if (response.status === 401 || response.status === 403) {
            return { ok: false, anon: apiKey === "0000000000" };
        }
        
        const data = await response.json();
        return {
            ok: true,
            anon: apiKey === "0000000000",
            user: data.username,
            kudos: data.kudos,
            trusted: data.trusted,
            flagged: data.flagged
        };
    } catch (e) {
        return { ok: false, anon: apiKey === "0000000000", err: e.message };
    }
}

async function hordeSubmit(prompt, config, env, options = {}) {
    const apiKey = getApiKey(env);
    
    const params = {
        sampler_name: config.sampler,
        cfg_scale: config.cfgScale,
        width: config.width,
        height: config.height,
        steps: config.steps,
        karras: config.karras !== false,
        clip_skip: config.clipSkip || 2,
        tiling: config.tiling || false,
        post_processing: [],
        n: 1
    };
    
    // Add hires fix
    if (config.hiresFix) {
        params.hires_fix = true;
        params.hires_fix_denoising_strength = config.hiresFixDenoising || 0.65;
    }
    
    // Add post-processing
    if (config.postProcessing) {
        if (config.postProcessing.faceRestore) {
            params.post_processing.push(config.postProcessing.faceRestore);
            if (config.postProcessing.faceRestoreStrength) {
                params.post_processing.push(`strength:${config.postProcessing.faceRestoreStrength}`);
            }
        }
        if (config.postProcessing.upscale) {
            params.post_processing.push(config.postProcessing.upscale);
            if (config.postProcessing.upscaleStrength) {
                params.post_processing.push(`strength:${config.postProcessing.upscaleStrength}`);
            }
        }
    }
    
    // Add LoRAs
    if (!options.skipLoras && config.loras?.length > 0) {
        params.loras = config.loras.map(lora => ({
            name: String(lora.name),
            model: lora.strength ?? 1,
            clip: lora.clip ?? 1,
            inject_trigger: "any",
            is_version: true
        }));
    }
    
    // Add seed
    if (config.seed && config.seed !== -1) {
        params.seed = config.seed;
    }
    
    const body = {
        prompt: config.negativePrompt ? `${prompt} ### ${config.negativePrompt}` : prompt,
        params: params,
        nsfw: config.nsfw !== false,
        censor_nsfw: false,
        trusted_workers: config.trustedWorkers || false,
        replacement_filter: config.replacementFilter !== false,
        models: [config.model],
        r2: true,
        shared: false,
        allow_downgrade: config.allowDowngrade !== false
    };
    
    // Add worker blacklist
    if (options.workerBlacklist?.length > 0) {
        body.workers = options.workerBlacklist.slice(0, 5);
        body.worker_blacklist = true;
    }
    
    const response = await fetch(`${HORDE_API}/generate/async`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            apikey: apiKey,
            ...HORDE_HEADERS
        },
        body: JSON.stringify(body)
    });
    
    return await response.json();
}

async function hordeCheck(id) {
    const response = await fetch(`${HORDE_API}/generate/check/${id}`, {
        headers: HORDE_HEADERS
    });
    return await response.json();
}

async function hordeGetResult(id) {
    const response = await fetch(`${HORDE_API}/generate/status/${id}`, {
        headers: HORDE_HEADERS
    });
    return await response.json();
}

async function hordeGetModels() {
    const response = await fetch(`${HORDE_API}/status/models?type=image`, {
        headers: HORDE_HEADERS
    });
    return await response.json();
}

async function hordeGetWorkers() {
    const response = await fetch(`${HORDE_API}/workers`, {
        headers: HORDE_HEADERS
    });
    return await response.json();
}

// Config management
async function getConfig(env) {
    const stored = await Redis.get("config", "json");
    return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function saveConfig(env, config) {
    await Redis.set("config", config);
}

// Prompt enhancement with LLM
const PROMPT_DIRECTIVES = {
    "focus on unusual creative perspective": "Emphasize unique viewpoint and composition",
    "emphasize dramatic lighting": "Add strong contrast and shadows",
    "place in unexpected environment": "Put subject in surprising setting",
    "focus on intricate textures": "Highlight detailed surfaces and materials",
    "use bold unconventional colors": "Apply vibrant unusual color palette",
    "capture dynamic motion": "Show movement and energy",
    "create atmospheric scene": "Add mood and ambiance",
    "use extreme framing": "Very close-up or very wide shot",
    "cinematic composition": "Movie-like framing and style",
    "add weather effects": "Include rain, snow, fog, etc.",
    "focus on reflections": "Emphasize mirrors and reflective surfaces",
    "futuristic aesthetic": "Apply sci-fi futuristic style"
};

function parsePromptDirectives(basePrompt) {
    const directives = [];
    let cleanPrompt = basePrompt;
    
    // Extract directives from [brackets]
    const regex = /\[([^\]]+)\]/g;
    let match;
    while ((match = regex.exec(basePrompt)) !== null) {
        const directive = match[1].toLowerCase().trim();
        directives.push(directive);
        cleanPrompt = cleanPrompt.replace(match[0], "");
    }
    
    return {
        cleanPrompt: cleanPrompt.trim(),
        directives: directives
    };
}

async function enhancePromptWithLLM(basePrompt, env) {
    const { cleanPrompt, directives } = parsePromptDirectives(basePrompt);
    
    // Build instruction based on directives
    let instruction = "You are a Stable Diffusion prompt engineer. Output ONLY comma-separated descriptive phrases. No explanations, no quotes, no markdown. Under 100 words. Be creative and unique.";
    
    if (directives.length > 0) {
        instruction += ` Apply these modifications: ${directives.join(", ")}.`;
    } else {
        // Random directive if none specified
        const randomDirective = Object.values(PROMPT_DIRECTIVES)[Math.floor(Math.random() * Object.keys(PROMPT_DIRECTIVES).length)];
        instruction += ` ${randomDirective}`;
    }
    
    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return generateTemplatePrompt(cleanPrompt);
    }
    
    try {
        const config = await getConfig(env);
        const model = config.llmModel || env.LLM_MODEL || "google/gemma-2-9b-it:free";
        
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
                "HTTP-Referer": "https://t.me",
                "X-Title": "TgImageBot"
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: instruction },
                    { role: "user", content: `Create a unique detailed image generation prompt for: ${cleanPrompt}` }
                ],
                temperature: 1.3,
                max_tokens: 200
            })
        });
        
        const data = await response.json();
        const enhanced = data.choices?.[0]?.message?.content?.trim()
            .replace(/^["'`*]+|["'`*]+$/g, "");
        
        if (enhanced?.length > 10) {
            return enhanced;
        }
    } catch (e) {
        console.error("[LLM] Error:", e.message);
    }
    
    return generateTemplatePrompt(cleanPrompt);
}

function generateTemplatePrompt(basePrompt) {
    const angles = ["from above", "low angle", "eye level", "dutch angle", "bird's eye view", "extreme close-up", "wide establishing shot"];
    const lighting = ["golden hour sunlight", "dramatic chiaroscuro", "soft overcast light", "neon cyberpunk glow", "moonlit night", "studio rim lighting"];
    const styles = ["photorealistic photography", "digital concept art", "oil painting", "anime cel shading", "dark fantasy illustration", "hyperrealistic 8k render"];
    const moods = ["serene and peaceful", "intense and dramatic", "mysterious and enigmatic", "vibrant and energetic", "ethereal and dreamlike"];
    
    const parts = [
        basePrompt,
        angles[Math.floor(Math.random() * angles.length)],
        lighting[Math.floor(Math.random() * lighting.length)],
        styles[Math.floor(Math.random() * styles.length)],
        moods[Math.floor(Math.random() * moods.length)],
        "masterpiece", "best quality", "highly detailed"
    ];
    
    return parts.join(", ");
}

// Generate AI caption for post
async function generateAICaption(prompt, imageDescription, env) {
    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) return prompt;
    
    const config = await getConfig(env);
    const customInstruction = config.captionPrompt || "Describe this image in an engaging way for social media.";
    
    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
                "HTTP-Referer": "https://t.me",
                "X-Title": "TgImageBot"
            },
            body: JSON.stringify({
                model: "google/gemma-2-9b-it:free",
                messages: [
                    { role: "system", content: `${customInstruction} Keep it under 150 words. Be creative and engaging.` },
                    { role: "user", content: `Image prompt: ${prompt}\n\nDescription: ${imageDescription}` }
                ],
                temperature: 0.9,
                max_tokens: 250
            })
        });
        
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || prompt;
    } catch (e) {
        console.error("[Caption AI] Error:", e.message);
        return prompt;
    }
}

// Download and process images
async function downloadImage(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.arrayBuffer();
    } catch (e) {
        console.error("[IMG] Fetch error:", e.message);
        return null;
    }
}

function base64ToBuffer(base64) {
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (e) {
        console.error("[IMG] Base64 error:", e.message);
        return null;
    }
}

function bufferSizeKB(buffer) {
    return Math.round(buffer.byteLength / 1024);
}

// Check if image is censored
function isCensored(gen) {
    if (!gen) return false;
    
    const hasMetadataCensorship = gen.gen_metadata?.some(m => m.type === "censorship");
    const isExplicitlyCensored = gen.censored === true;
    const isCensoredState = gen.state === "censored";
    
    return hasMetadataCensorship || isExplicitlyCensored || isCensoredState;
}

// Deliver image to chat
async function deliverImage(bot, chatId, imageData, caption, notifyChat) {
    if (!imageData) {
        if (notifyChat) await bot.send(notifyChat, "❌ No image data from worker");
        return { sent: false, tooSmall: false, sizeKB: 0 };
    }
    
    let buffer = null;
    const isUrl = isHttpUrl(imageData);
    
    if (isUrl) {
        // Try send URL directly first
        const result = await bot.sendPhotoUrl(chatId, imageData, caption);
        if (result.ok) {
            return { sent: true, tooSmall: false, sizeKB: 0 };
        }
        // If failed, download and send as buffer
        buffer = await downloadImage(imageData);
        if (!buffer) {
            return { sent: false, tooSmall: false, sizeKB: 0 };
        }
    } else {
        buffer = base64ToBuffer(imageData);
        if (!buffer) {
            return { sent: false, tooSmall: false, sizeKB: 0 };
        }
    }
    
    const sizeKB = bufferSizeKB(buffer);
    
    // Check for placeholder/censored images
    if (sizeKB < 10) {
        if (notifyChat) {
            await bot.send(notifyChat, `🚫 <b>Placeholder/censored image</b>\nSize: ${sizeKB}KB (min: 10KB)`);
        }
        return { sent: false, tooSmall: true, sizeKB: sizeKB };
    }
    
    // Try send as photo
    let result = await bot.sendPhoto(chatId, buffer, caption);
    
    if (!result.ok) {
        console.log("[IMG] sendPhoto failed, trying sendDocument");
        // Try as document
        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        formData.append("document", new File([buffer], "image.webp", { type: "image/webp" }));
        if (caption) {
            formData.append("caption", caption.substring(0, 1024));
            formData.append("parse_mode", "HTML");
        }
        
        const response = await fetch(`${bot.base}/sendDocument`, {
            method: "POST",
            body: formData
        });
        result = await response.json();
    }
    
    if (!result.ok && isUrl) {
        // Last resort: try URL again
        await bot.sendPhotoUrl(chatId, imageData, caption);
    }
    
    if (!result.ok && notifyChat) {
        await bot.send(notifyChat, `❌ Failed to send image: ${escapeHtml(result.description || "unknown error")}`);
    }
    
    return { sent: result.ok, tooSmall: false, sizeKB: sizeKB };
}

// Add worker to blacklist
async function addWorkerToBlacklist(env, workerId, workerName) {
    if (!workerId || workerId === "?" || String(workerId).length < 10) return;
    
    let blacklist = await Redis.get("worker_blacklist", "json") || [];
    
    if (!blacklist.find(w => w.id === workerId)) {
        blacklist.push({
            id: workerId,
            name: workerName || "?",
            t: Date.now()
        });
        
        // Keep only last 30
        while (blacklist.length > 30) {
            blacklist.shift();
        }
        
        await Redis.set("worker_blacklist", blacklist);
        console.log(`[BL] Added worker: ${workerName} (${workerId})`);
    }
}

async function clearWorkerBlacklist(env) {
    await Redis.set("worker_blacklist", []);
}

// Command handlers with inline keyboards
async function handleCommand(message, env) {
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const text = message.text || "";
    
    if (!env.TELEGRAM_BOT_TOKEN) return;
    
    const bot = new Telegram(env.TELEGRAM_BOT_TOKEN);
    const parts = text.split(/\s+/);
    const cmd = parts[0].split("@")[0].toLowerCase();
    const args = parts.slice(1);
    
    // Public commands
    if (cmd === "/ping") {
        const apiKey = getApiKey(env);
        await bot.send(chatId, 
            `🏓 <b>Pong!</b>\n\n` +
            `📍 Chat: <code>${chatId}</code>\n` +
            `👤 User: <code>${userId}</code>\n` +
            `💾 Redis: ${env.UPSTASH_REDIS_REST_URL ? "✅" : "❌"}\n` +
            `🎨 Horde: ${apiKey === "0000000000" ? "🔴 anonymous" : "✅ " + apiKey.substring(0, 8) + "..."}`
        );
        return;
    }
    
    if (cmd === "/start" || cmd === "/help") {
        const config = await getConfig(env);
        
        // Set admin if not set
        if (!config.adminId) {
            config.adminId = userId;
            await saveConfig(env, config);
            await bot.send(chatId, `👑 You are now admin. ID: <code>${userId}</code>`);
        }
        
        const keyboard = new InlineKeyboard()
            .add("⚙️ Settings", "menu_settings").row()
            .add("🎨 Models", "menu_models")
            .add("🔧 LoRA", "menu_lora").row()
            .add("📊 Status", "cmd_status")
            .add("🚀 Generate", "cmd_generate").row()
            .add("🔄 Auto-post: " + (config.enabled ? "ON" : "OFF"), "cmd_toggle_auto").row()
            .add("📋 Queue", "cmd_pending")
            .add("❌ Cancel All", "cmd_cancel").row()
            .add("🔑 Check Key", "cmd_checkkey")
            .add("🔧 Diagnostics", "cmd_diagnostic").row()
            .build();
        
        await bot.send(chatId, 
            "🤖 <b>Telegram Image Bot</b>\n\n" +
            "Use buttons below or commands:\n\n" +
            "<b>Quick Commands:</b>\n" +
            "/setchat - Set target chat\n" +
            "/setprompt <text> - Set main theme\n" +
            "/generate - Generate now\n" +
            "/enable | /disable - Toggle auto"
        , { reply_markup: keyboard });
        return;
    }
    
    // Check admin
    const config = await getConfig(env);
    if (!config.adminId) {
        config.adminId = userId;
        await saveConfig(env, config);
    }
    
    if (config.adminId !== userId) {
        await bot.send(chatId, `🔒 Admin only (ID: ${config.adminId})`);
        return;
    }
    
    // Admin commands
    switch (cmd) {
        case "/setchat":
            config.chatId = chatId;
            await saveConfig(env, config);
            await bot.send(chatId, `✅ Target chat set: <code>${chatId}</code>`);
            break;
            
        case "/setprompt":
            const prompt = args.join(" ");
            if (!prompt) {
                await bot.send(chatId, "❌ /setprompt <theme>");
                return;
            }
            config.generalPrompt = prompt;
            await saveConfig(env, config);
            await bot.send(chatId, `✅ Prompt:\n<code>${escapeHtml(prompt)}</code>\n\n💡 Use [directives] to modify prompt:\n[focus on dramatic lighting]\n[use extreme close-up]\n[add weather effects]`);
            break;
            
        case "/setinterval":
            const interval = parseInt(args[0], 10);
            if (isNaN(interval) || interval < 1) {
                await bot.send(chatId, "❌ /setinterval <minutes> (min 1)");
                return;
            }
            config.interval = interval;
            await saveConfig(env, config);
            await bot.send(chatId, `✅ Interval: ${interval} min`);
            break;
            
        case "/setcount":
            const count = parseInt(args[0], 10);
            if (isNaN(count) || count < 1 || count > 10) {
                await bot.send(chatId, "❌ /setcount <1-10>");
                return;
            }
            config.count = count;
            await saveConfig(env, config);
            await bot.send(chatId, `✅ Count: ${count}`);
            break;
            
        case "/enable":
            if (!config.chatId) {
                await bot.send(chatId, "❌ First: /setchat");
                return;
            }
            if (!config.generalPrompt) {
                await bot.send(chatId, "❌ First: /setprompt");
                return;
            }
            config.enabled = true;
            await saveConfig(env, config);
            await bot.send(chatId, `🟢 Auto-posting enabled!\nInterval: ${config.interval} min\nCount: ${config.count}`);
            break;
            
        case "/disable":
            config.enabled = false;
            await saveConfig(env, config);
            await bot.send(chatId, "🔴 Auto-posting disabled");
            break;
            
        case "/generate":
            if (!config.generalPrompt) {
                await bot.send(chatId, "❌ First: /setprompt");
                return;
            }
            
            const targetChat = config.chatId || chatId;
            await bot.send(chatId, `⏳ Generating ${config.count} images...`);
            
            const blacklist = (await Redis.get("worker_blacklist", "json") || []).map(w => w.id).filter(Boolean);
            
            for (let i = 0; i < config.count; i++) {
                try {
                    const enhancedPrompt = await enhancePromptWithLLM(config.generalPrompt, env);
                    await bot.send(chatId, `🎨 #${i + 1}:\n<code>${escapeHtml(enhancedPrompt.substring(0, 300))}</code>`);
                    
                    const result = await hordeSubmit(enhancedPrompt, config, env, { workerBlacklist: blacklist });
                    
                    if (result.id) {
                        await Redis.set(`pending:${result.id}`, {
                            chatId: targetChat,
                            prompt: enhancedPrompt,
                            at: Date.now(),
                            notify: chatId,
                            retries: 0
                        }, { expirationTtl: 3600 });
                        
                        await bot.send(chatId, `📤 ID: <code>${result.id}</code>`);
                    } else {
                        await bot.send(chatId, `❌ Horde: <code>${escapeHtml(JSON.stringify(result).substring(0, 300))}</code>`);
                    }
                } catch (e) {
                    await bot.send(chatId, `❌ ${escapeHtml(e.message)}`);
                }
            }
            break;
            
        case "/status":
        case "/pending":
        case "/cancel":
        case "/checkkey":
        case "/diagnostic":
        case "/setmodel":
        case "/listmodels":
        case "/searchlora":
        case "/addlora":
        case "/removelora":
        case "/listloras":
        case "/setsize":
        case "/setsteps":
        case "/setcfg":
        case "/setsampler":
        case "/setneg":
        case "/setclipskip":
        case "/setllm":
        case "/workerbl":
        case "/clearworkerbl":
            // These will be handled by callback queries
            await bot.send(chatId, `⚙️ Use inline keyboard buttons or type /help for menu`);
            break;
            
        default:
            if (cmd.startsWith("/")) {
                await bot.send(chatId, "❓ Unknown command — /help");
            }
    }
}

// Callback query handler
async function handleCallback(callbackQuery, env) {
    const bot = new Telegram(env.TELEGRAM_BOT_TOKEN);
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    
    const config = await getConfig(env);
    
    try {
        // Main menu
        if (data === "menu_settings") {
            const keyboard = new InlineKeyboard()
                .add("💬 Chat: " + (config.chatId ? "✅" : "❌"), "set_chat").row()
                .add("📝 Prompt", "set_prompt")
                .add("⏱️ Interval", "set_interval").row()
                .add("🔢 Count", "set_count")
                .add("🎯 Model", "set_model").row()
                .add("📐 Size", "set_size")
                .add("🔁 Steps", "set_steps").row()
                .add("⚖️ CFG", "set_cfg")
                .add("🎲 Sampler", "set_sampler").row()
                .add("🎨 Negative", "set_negative").row()
                .add("🔙 Back", "menu_main").row()
                .build();
            
            await bot.editMessage(chatId, messageId, "⚙️ <b>Settings Menu</b>", { reply_markup: keyboard });
            await bot.answerCallback(callbackQuery.id, "");
        }
        else if (data === "menu_models") {
            await bot.answerCallback(callbackQuery.id, "⏳ Loading models...");
            
            try {
                const models = await hordeGetModels();
                const modelList = (Array.isArray(models) ? models : [])
                    .filter(m => m.count > 0)
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 40);
                
                let text = "📋 <b>Top 40 Models</b>\n\n";
                modelList.forEach((m, i) => {
                    const isSdxl = m.name?.includes("XL") || m.name?.includes("SDXL");
                    text += `${i + 1}. ${isSdxl ? "🟢" : "⚪"} <code>${escapeHtml(m.name)}</code> (${m.count}w)\n`;
                });
                text += "\n🟢 = SDXL  ⚪ = SD1.5";
                
                const keyboard = new InlineKeyboard()
                    .add("🔙 Back", "menu_main")
                    .build();
                
                await bot.editMessage(chatId, messageId, text, { reply_markup: keyboard });
            } catch (e) {
                await bot.send(chatId, `❌ Error: ${escapeHtml(e.message)}`);
            }
        }
        else if (data === "menu_lora") {
            const keyboard = new InlineKeyboard()
                .add("🔍 Search LoRA", "lora_search").row()
                .add("📋 My LoRAs", "lora_list")
                .add("➕ Add LoRA", "lora_add").row()
                .add("🔙 Back", "menu_main")
                .build();
            
            await bot.editMessage(chatId, messageId, "🔧 <b>LoRA Management</b>\n\nUse buttons below", { reply_markup: keyboard });
            await bot.answerCallback(callbackQuery.id, "");
        }
        else if (data === "menu_main") {
            const keyboard = new InlineKeyboard()
                .add("⚙️ Settings", "menu_settings").row()
                .add("🎨 Models", "menu_models")
                .add("🔧 LoRA", "menu_lora").row()
                .add("📊 Status", "cmd_status")
                .add("🚀 Generate", "cmd_generate").row()
                .add("🔄 Auto: " + (config.enabled ? "ON" : "OFF"), "cmd_toggle_auto").row()
                .build();
            
            await bot.editMessage(chatId, messageId, "🤖 <b>Main Menu</b>", { reply_markup: keyboard });
            await bot.answerCallback(callbackQuery.id, "");
        }
        // Settings callbacks
        else if (data === "set_chat") {
            config.chatId = chatId;
            await saveConfig(env, config);
            await bot.answerCallback(callbackQuery.id, `✅ Chat set: ${chatId}`, true);
        }
        else if (data === "set_prompt") {
            await bot.answerCallback(callbackQuery.id, "Send /setprompt <text> to set", true);
        }
        else if (data === "set_interval") {
            await bot.answerCallback(callbackQuery.id, "Send /setinterval <minutes>", true);
        }
        else if (data === "set_count") {
            await bot.answerCallback(callbackQuery.id, "Send /setcount <1-10>", true);
        }
        else if (data === "set_model") {
            await bot.answerCallback(callbackQuery.id, "Send /setmodel <name> or /listmodels", true);
        }
        else if (data === "set_size") {
            await bot.answerCallback(callbackQuery.id, "Send /setsize <width> <height>\nExample: /setsize 1024 1024", true);
        }
        else if (data === "set_steps") {
            await bot.answerCallback(callbackQuery.id, "Send /setsteps <1-150>", true);
        }
        else if (data === "set_cfg") {
            await bot.answerCallback(callbackQuery.id, "Send /setcfg <1-30>", true);
        }
        else if (data === "set_sampler") {
            const samplers = ["k_euler", "k_euler_a", "k_lms", "k_heun", "k_dpm_2", "k_dpm_2_a", "k_dpmpp_2s_a", "k_dpmpp_2m", "k_dpmpp_sde", "DDIM"];
            let text = "🎲 <b>Available Samplers:</b>\n\n";
            samplers.forEach(s => {
                text += `${s === config.sampler ? "✅" : "⚪"} <code>${s}</code>\n`;
            });
            text += "\nSend /setsampler <name>";
            
            await bot.send(chatId, text);
            await bot.answerCallback(callbackQuery.id, "");
        }
        else if (data === "set_negative") {
            await bot.answerCallback(callbackQuery.id, "Send /setneg <text>", true);
        }
        // LoRA callbacks
        else if (data === "lora_search") {
            await bot.answerCallback(callbackQuery.id, "Send /searchlora <query>", true);
        }
        else if (data === "lora_list") {
            const loras = config.loras || [];
            if (!loras.length) {
                await bot.answerCallback(callbackQuery.id, "📋 No LoRAs yet", true);
                return;
            }
            
            let text = "📋 <b>Your LoRAs:</b>\n\n";
            loras.forEach((lora, i) => {
                text += `${i + 1}. <code>${escapeHtml(lora.name)}</code> (str: ${lora.strength}, clip: ${lora.clip})\n`;
                text += `   ❌ /removelora ${escapeHtml(lora.name)}\n`;
            });
            
            await bot.send(chatId, text);
            await bot.answerCallback(callbackQuery.id, "");
        }
        else if (data === "lora_add") {
            await bot.answerCallback(callbackQuery.id, "Send /addlora <civitai_version_id> [strength] [clip]\nExample: /addlora 123456 0.8 1.0", true);
        }
        // Command callbacks
        else if (data === "cmd_status") {
            const pending = await Redis.scan("pending:*");
            const blacklist = await Redis.get("worker_blacklist", "json") || [];
            const loras = (config.loras || []).map(l => `• <code>${escapeHtml(l.name)}</code> (${l.strength})`).join("\n") || "none";
            
            const text = `📊 <b>Status</b>\n\n` +
                `<b>Auto-post:</b> ${config.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
                `<b>Chat:</b> <code>${config.chatId || "—"}</code>\n` +
                `<b>Interval:</b> ${config.interval} min\n` +
                `<b>Count:</b> ${config.count}\n\n` +
                `<b>Prompt:</b>\n<code>${escapeHtml(config.generalPrompt || "—")}</code>\n\n` +
                `<b>Model:</b> <code>${escapeHtml(config.model)}</code>\n` +
                `<b>Size:</b> ${config.width}×${config.height}\n` +
                `<b>Steps:</b> ${config.steps} | <b>CFG:</b> ${config.cfgScale}\n` +
                `<b>Sampler:</b> ${config.sampler}\n` +
                `<b>CLIP Skip:</b> ${config.clipSkip || 1}\n` +
                `<b>NSFW:</b> ${config.nsfw ? "🔞 yes" : "no"}\n\n` +
                `<b>Negative:</b>\n<code>${escapeHtml(config.negativePrompt)}</code>\n\n` +
                `<b>LoRA:</b>\n${loras}\n\n` +
                `<b>Queue:</b> ${pending.keys.length}\n` +
                `<b>Blacklist:</b> ${blacklist.length} workers`;
            
            await bot.send(chatId, text);
            await bot.answerCallback(callbackQuery.id, "");
        }
        else if (data === "cmd_generate") {
            await bot.answerCallback(callbackQuery.id, "Use /generate command", true);
        }
        else if (data === "cmd_toggle_auto") {
            if (!config.enabled) {
                if (!config.chatId) {
                    await bot.answerCallback(callbackQuery.id, "❌ Set chat first: /setchat", true);
                    return;
                }
                if (!config.generalPrompt) {
                    await bot.answerCallback(callbackQuery.id, "❌ Set prompt first: /setprompt", true);
                    return;
                }
            }
            config.enabled = !config.enabled;
            await saveConfig(env, config);
            await bot.answerCallback(callbackQuery.id, `Auto-posting ${config.enabled ? "enabled" : "disabled"}`, true);
        }
        else if (data === "cmd_pending") {
            const pending = await Redis.scan("pending:*");
            if (!pending.keys.length) {
                await bot.answerCallback(callbackQuery.id, "📋 Queue is empty", true);
                return;
            }
            
            let text = `📋 <b>In queue: ${pending.keys.length}</b>\n\n`;
            
            for (const key of pending.keys.slice(0, 10)) {
                const id = key.replace("pending:", "");
                try {
                    const status = await hordeCheck(id);
                    text += `🔸 <code>${id}</code>\n`;
                    text += status.done ? "✅ Ready\n" : status.processing ? "⚙️ Processing\n" : `⏳ Queue #${status.queue_position || "?"}\n`;
                    text += `~${status.wait_time || 0}s\n\n`;
                } catch {
                    text += `🔸 <code>${id}</code> — failed\n\n`;
                }
            }
            
            await bot.send(chatId, text);
            await bot.answerCallback(callbackQuery.id, "");
        }
        else if (data === "cmd_cancel") {
            const pending = await Redis.scan("pending:*");
            for (const key of pending.keys) {
                await Redis.del(key);
            }
            await bot.answerCallback(callbackQuery.id, `🗑 Cleared ${pending.keys.length} from queue`, true);
        }
        else if (data === "cmd_checkkey") {
            await bot.answerCallback(callbackQuery.id, "🔑 Checking...", false);
            
            const result = await hordeCheckKey(env);
            if (!result.ok) {
                await bot.send(chatId, `❌ <b>Invalid key</b>\n${escapeHtml(result.err || "")}`);
                return;
            }
            
            const anonText = result.anon ? "🔴 Anonymous key\nNSFW will not work.\nRegister at stablehorde.net." :
                            result.flagged ? "⚠️ Account flagged — censorship may happen" :
                            "✅ Key looks fine, NSFW should work";
            
            const text = `${result.anon ? "🔴" : "✅"} <b>${escapeHtml(result.user || "anonymous")}</b>\n\n` +
                        `💎 Kudos: ${result.kudos || 0}\n` +
                        `🛡 Trusted: ${result.trusted ? "yes" : "no"}\n` +
                        `🚩 Flagged: ${result.flagged ? "yes" : "no"}\n\n` +
                        anonText;
            
            await bot.send(chatId, text);
        }
        else if (data === "cmd_diagnostic") {
            const apiKey = getApiKey(env);
            const blacklist = await Redis.get("worker_blacklist", "json") || [];
            
            const text = `🔧 <b>Diagnostics</b>\n\n` +
                `💾 Redis: ${env.UPSTASH_REDIS_REST_URL ? "✅" : "❌ not configured"}\n` +
                `🔑 Horde key: ${apiKey === "0000000000" ? "🔴 anonymous" : "✅ " + apiKey.substring(0, 8) + "..."}\n` +
                `🤖 OpenRouter: ${env.OPENROUTER_API_KEY ? "✅" : "⚠️"}\n\n` +
                `<b>Request flags:</b>\n` +
                ` nsfw: true\n` +
                ` censor_nsfw: false\n` +
                ` trusted_workers: false\n` +
                ` replacement_filter: true\n` +
                ` r2: true\n` +
                ` allow_downgrade: true\n\n` +
                `🚫 Blacklisted workers: <b>${blacklist.length}</b>\n` +
                `📏 Min image size: 10KB\n\n` +
                `<b>Censorship detection:</b>\n` +
                ` 1. gen_metadata[].type=="censorship"\n` +
                ` 2. gen.censored === true\n` +
                ` 3. gen.state === "censored"\n` +
                ` 4. size < 10KB`;
            
            await bot.send(chatId, text);
            await bot.answerCallback(callbackQuery.id, "");
        }
        
    } catch (e) {
        console.error("[Callback] Error:", e.message);
        await bot.answerCallback(callbackQuery.id, `❌ Error: ${e.message}`, true);
    }
}

// Scheduled task handler
async function processScheduled(env) {
    if (!env.UPSTASH_REDIS_REST_URL || !env.TELEGRAM_BOT_TOKEN) return;
    
    const bot = new Telegram(env.TELEGRAM_BOT_TOKEN);
    const config = await getConfig(env);
    
    // Process pending generations
    const pending = await Redis.scan("pending:*");
    
    for (const key of pending.keys) {
        const id = key.replace("pending:", "");
        
        try {
            const pendingData = await Redis.get(key, "json");
            if (!pendingData) {
                await Redis.del(key);
                continue;
            }
            
            // Check timeout (2 minutes)
            if (Date.now() - pendingData.at > 120000) {
                await Redis.del(key);
                if (pendingData.notify) {
                    await bot.send(pendingData.notify, `⏰ Generation timeout: <code>${id}</code>`);
                }
                continue;
            }
            
            // Check if done
            const checkResult = await hordeCheck(id);
            if (!checkResult.done) continue;
            
            // Get result
            const result = await hordeGetResult(id);
            await Redis.del(key);
            
            if (result.faulted) {
                if (pendingData.notify) {
                    await bot.send(pendingData.notify, `❌ Generation <code>${id}</code> failed`);
                }
                continue;
            }
            
            const generations = result.generations || [];
            if (!generations.length) {
                if (pendingData.notify) {
                    await bot.send(pendingData.notify, `❌ No generations for <code>${id}</code>`);
                }
                continue;
            }
            
            let success = false;
            let needsRetry = false;
            
            for (const gen of generations) {
                const workerId = gen.worker_id || "?";
                const workerName = gen.worker_name || "?";
                const censored = isCensored(gen);
                
                if (censored) {
                    await addWorkerToBlacklist(env, workerId, workerName);
                    needsRetry = true;
                    
                    if (pendingData.notify) {
                        await bot.send(pendingData.notify, `🔴 Worker <code>${escapeHtml(workerName)}</code> returned censorship\nAdded to blacklist`);
                    }
                    continue;
                }
                
                if (!gen.img) {
                    if (pendingData.notify) {
                        await bot.send(pendingData.notify, "❌ gen.img is empty");
                    }
                    continue;
                }
                
                // Generate caption based on mode
                let caption = "";
                if (config.captionMode === 1) {
                    caption = `🎨 <i>${escapeHtml(pendingData.prompt?.substring(0, 200) || "")}</i>`;
                } else if (config.captionMode === 2) {
                    caption = await generateAICaption(pendingData.prompt || "", gen.model || "", env);
                }
                // mode 0 = no caption
                
                const targetChat = pendingData.chatId;
                const { sent, tooSmall } = await deliverImage(bot, targetChat, gen.img, caption, pendingData.notify);
                
                if (sent) {
                    success = true;
                } else if (tooSmall) {
                    needsRetry = true;
                    await addWorkerToBlacklist(env, workerId, workerName);
                }
            }
            
            // Retry if needed
            if (needsRetry && !success && !pendingData.sfwTest) {
                const retries = (pendingData.retries || 0) + 1;
                
                if (retries < 3) {
                    const blacklist = (await Redis.get("worker_blacklist", "json") || []).map(w => w.id).filter(Boolean);
                    
                    try {
                        const retryResult = await hordeSubmit(pendingData.prompt, config, env, { workerBlacklist: blacklist });
                        
                        if (retryResult.id) {
                            await Redis.set(`pending:${retryResult.id}`, {
                                ...pendingData,
                                at: Date.now(),
                                retries: retries
                            }, { expirationTtl: 3600 });
                            
                            if (pendingData.notify) {
                                await bot.send(pendingData.notify, `🔄 Retry ${retries}/3: <code>${retryResult.id}</code>\n🚫 Blacklist: ${blacklist.length} workers`);
                            }
                        }
                    } catch (e) {
                        console.error("[Retry] Error:", e.message);
                    }
                } else {
                    if (pendingData.notify) {
                        await bot.send(pendingData.notify, 
                            "❌ <b>3 attempts — all placeholders/censored</b>\n\n" +
                            "Possible reasons:\n" +
                            "• Anonymous Horde key (NSFW won't work)\n" +
                            "• Account flagged\n" +
                            "• All workers censor this model\n\n" +
                            "/clearworkerbl — clear blacklist"
                        );
                    }
                }
            }
            
        } catch (e) {
            console.error(`[CRON] ${id}:`, e.message);
        }
    }
    
    // Auto-post if enabled
    if (!config.enabled || !config.chatId || !config.generalPrompt) return;
    
    // Check if queue has items
    const pendingCount = (await Redis.scan("pending:*")).keys.length;
    if (pendingCount > 0) return;
    
    // Check interval
    const lastPost = parseInt(await Redis.get("last_post_time") || "0", 10);
    const now = Date.now();
    
    if (now - lastPost < config.interval * 60 * 1000) return;
    
    await Redis.set("last_post_time", String(now));
    
    // Generate new images
    const blacklist = (await Redis.get("worker_blacklist", "json") || []).map(w => w.id).filter(Boolean);
    
    for (let i = 0; i < config.count; i++) {
        try {
            const prompt = await enhancePromptWithLLM(config.generalPrompt, env);
            const result = await hordeSubmit(prompt, config, env, { workerBlacklist: blacklist });
            
            if (result.id) {
                await Redis.set(`pending:${result.id}`, {
                    chatId: config.chatId,
                    prompt: prompt,
                    at: now,
                    notify: null,
                    retries: 0
                }, { expirationTtl: 3600 });
            }
        } catch (e) {
            console.error("[CRON] auto:", e.message);
        }
    }
}

// Main handler
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        
        // Webhook handler
        if (url.pathname === "/webhook") {
            if (request.method !== "POST") {
                return new Response("POST only", { status: 405 });
            }
            
            try {
                const data = await request.json();
                
                if (data.message) {
                    await handleCommand(data.message, env);
                } else if (data.callback_query) {
                    await handleCallback(data.callback_query, env);
                }
            } catch (e) {
                console.error("[WH] Error:", e.message);
            }
            
            return new Response("OK");
        }
        
        // Setup webhook
        if (url.pathname === "/setup") {
            if (!env.TELEGRAM_BOT_TOKEN) {
                return new Response("No TELEGRAM_BOT_TOKEN!", { status: 500 });
            }
            
            const webhookUrl = `${url.origin}/webhook`;
            const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    url: webhookUrl,
                    allowed_updates: ["message", "callback_query"],
                    drop_pending_updates: true
                })
            });
            
            const result = await response.json();
            return new Response(`Webhook: ${webhookUrl}\n\n${JSON.stringify(result, null, 2)}`);
        }
        
        // Root
        if (url.pathname === "/") {
            return new Response("🤖 Telegram Image Bot is running!\nVisit /setup to configure webhook.");
        }
        
        return new Response("Not found", { status: 404 });
    },
    
    async scheduled(event, env, ctx) {
        try {
            await processScheduled(env);
        } catch (e) {
            console.error("[CRON] CRASH:", e.message);
        }
    }
};