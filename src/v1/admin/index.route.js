const index = (prop) => {
  // Declaration
  prop.main_route = "api/admin";

  // ================= Core =================
  const authRoute = require("./auth/auth.route");
  authRoute(prop);
  const sessionRoute = require("./session/session.route");
  sessionRoute(prop);
  const userRoute = require("./user/user.route");
  userRoute(prop);
  const activityLogRoute = require("./activity_log/activity_log.route");
  activityLogRoute(prop);
  const uploadRoute = require("./upload/upload.route");
  uploadRoute(prop);

  // ================= Menu =================
  const menuBookRoute = require("./menu/book/route");
  menuBookRoute(prop);

  const menuCategoryRoute = require("./menu/category/route");
  menuCategoryRoute(prop);

  const menuSectionRoute = require("./menu/section/route");
  menuSectionRoute(prop);

  const menuItemRoute = require("./menu/item/route");
  menuItemRoute(prop);

  const menuBannerRoute = require("./menu/banner/route");
  menuBannerRoute(prop);

  const menuSettingRoute = require("./menu/setting/route");
  menuSettingRoute(prop);
};

module.exports = index;
