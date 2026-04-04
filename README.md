# 🤖 Auto-Image Telegram Bot

> **[🇷🇺 Русская документация](README_RU.md)** | **[🇬🇧 English documentation](README.md)**

An automated Telegram bot that generates AI images via the [Stable Horde](https://stablehorde.net/) distributed network and posts them to groups or channels on a schedule. Runs entirely on **Cloudflare Workers** (serverless, free tier supported).

---

## 📋 Table of Contents

- [Features](#-features)
- [Architecture](#-architecture)
- [Requirements](#-requirements)
- [Installation — Cloudflare (recommended)](#-installation--cloudflare-recommended)
- [Installation — Local machine](#-installation--local-machine)
- [Environment Variables](#-environment-variables)
- [Bot Commands](#-bot-commands)
- [Prompt Syntax](#-prompt-syntax-advanced)
- [Role System](#-role-system)
- [Caption Modes](#-caption-modes)
- [Watermark](#-watermark)
- [FAQ](#-faq)

---

## ✨ Features

- 🎨 **AI Image generation** via Stable Horde (free, no GPU required)
- 🤖 **Prompt enhancement** via OpenRouter LLM (optional)
- 📐 **Smart resolution selection** — LLM picks the best aspect ratio per prompt
- 📦 **Batch generation** — generate 1–10 images per post
- 🔁 **Auto-retry** on censored images (worker blacklisting)
- 💧 **Watermark** support via wsrv.nl
- 🎭 **Spoiler mode** for sensitive content
- 📝 **Three caption modes** (none / prompt text / AI-generated)
- 🔐 **Role-based access** (admin / creator / tech)
- 🗃️ **Redis (Upstash)** for persistent state
- ☁️ **Cloudflare Workers** — always-on, no server needed

---

## 🏗️ Architecture

```
Telegram Webhook
      │
      ▼
Cloudflare Worker (worker.js)
      │
      ├─► Upstash Redis  (config, queue, blacklist)
      ├─► Stable Horde API  (image generation)
      ├─► OpenRouter API  (prompt & caption LLM)
      └─► wsrv.nl  (watermark overlay)
```

The worker runs on **two triggers**:
1. **HTTP Webhook** — receives Telegram messages / commands
2. **Cron trigger** (`* * * * *`) — polls Horde for finished jobs and triggers scheduled posts

---

## 📦 Requirements

| Service | Required | Purpose |
|---|---|---|
| [Cloudflare](https://cloudflare.com) account | ✅ | Hosting the worker |
| [Telegram Bot Token](https://t.me/BotFather) | ✅ | Bot identity |
| [Upstash Redis](https://upstash.com) | ✅ | Persistent storage |
| [Stable Horde API key](https://stablehorde.net/register) | ⚠️ Recommended | Better queue priority (anonymous key works too) |
| [OpenRouter API key](https://openrouter.ai) | ⚪ Optional | Prompt & caption AI enhancement |

---

## 🚀 Installation — Cloudflare (recommended)

### Step 1 — Clone the repository

```bash
git clone https://github.com/your-username/auto-image-tg-bot.git
cd auto-image-tg-bot
```

### Step 2 — Install Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

### Step 3 — Create Upstash Redis

1. Go to [upstash.com](https://upstash.com) → create a free Redis database
2. Copy **REST URL** and **REST Token** from the dashboard

### Step 4 — Configure `wrangler.toml`

The file is already present. Edit the `name` if you wish:

```toml
name = "autoimgtg"
main = "worker.js"
compatibility_date = "2024-12-01"

[triggers]
crons = ["* * * * *"]

[observability]
enabled = true
head_sampling_rate = 1
```

### Step 5 — Set secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
# paste your bot token when prompted

wrangler secret put UPSTASH_REDIS_REST_URL
# paste Upstash REST URL

wrangler secret put UPSTASH_REDIS_REST_TOKEN
# paste Upstash REST Token

wrangler secret put HORDE_API_KEY
# paste Stable Horde API key (or skip for anonymous)

wrangler secret put OPENROUTER_API_KEY
# paste OpenRouter key (optional, skip for no LLM)
```

### Step 6 — Deploy

```bash
wrangler deploy
```

You will get a URL like: `https://autoimgtg.your-subdomain.workers.dev`

### Step 7 — Register the webhook

Open in your browser:

```
https://autoimgtg.your-subdomain.workers.dev/setup
```

You should see `"ok": true`. The webhook is now registered.

### Step 8 — Start the bot

Send `/start` to your bot in Telegram. The **first user** who sends any command is automatically assigned the **admin** role.

---

## 💻 Installation — Local machine

> ⚠️ Local mode uses Wrangler's dev server. The cron trigger does **not** fire automatically — you must call the scheduled handler manually or via `wrangler dev --test-scheduled`.

### Prerequisites

- Node.js 18+
- npm or yarn

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Create .dev.vars (local secrets file — never commit this)
cat > .dev.vars << 'EOF'
TELEGRAM_BOT_TOKEN=your_bot_token
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_token
HORDE_API_KEY=your_horde_key
OPENROUTER_API_KEY=your_openrouter_key
EOF

# 3. Start local dev server
wrangler dev

# The worker is now at http://localhost:8787
```

> For the Telegram webhook to reach localhost, you need a tunnel (e.g. [ngrok](https://ngrok.com)):
> ```bash
> ngrok http 8787
> # Then open: https://your-ngrok-url.ngrok.io/setup
> ```

To **manually trigger the cron** (poll Horde / post images):

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

---

## 🔑 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token from [@BotFather](https://t.me/BotFather) |
| `UPSTASH_REDIS_REST_URL` | ✅ | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | ✅ | Upstash Redis auth token |
| `HORDE_API_KEY` | ⚠️ | Stable Horde API key (default: anonymous `0000000000`) |
| `OPENROUTER_API_KEY` | ⚪ | OpenRouter key for LLM prompt & caption generation |

---

## 🤖 Bot Commands

### General

| Command | Role | Description |
|---|---|---|
| `/start` | All | Show help message |
| `/help` | All | Same as `/start` |
| `/ping` | All | Check bot status, Redis, Horde, OpenRouter |

### Channel / Group setup

| Command | Role | Description |
|---|---|---|
| `/setgroup` | admin | Bind current chat as the **posting group** |
| `/setchannel @name` | admin | Set posting **channel** by username or ID |
| `/ungroup` | admin | Unbind group |
| `/unchannel` | admin | Unbind channel |

### Scheduling

| Command | Role | Description |
|---|---|---|
| `/enable` | admin | Enable auto-posting |
| `/disable` | admin | Disable auto-posting |
| `/setinterval <minutes>` | admin | Set posting interval (default: 60) |
| `/setcount <1-10>` | admin | Images per batch. Also accepts `random 2-5` |
| `/generate` | creator | Manually trigger one generation cycle |

### Prompts

| Command | Role | Description |
|---|---|---|
| `/addprompt <text>` | creator | Add a new prompt to the list |
| `/delprompt <number>` | creator | Delete prompt by list number |
| `/promptlist [number]` | creator | Show all prompts; pass a number to see full text |
| `/setprompt <text>` | creator | Replace **all** prompts at once (use `;` as separator) |
| `/setneg <text>` | creator | Set negative prompt |
| `/setcontext <text>` | creator | Set custom LLM system context for prompt generation |
| `/settokens <1-8000>` | creator | Max tokens for LLM prompt generation (default: 800) |

### Model & Generation

| Command | Role | Description |
|---|---|---|
| `/setmodel <name>` | tech | Set Stable Diffusion model name |
| `/listmodels` | tech | Show top-40 active models on Horde |
| `/searchmodel <query>` | tech | Search models by name |
| `/setsize <W> <H>` | tech | Set base image resolution (rounded to 64px) |
| `/setsteps <n>` | tech | Set diffusion steps (default: 25) |
| `/setcfg <n>` | tech | Set CFG scale (default: 2) |
| `/setsampler <name>` | tech | Set sampler (default: `k_dpmpp_2m`) |
| `/setenhancer <type>` | tech | Add post-processors: `FaceFix`, `Upscale`, `AnimeUpscale`, `CodeFormers`, or `clear` |

### LoRA

| Command | Role | Description |
|---|---|---|
| `/addlora <id> [str] [clip] [global\|manual]` | creator | Add a LoRA. `global` = always applied; `manual` = only via `{id:str}` in prompt |
| `/listloras` | creator | List all configured LoRAs |
| `/clearloras` | creator | Remove all LoRAs |

### Caption & Style

| Command | Role | Description |
|---|---|---|
| `/setcaptionmode <0\|1\|2>` | creator | `0` = no caption, `1` = show prompt, `2` = AI-generated caption |
| `/setcaptionprompt <text>` | creator | Custom instruction for AI caption generation |
| `/setllm <model>` | creator | Set OpenRouter model (default: `openrouter/free`) |
| `/setspoiler <on\|off>` | creator | Enable/disable spoiler blur on images |

### Watermark

| Command | Role | Description |
|---|---|---|
| `/setwatermark [position]` | creator | Attach a PNG file to the command to set as watermark. Position: `random`, `corner`, `northwest`, `northeast`, `southwest`, `southeast`, `center` |
| `/delwatermark` | creator | Remove watermark |

### Queue & Moderation

| Command | Role | Description |
|---|---|---|
| `/status` | tech | Full bot status overview |
| `/pending` | tech | Show current generation queue |
| `/cancel` | tech | Cancel all pending generations |
| `/workerbl` | tech | Clear the worker blacklist |

### Roles

| Command | Role | Description |
|---|---|---|
| `/setrole <userId> <creator\|tech\|admin\|none>` | admin | Assign a role to a user |

---

## 📝 Prompt Syntax (Advanced)

Each prompt segment supports special `{...}` blocks:

| Syntax | Effect |
|---|---|
| `{loraId:strength}` | Apply a specific LoRA for this generation only |
| `{loraId:strength:clip}` | Same, with explicit clip weight |
| `{-loraId}` | Exclude a global LoRA for this generation |
| `{-llm}` or `{nollm}` | Skip LLM prompt enhancement for this segment |

**Instruction injection** — wrap part of the prompt in `[...]` to give the LLM a specific instruction:

```
cute anime girl [make her wear a red school uniform, standing in rain]
```

**Multiple prompt segments** — separate with `;`. Each post picks one randomly:

```
/addprompt fantasy landscape ; cyberpunk city ; anime girl {12345:0.8}
```

---

## 👥 Role System

| Role | Access |
|---|---|
| **admin** | Everything |
| **creator** | Prompts, LoRAs, context, caption, generate, watermark |
| **tech** | Status, queue, model settings, enhancers, samplers |

The **first user** to interact with the bot becomes admin automatically.
Assign roles with: `/setrole <userId> <role>`

---

## 🖼️ Caption Modes

| Mode | Behavior |
|---|---|
| `0` | No caption |
| `1` | Raw prompt text as italic caption |
| `2` | AI-generated creative caption (requires OpenRouter key) |

---

## 💧 Watermark

- Upload a **transparent PNG** as a document to the bot with the `/setwatermark` command
- The watermark is applied via [wsrv.nl](https://wsrv.nl) (free CDN image proxy)
- Positions: `random`, `corner`, `northwest`, `northeast`, `southwest`, `southeast`, `center`
- If the image is returned as base64 (not URL) from Horde, watermark is skipped automatically

---

## ❓ FAQ

**Q: Do I need a GPU?**
No. Stable Horde is a community-powered distributed GPU network. Generation is free but may take 1–5 minutes.

**Q: What if images are censored?**
The bot automatically blacklists the offending worker and retries up to 3 times on a different worker.

**Q: Can I run without OpenRouter?**
Yes. Without an OpenRouter key, prompts are sent to Horde as-is (no LLM expansion, no AI captions, random resolution).

**Q: How do I use multiple prompts?**
Use `/addprompt` multiple times. Each auto-post picks one segment at random. You can also put them all at once with `/setprompt theme1 ; theme2 ; theme3`.

**Q: What is the free Cloudflare Workers limit?**
100,000 requests/day on the free plan. For a bot running every minute, this is well within limits.
