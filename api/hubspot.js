// LeadClip server: HubSpot sign-in helper (Vercel Function)
// GET  /api/hubspot                    -> the HubSpot sign-in URL for the extension
// POST /api/hubspot { code }           -> swaps the one-time code for tokens
// POST /api/hubspot { refresh_token }  -> gets a fresh access token
// Needs Vercel Environment Variables: HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET
// The secret never leaves this server; the extension only ever sees access and refresh tokens.

const EXTENSION_ID = "dcmobmfcanclieokkkffndnefjagmhem";
const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org/`;
const SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.contacts.read",
  "crm.schemas.contacts.write"
];

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", `chrome-extension://${EXTENSION_ID}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

// HubSpot's newer token endpoint first, the long-standing one if it isn't available
async function tokenRequest(params) {
  const body = new URLSearchParams(params).toString();
  let last = null;
  for (const path of ["/oauth/v3/token", "/oauth/v1/token"]) {
    const r = await fetch(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return data;
    last = { status: r.status, data };
    if (r.status !== 404 && r.status !== 405) break;
  }
  const msg = (last && (last.data.message || last.data.error_description || last.data.error)) || "HubSpot sign-in failed.";
  const err = new Error(msg);
  err.status = last ? last.status : 500;
  throw err;
}

// Which HubSpot account the token belongs to (for the "Connected to …" line and contact links)
async function tokenInfo(accessToken) {
  try {
    const r = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`);
    if (!r.ok) return {};
    const d = await r.json();
    return { hub_id: d.hub_id || d.hubId || "", hub_domain: d.hub_domain || d.hubDomain || "" };
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: "HubSpot isn't set up on the LeadClip server yet." });
  }

  if (req.method === "GET") {
    const url =
      "https://app.hubspot.com/oauth/authorize" +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(SCOPES.join(" "))}`;
    return res.status(200).json({ url, redirectUri: REDIRECT_URI });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  try {
    let data;
    if (typeof body.code === "string" && body.code) {
      data = await tokenRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        code: body.code
      });
    } else if (typeof body.refresh_token === "string" && body.refresh_token) {
      data = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        refresh_token: body.refresh_token
      });
    } else {
      return res.status(400).json({ error: "Missing code or refresh_token." });
    }

    const info = data.hub_id ? { hub_id: data.hub_id, hub_domain: data.hub_domain || "" } : await tokenInfo(data.access_token);
    return res.status(200).json({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      hub_id: info.hub_id || "",
      hub_domain: info.hub_domain || ""
    });
  } catch (e) {
    return res.status(e.status && e.status < 500 ? 400 : 502).json({ error: e.message });
  }
};
