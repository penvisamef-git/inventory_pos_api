// Brute-force protection for logins (web now, POS PIN later).
// Failed attempts are counted in MongoDB, so the limit holds across every server instance (Vercel).
//   per email: LOGIN_MAX_FAILS (default 8) per 15 min · per IP: LOGIN_MAX_FAILS_IP (default 30) per 15 min
// A successful login clears the email's counter. Old rows delete themselves (TTL index).
const mongoose = require("mongoose");

const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MIN || 15) * 60 * 1000;
const MAX = { email: Number(process.env.LOGIN_MAX_FAILS || 8), ip: Number(process.env.LOGIN_MAX_FAILS_IP || 30) };

const schema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // "email:a@b.com" | "ip:1.2.3.4"
    count: { type: Number, default: 0 },
    reset_at: { type: Date, required: true },
    expires_at: { type: Date, required: true },
  },
  { versionKey: false },
);
schema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
const LoginAttempt = mongoose.models.LoginAttempt || mongoose.model("LoginAttempt", schema);

const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || req.socket?.remoteAddress || "unknown";
const keysOf = (req, email) => [
  { key: `email:${email}`, max: MAX.email },
  { key: `ip:${clientIp(req)}`, max: MAX.ip },
];

// → seconds to wait (0 = allowed)
async function waitSeconds(req, email) {
  const keys = keysOf(req, email);
  const rows = await LoginAttempt.find({ key: { $in: keys.map((k) => k.key) } }).lean();
  const now = Date.now();
  let wait = 0;
  for (const r of rows) {
    const max = keys.find((k) => k.key === r.key)?.max || Infinity;
    const left = new Date(r.reset_at).getTime() - now;
    if (left > 0 && r.count >= max) wait = Math.max(wait, Math.ceil(left / 1000));
  }
  return wait;
}

async function recordFail(req, email) {
  const now = new Date();
  for (const { key } of keysOf(req, email)) {
    const row = await LoginAttempt.findOne({ key });
    if (!row || row.reset_at <= now) {
      const reset = new Date(now.getTime() + WINDOW_MS);
      await LoginAttempt.updateOne({ key }, { key, count: 1, reset_at: reset, expires_at: reset }, { upsert: true });
    } else {
      await LoginAttempt.updateOne({ key }, { $inc: { count: 1 } });
    }
  }
}

async function clearFails(email) {
  await LoginAttempt.deleteOne({ key: `email:${email}` });
}

const waitText = (sec) => {
  const min = Math.ceil(sec / 60);
  return `ព្យាយាមចូលខុសច្រើនដងពេក! សូមរង់ចាំ ${min} នាទី ហើយព្យាយាមម្តងទៀត។`;
};

module.exports = { waitSeconds, recordFail, clearFails, waitText, LoginAttempt, clientIp };
