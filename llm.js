export async function processPrompt(raw, env, config) {
  const match = raw.match(/^\[(.*?)\](.*)/s);
  let system = "You are a prompt engineer. Output only comma-separated tags.";
  let user = raw;

  if (match) {
    system = match[1]; // Инструкция из [скобок]
    user = match[2].trim(); // Сам текст
  }

  if (!env.OPENROUTER_API_KEY) return user;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.llmModel,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || user;
}

export async function generateCaption(prompt, env) {
  if (!env.OPENROUTER_API_KEY) return "";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemma-2-9b-it:free",
      messages: [{ role: "system", content: "Напиши короткий художественный пост для ТГ на русском по описанию картинки. Без хэштегов." }, { role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}
