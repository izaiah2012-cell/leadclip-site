// Stripe webhook: POST /api/stripe-webhook
// Verifies the Stripe-Signature header, then records who has paid.
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
  const parts = header.split(",").map((p) => p.split("="));
  const t = (parts.find(([k]) => k === "t") || [])[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5-minute window
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some((s) => {
    const a = Buffer.from(expected), b = Buffer.from(s);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : "");

async function emailForCustomer(customerId) {
  if (!customerId) return null;
  const c = await L.stripe(`/customers/${customerId}`);
  return c.email ? c.email.toLowerCase() : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const raw = typeof req.body === "string" && req.body ? req.body : await readRaw(req);
  if (!verify(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: "Bad signature" });
  }

  const event = JSON.parse(raw);
  const obj = event.data?.object || {};

  try {
    const fresh = await L.redis("SET", `evt:${event.id}`, "1", "NX", "EX", 60 * 60 * 24 * 7);
    if (fresh === null) return res.status(200).json({ received: true, duplicate: true });

    if (event.type === "checkout.session.completed") {
      const email = (obj.metadata?.email || obj.client_reference_id || obj.customer_details?.email || "").toLowerCase();
      if (!email) return res.status(200).json({ received: true, note: "no email" });

      if (obj.mode === "payment" && obj.metadata?.plan === "founding" && obj.payment_status === "paid") {
        const user = await L.getUser(email);
        if (user.plan !== "lifetime") await L.redis("INCR", "founding:sold");
        await L.setUser(email, {
          plan: "lifetime", status: "active", customerId: obj.customer || user.customerId,
          paymentId: obj.payment_intent, updated: new Date().toISOString()
        });
      }

      if (obj.mode === "subscription" && obj.subscription) {
        const sub = await L.stripe(`/subscriptions/${obj.subscription}`);
        const periodEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
        const user = await L.getUser(email);
        if (user.plan !== "lifetime") {
          await L.setUser(email, {
            plan: "pro", status: sub.status, customerId: obj.customer,
            subscriptionId: sub.id, paidUntil: iso(periodEnd), updated: new Date().toISOString()
          });
        }
      }
    }

    if (event.type.startsWith("customer.subscription.")) {
      const email = (obj.metadata?.email || await emailForCustomer(obj.customer) || "").toLowerCase();
      if (email) {
        const user = await L.getUser(email);
        if (user.plan !== "lifetime") {
          const periodEnd = obj.current_period_end || obj.items?.data?.[0]?.current_period_end;
          await L.setUser(email, {
            plan: "pro",
            status: event.type === "customer.subscription.deleted" ? "canceled" : obj.status,
            customerId: obj.customer,
            subscriptionId: obj.id,
            paidUntil: iso(periodEnd) || user.paidUntil || "",
            updated: new Date().toISOString()
          });
        }
      }
    }

    if (event.type === "charge.refunded" && obj.refunded && obj.payment_intent) {
      // A fully refunded Founding purchase removes lifetime access
      const pi = await L.stripe(`/payment_intents/${obj.payment_intent}`);
      const email = (pi.metadata?.email || "").toLowerCase();
      if (email && pi.metadata?.plan === "founding") {
        const user = await L.getUser(email);
        if (user.plan === "lifetime") {
          await L.setUser(email, { plan: "free", status: "refunded", updated: new Date().toISOString() });
          await L.redis("DECR", "founding:sold");
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
