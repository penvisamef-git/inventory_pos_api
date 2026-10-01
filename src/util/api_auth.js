const AuthKey = require("../v1/admin/auth/auth_api_key.model");

async function api_auth(req, res, next) {
  try {
    const key = await AuthKey.findOne({
      api_auth_key: process.env.API_AUTH_KEY,
    });

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
