export const DEFAULT_CONFIG = {
  enabled: false,
  chatId: null,
  channelId: null,
  adminId: null,
  interval: 60,
  count: 1,
  generalPrompt: "",
  model: "AlbedoBase XL (SDXL)",
  loras: [], // Формат: { name: "12345", strength: 0.8 }
  width: 1024,
  height: 1024,
  steps: 25,
  cfgScale: 7,
  sampler: "k_dpmpp_2m",
  nsfw: true,
  negativePrompt: "worst quality, low quality, blurry, deformed, disfigured, bad anatomy, watermark, text, signature",
  llmModel: "meta-llama/llama-3.1-8b-instruct:free",
  clipSkip: 2,
  hiresFix: false,
  faceFixer: false,
  upscaler: false,
  captionMode: "prompt", // "none", "prompt", "ai"
};

export const HORDE_API = "https://stablehorde.net/api/v2";
