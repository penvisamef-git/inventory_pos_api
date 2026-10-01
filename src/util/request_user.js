const Session = require("../v1/admin/session/session.model");
const User = require("../v1/admin/user/user.model");
const { getToken } = require("./jwt_auth");

// Finds the session of this token → req.session (user_id, user_data, ...)
async function request_user(req, res, next) {
  try {
    const token = req.token || getToken(req);
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    const session = await Session.findOne({ access_token: token });
    if (!session) {
      return res
        .status(401)
        .json({ success: false, message: "Session not found or expired" });
    }

    // Block users that were deleted or suspended after they logged in
    const user = await User.findOne({ _id: session.user_id })
      .select("-password -pos_pin")
      .lean();
    if (!user || user.deleted || !user.status) {
      return res
        .status(401)
        .json({ success: false, message: "គណនីត្រូវបានផ្អាក ឬលុប!" });
    }

    req.session = session;
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

module.exports = request_user;
