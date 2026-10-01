// Public routes (no login, no API key) — used by the public menu page / QR code
const index = (prop) => {
  const publicMenuRoute = require("./menu.route");
  publicMenuRoute({ ...prop, public_route: "api/public" });
};

module.exports = index;
