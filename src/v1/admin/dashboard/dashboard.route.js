const WarehouseModel = require("../setup/warehouse/warehouse.model");
const UserModel = require("../user/user.model");
const ExchangeRateModel = require("../setup/exchange_rate/exchange_rate.model");
const PaymentMethodModel = require("../setup/payment_method/payment_method.model");
const ProductModel = require("../product/item/product.model");
const PriceModel = require("../product/price/price.model");
const OpeningModel = require("../stock/opening/opening.model");
const { serverError } = require("../../../util/master_crud");
const { can_view_master, ROLE_ADMIN } = require("../../../util/permission");
const { warehouse_scope, scopeFilter } = require("../../../util/warehouse_scope");

// GET /dashboard/summary → everything the dashboard home needs in ONE request (all queries run in parallel)
//   { warehouses, users (admin only, else null), rate, methods, products, priced, opening }
const route = (prop) => {
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope];

  prop.app.get(`/${prop.main_route}/dashboard/summary`, ...guard, async (req, res) => {
    try {
      const isAdmin = req.user.is_super_admin || req.user.role === ROLE_ADMIN;
      const [warehouses, users, rate, methods, products, priced, opening] = await Promise.all([
        WarehouseModel.find({ deleted: false, status: true, ...scopeFilter(req, "_id") })
          .select("code name_kh name_en type address phone status")
          .sort({ type: 1, sort_order: 1, code: 1 })
          .lean(),
        isAdmin ? UserModel.countDocuments({ deleted: { $ne: true } }) : null,
        ExchangeRateModel.currentAt(new Date()),
        PaymentMethodModel.find({ deleted: false, status: true }).select("code name_kh name_en type").lean(),
        ProductModel.countDocuments({ deleted: false }),
        PriceModel.exists({ deleted: { $ne: true }, warehouse_id: null }),
        OpeningModel.countDocuments({ state: "posted" }),
      ]);
      res.status(200).json({ success: true, data: { warehouses, users, rate, methods, products, priced: !!priced, opening } });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
