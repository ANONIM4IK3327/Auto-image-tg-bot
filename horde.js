import { HORDE_API } from "./config.js";

export async function submitHorde(prompt, config, env) {
  const payload = {
    prompt: `${prompt} ### ${config.negativePrompt}`,
    params: {
      sampler_name: config.sampler,
      cfg_scale: config.cfgScale,
      width: config.width,
      height: config.height,
      steps: config.steps,
      clip_skip: config.clipSkip,
      n: 1,
    },
    nsfw: config.nsfw,
    models: [config.model],
    r2: true,
  };

  // ФИКС LORA: Передаем как объекты с флагом версии
  if (config.loras?.length > 0) {
    payload.params.loras = config.loras.map(l => ({
      name: String(l.name),
      model: parseFloat(l.strength) || 0.8,
      clip: 1,
      is_version: true
    }));
  }

  const postProcessing = [];
  if (config.faceFixer) postProcessing.push("GFPGAN");
  if (config.upscaler) postProcessing.push("RealESRGAN_x4plus");
  if (postProcessing.length > 0) payload.params.post_processing = postProcessing;

  const res = await fetch(`${HORDE_API}/generate/async`, {
    method: "POST",
    headers: { apikey: env.HORDE_API_KEY || "0000000000", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}
