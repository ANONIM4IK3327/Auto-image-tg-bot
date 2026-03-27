export class Redis {
  constructor(env) {
    this.url = env.UPSTASH_REDIS_REST_URL;
    this.token = env.UPSTASH_REDIS_REST_TOKEN;
  }

  async req(cmd) {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    return (await r.json()).result;
  }

  async get(key) { return await this.req(["GET", key]); }
  async set(key, val) { return await this.req(["SET", key, JSON.stringify(val)]); }
  async keys(pattern) { return await this.req(["KEYS", pattern]) || []; }
  async del(key) { await this.req(["DEL", key]); }
}
