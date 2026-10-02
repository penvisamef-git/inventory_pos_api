const AuthKey = require("../v1/admin/auth/auth_api_key.model");

// The checked key record is kept for 10 minutes (it never changes per request) → no DB call per request
let cachedKey = null;
let cachedAt = 0;
const KEY_TTL_MS = 10 * 60 * 1000;

async function api_auth(req, res, next) {
  try {
    let key = cachedKey && Date.now() - cachedAt < KEY_TTL_MS ? cachedKey : null;
    if (!key) {
      key = await AuthKey.findOne({
        api_auth_key: process.env.API_AUTH_KEY,
      }).lean();
      if (key) {
        cachedKey = key;
        cachedAt = Date.now();
      }
    }

    if (!key) {
      return res
        .status(401)
        .json({ message: "Unauthorized Access", success: false });
    }

    req.apiKeyData = key;

    // Proceed to next middleware
    next();
  } catch (err) {
    // console.error("API Auth Error:", err);
    res.status(500).json({ message: "Internal Server Error", success: false });
  }
}

module.exports = {
  api_auth,
};
