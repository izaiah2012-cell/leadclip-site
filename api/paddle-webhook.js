// Paddle webhook: POST /api/paddle-webhook
// Verifies the Paddle-Signature header, then records who has paid.
const crypto = require("crypto");
const L = require("./_lib");

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verify(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(";").map((p) => p.split("=")));
  const ts = parts.ts, h1 = parts.h1;
  if (!ts || !h1) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 5-minute window
  const expected = crypto.createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(h1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function emailFor(data) {
  const fromCustom = data.custom_data && (data.custom_data.email || data.custom_data.googleEmail);
  if (fromCustom) return String(fromCustom).toLowerCase();
  if (data.customer_id) {
    const c = await L.paddle(`/customers/${data.customer_id}`);
    return c.email ? c.email.toLowerCase() : null;
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const raw = typeof req.body === "string" && req.body ? req.body : await readRaw(req);
  if (!verify(raw, req.headers["paddle-signature"], process.env.PADDLE_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "Bad signature" });
  }

  const event = JSON.parse(raw);
  const type = event.event_type;
  const data = event.data || {};

  try {
    // ignore duplicates (Paddle retries)
    const fresh = await L.redis("SET", `evt:${event.event_id}`, "1", "NX", "EX", 60 * 60 * 24 * 7);
    if (fresh === null) return res.status(200).json({ ok: true, duplicate: true });

    const email = await emailFor(data);
    if (!email) return res.status(200).json({ ok: true, note: "no email" });

    const priceIds = (data.items || []).map((i) => i.price?.id || i.price_id);

    if (type === "transaction.completed" && priceIds.includes(L.PRICES.founding)) {
      const user = await L.getUser(email);
      if (user.plan !== "lifetime") await L.redis("INCR", "founding:sold");
      await L.setUser(email, {
        plan: "lifetime", status: "active", customerId: data.customer_id,
        transactionId: data.id, updated: new Date().toISOString()
      });
    }

    if (type && type.startsWith("subscription.")) {
      const user = await L.getUser(email);
      if (user.plan !== "lifetime") {
        await L.setUser(email, {
          plan: "pro",
          status: data.status, // active, trialing, past_due, paused, canceled
          customerId: data.customer_id,
          subscriptionId: data.id,
          paidUntil: data.current_billing_period?.ends_at || user.paidUntil || "",
          updated: new Date().toISOString()
        });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
