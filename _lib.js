// Shared helpers for LeadClip API (files starting with _ are not public routes on Vercel)

const FREE_LIMIT = 15;
const FOUNDING_LIMIT = 100;
const EXTENSION_ORIGIN = "chrome-extension://dcmobmfcanclieokkkffndnefjagmhem";

const PRICES = {
  monthly: "pri_01m7dv131yn1qqqm1xb8adbzeq",
  yearly: "pri_01m7dv7q50c06yvna6sbba2qvd",
  founding: "pri_01m7dtj3th591b6t9aa2hgca1t"
};

const PADDLE_API =
  (process.env.PADDLE_ENV || "sandbox") === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";

// ---------- Upstash Redis (REST) ----------
function redisCreds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Database is not connected (missing Redis env vars).");
  return { url, token };
}

async function redis(...command) {
  const { url, token } = redisCreds();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await res.json();
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

function hashToObject(arr) {
  const o = {};
  for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

const userKey = (email) => `user:${String(email).toLowerCase().trim()}`;

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const usageKey = (email) => `usage:${String(email).toLowerCase().trim()}:${monthKey()}`;

async function getUser(email) {
  return hashToObject(await redis("HGETALL", userKey(email)));
}

async function setUser(email, fields) {
  const args = [];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) args.push(k, String(v));
  if (args.length) await redis("HSET", userKey(email), ...args);
}

// Pro if lifetime, or an active / trialing / past_due (grace) subscription
function isPro(user) {
  if (user.plan === "lifetime") return true;
  if (user.plan === "pro" && ["active", "trialing", "past_due"].includes(user.status)) return true;
  // cancelled but still inside the paid period
  if (user.plan === "pro" && user.status === "canceled" && user.paidUntil && new Date(user.paidUntil) > new Date()) return true;
  return false;
}

// ---------- Google token -> verified email ----------
async function verifyGoogle(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const info = await res.json();
  return info.email_verified === false ? null : (info.email || null);
}

// ---------- Paddle API ----------
async function paddle(path, method = "GET", body) {
  const res = await fetch(`${PADDLE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Paddle: ${data.error?.detail || res.status}`);
  return data.data;
}

function cors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = [EXTENSION_ORIGIN, "https://leadclip.vercel.app"];
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = {
  FREE_LIMIT, FOUNDING_LIMIT, PRICES, redis, getUser, setUser, isPro,
  usageKey, verifyGoogle, paddle, cors
};
