const { UAParser } = require("ua-parser-js");

function extractDeviceInfo(req) {
  const userAgent = req.headers["user-agent"] || "";
  const result = new UAParser(userAgent).getResult();

  return {
    browser: `${result.browser.name || ""} ${result.browser.version || ""}`.trim(),
    os: `${result.os.name || ""} ${result.os.version || ""}`.trim(),
    device: result.device.type || "desktop",
    userAgent: userAgent,
  };
}

function cambodiaDate() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Phnom_Penh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false, // 24-hour format
  });
}

// Returns false (and sends the response) when a required field is empty
function checkValidtion(res, req, requiredFields) {
  for (const field of requiredFields) {
    const value = req.body?.[field.key];

    if (
      value === undefined || // missing key
      value === null || // null value
      value === "" // empty string
    ) {
      res.status(400).json({
        success: false,
        message: `សូមបញ្ចូល ${field.label}`,
      });
      return false;
    }
  }
  return true;
}

// Fields a client must never set through a create/update request
const PROTECTED_FIELDS = [
  "_id",
  "__v",
  "deleted",
  "created_by",
  "updated_by",
  "created_date",
  "updated_date",
];

// Copy of req.body without protected fields (plus any extra ones for this route)
function sanitizeUpdate(body, extraProtected = []) {
  const blocked = [...PROTECTED_FIELDS, ...extraProtected];
  const clean = {};
  for (const key of Object.keys(body || {})) {
    if (!blocked.includes(key) && !key.startsWith("$")) clean[key] = body[key];
  }
  return clean;
}

// Keep only the allowed keys of an object (for create / update)
function pick(body, keys) {
  const out = {};
  for (const key of keys) {
    if (body && body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

// Remove null / undefined values
function removeEmpty(obj) {
  Object.keys(obj).forEach((key) => obj[key] == null && delete obj[key]);
  return obj;
}

// Escape user text before using it inside a RegExp
function escapeRegex(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Round money / qty: round(1.005, 2) → 1.01   (USD totals 2 dp, line prices 4 dp)
function round(value, dp = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** dp;
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

// true when another non-deleted row already uses this code
// codeExists(UnitModel, "box")                → create
// codeExists(UnitModel, "box", id)            → update (skip itself)
// codeExists(PriceModel, code, id, { x: 1 })  → extra filter
async function codeExists(Model, code, excludeId = null, extraFilter = {}) {
  const filter = { code: String(code).trim(), deleted: false, ...extraFilter };
  if (excludeId) filter._id = { $ne: excludeId };
  return !!(await Model.exists(filter));
}

module.exports = {
  cambodiaDate,
  extractDeviceInfo,
  checkValidtion,
  sanitizeUpdate,
  pick,
  removeEmpty,
  escapeRegex,
  round,
  codeExists,
};
