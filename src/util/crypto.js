const crypto = require("crypto");

// AES-256-GCM for secrets stored in the DB (Telegram bot tokens).
// Key = sha256(TELEGRAM_TOKEN_KEY) — falls back to JWT_SECRET (then changing JWT_SECRET means re-entering bot tokens).
function key() {
  const secret = process.env.TELEGRAM_TOKEN_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error("TELEGRAM_TOKEN_KEY / JWT_SECRET is missing");
  return crypto.createHash("sha256").update(String(secret)).digest();
}

// "v1:<iv>:<tag>:<data>" (base64)
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

function decrypt(value) {
  const [v, iv, tag, data] = String(value || "").split(":");
  if (v !== "v1") throw new Error("bad secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// "123456:AAE…xyz" → "123456:AAE••••xyz"
const maskToken = (t) => (t ? `${String(t).slice(0, 10)}••••${String(t).slice(-4)}` : "");

module.exports = { encrypt, decrypt, maskToken };
