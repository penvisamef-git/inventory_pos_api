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

  // ================= Setup =================
  const warehouseRoute = require("./setup/warehouse/warehouse.route");
  warehouseRoute(prop);
  const settingRoute = require("./setup/setting/setting.route");
  settingRoute(prop);
  const exchangeRateRoute = require("./setup/exchange_rate/exchange_rate.route");
  exchangeRateRoute(prop);
  const paymentMethodRoute = require("./setup/payment_method/payment_method.route");
  paymentMethodRoute(prop);

  // ================= Product =================
  const unitRoute = require("./product/unit/unit.route");
  unitRoute(prop);
  const categoryRoute = require("./product/category/category.route");
  categoryRoute(prop);
  const attributeRoute = require("./product/attribute/attribute.route");
  attributeRoute(prop);
  const brandRoute = require("./product/brand/brand.route");
  brandRoute(prop);
  const productRoute = require("./product/item/product.route");
  productRoute(prop);
  const priceRoute = require("./product/price/price.route");
  priceRoute(prop);

  // ================= Purchase & Stock =================
  const supplierRoute = require("./purchase/supplier/supplier.route");
  supplierRoute(prop);
  const stockRoute = require("./stock/stock.route");
  stockRoute(prop);
  const openingRoute = require("./stock/opening/opening.route");
  openingRoute(prop);
  const receiveRoute = require("./stock/receive/receive.route");
  receiveRoute(prop);
  const adjustmentRoute = require("./stock/adjustment/adjustment.route");
  adjustmentRoute(prop);
  const transferRoute = require("./stock/transfer/transfer.route");
  transferRoute(prop);

  // ================= Shop portal =================
  const shopRoute = require("./shop/shop.route");
  shopRoute(prop);

  // ================= Telegram =================
  const telegramRoute = require("./telegram/telegram.route");
  telegramRoute(prop);
};

module.exports = index;
