// LeadClip server: Notion sign-in helper (Vercel Function)
// GET  /api/notion  -> returns the Notion sign-in URL for the extension
// POST /api/notion  -> body { code } ; swaps the one-time code for a Notion access token
// Needs Vercel Environment Variables: NOTION_CLIENT_ID, NOTION_CLIENT_SECRET

const EXTENSION_ID = "dcmobmfcanclieokkkffndnefjagmhem";
const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org/`;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", `chrome-extension://${EXTENSION_ID}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: "Server not configured: add NOTION_CLIENT_ID and NOTION_CLIENT_SECRET in Vercel." });
  }

  if (req.method === "GET") {
    const url =
      "https://api.notion.com/v1/oauth/authorize" +
      `?client_id=${encodeURIComponent(clientId)}` +
      "&response_type=code&owner=user" +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    return res.status(200).json({ url, redirectUri: REDIRECT_URI });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const code = body && body.code;
    if (!code || typeof code !== "string") return res.status(400).json({ error: "Missing code." });

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const r = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI })
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(400).json({ error: data.error_description || data.message || data.error || "Notion sign-in failed." });
    }

    return res.status(200).json({
      access_token: data.access_token,
      workspace_name: data.workspace_name || "",
      workspace_id: data.workspace_id || "",
      bot_id: data.bot_id || ""
    });
  }

  return res.status(405).json({ error: "Method not allowed." });
};
