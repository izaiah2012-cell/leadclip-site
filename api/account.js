// LeadClip account API (Stripe)
//   GET  /api/account?action=config     -> public info for the upgrade page
//   POST /api/account?action=checkout   -> { plan, email } -> Stripe Checkout URL
//   GET  /api/account?action=me         -> plan + usage   (Google token required)
//   POST /api/account?action=use        -> count one clip, or refuse at the free limit
//   POST /api/account?action=portal     -> Stripe "manage subscription" link
const L = require("./_lib");
const SITE = "https://leadclip.vercel.app";

function readJson(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") { try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); } }
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
}

module.exports = async function handler(req, res) {
  L.cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const action = (req.query && req.query.action) || "me";

  try {
    if (action === "config") {
      const sold = Number(await L.redis("GET", "founding:sold")) || 0;
      return res.status(200).json({
        provider: "stripe",
        mode: L.STRIPE_LIVE ? "live" : "test",
        ready: !!process.env.STRIPE_SECRET_KEY,
        foundingLeft: Math.max(0, L.FOUNDING_LIMIT - sold)
      });
    }

    if (action === "checkout" && req.method === "POST") {
      const { plan, email: rawEmail } = await readJson(req);
      const email = String(rawEmail || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email." });
      const price = L.STRIPE_PRICES[plan];
      if (!price) return res.status(400).json({ error: "Unknown plan." });

      const user = await L.getUser(email);
      if (L.isPro(user)) return res.status(409).json({ error: "This account already has Pro. Open LeadClip Settings → Manage subscription." });
      if (plan === "founding") {
        const sold = Number(await L.redis("GET", "founding:sold")) || 0;
        if (sold >= L.FOUNDING_LIMIT) return res.status(410).json({ error: "Founding member places are sold out." });
      }

      const subscription = plan !== "founding";
      const body = {
        mode: subscription ? "subscription" : "payment",
        "line_items": { 0: { price, quantity: 1 } },
        success_url: `${SITE}/upgrade?success=1&email=${encodeURIComponent(email)}`,
        cancel_url: `${SITE}/upgrade?email=${encodeURIComponent(email)}`,
        client_reference_id: email,
        metadata: { email, plan },
        allow_promotion_codes: "true",
        billing_address_collection: "auto",
        tax_id_collection: { enabled: "true" }
      };
      if (process.env.STRIPE_TAX !== "off") body.automatic_tax = { enabled: "true" };
      if (user.customerId && String(user.customerId).startsWith("cus_")) {
        body.customer = user.customerId;
        body.customer_update = { address: "auto", name: "auto" };
      } else {
        body.customer_email = email;
        if (!subscription) body.customer_creation = "always";
      }
      if (subscription) body.subscription_data = { metadata: { email, plan } };
      else body.payment_intent_data = { metadata: { email, plan } };

      const session = await L.stripe("/checkout/sessions", "POST", body);
      return res.status(200).json({ url: session.url });
    }

    const email = await L.verifyGoogle(req);
    if (!email) return res.status(401).json({ error: "Please sign in with Google again." });

    const user = await L.getUser(email);
    const pro = L.isPro(user);
    const plan = pro ? (user.plan === "lifetime" ? "lifetime" : "pro") : "free";

    if (action === "me") {
      const count = Number(await L.redis("GET", L.usageKey(email))) || 0;
      return res.status(200).json({
        email, plan, count, limit: L.FREE_LIMIT,
        canManage: !!user.customerId && String(user.customerId).startsWith("cus_")
      });
    }

    if (action === "use" && req.method === "POST") {
      const key = L.usageKey(email);
      if (pro) {
        const count = await L.redis("INCR", key);
        return res.status(200).json({ allowed: true, plan, count, limit: L.FREE_LIMIT });
      }
      const current = Number(await L.redis("GET", key)) || 0;
      if (current >= L.FREE_LIMIT) {
        return res.status(200).json({ allowed: false, plan, count: current, limit: L.FREE_LIMIT });
      }
      const count = await L.redis("INCR", key);
      await L.redis("EXPIRE", key, 60 * 60 * 24 * 40);
      return res.status(200).json({ allowed: count <= L.FREE_LIMIT, plan, count, limit: L.FREE_LIMIT });
    }

    if (action === "portal" && req.method === "POST") {
      if (!user.customerId || !String(user.customerId).startsWith("cus_")) {
        return res.status(404).json({ error: "No subscription found for this Google account." });
      }
      const session = await L.stripe("/billing_portal/sessions", "POST", {
        customer: user.customerId,
        return_url: `${SITE}/upgrade?email=${encodeURIComponent(email)}`
      });
      return res.status(200).json({ url: session.url });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
