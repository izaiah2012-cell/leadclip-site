// LeadClip account API
//   GET  /api/account?action=config        -> public checkout config (no login)
//   GET  /api/account?action=me            -> plan + usage   (Google token required)
//   POST /api/account?action=use           -> count one clip, or refuse at the free limit
//   POST /api/account?action=portal        -> Paddle "manage subscription" link
const L = require("./_lib");

module.exports = async function handler(req, res) {
  L.cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const action = (req.query && req.query.action) || "me";

  try {
    if (action === "config") {
      const sold = Number(await L.redis("GET", "founding:sold")) || 0;
      return res.status(200).json({
        environment: (process.env.PADDLE_ENV || "sandbox") === "production" ? "production" : "sandbox",
        clientToken: process.env.PADDLE_CLIENT_TOKEN || "",
        prices: L.PRICES,
        foundingLeft: Math.max(0, L.FOUNDING_LIMIT - sold)
      });
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
        canManage: !!user.customerId && user.plan === "pro"
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
      if (!user.customerId) return res.status(404).json({ error: "No subscription found for this Google account." });
      const body = user.subscriptionId ? { subscription_ids: [user.subscriptionId] } : {};
      const session = await L.paddle(`/customers/${user.customerId}/portal-sessions`, "POST", body);
      const url = session.urls?.general?.overview;
      return res.status(200).json({ url });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
