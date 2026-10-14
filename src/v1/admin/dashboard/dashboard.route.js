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
const { salesToday } = require("../sale/sale.summary");
const SettingModel = require("../setup/setting/setting.model");
const VariantModel = require("../product/item/variant.model");
const { StockBalanceModel, StockBatchBalanceModel } = require("../stock/balance.model");
const TransferModel = require("../stock/transfer/transfer.model");
const StockAdjustmentModel = require("../stock/adjustment/adjustment.model");

// Stock alerts over the warehouses this user sees: low / out / negative stock, expiring batches,
// transfers waiting, draft adjustments (+ short lists for the cards)
async function stockAlerts(warehouseIds, warehouses) {
  const now = new Date();
  const setting = await SettingModel.getMain();
  const alertDays = setting?.expiry_alert_days || 30;
  const wh = warehouseIds ? { warehouse_id: { $in: warehouseIds } } : {};
  const whCode = new Map(warehouses.map((w) => [String(w._id), w.code]));
  const [bals, expiring, toReceive, toSend, adjDrafts] = await Promise.all([
    StockBalanceModel.find(wh).select("warehouse_id variant_id qty").lean(),
    StockBatchBalanceModel.find({ ...wh, qty: { $gt: 0 }, expiry_date: { $ne: null, $lte: new Date(now.getTime() + alertDays * 86400000) } })
      .sort({ expiry_date: 1 })
      .populate([{ path: "variant_id", select: "code name_kh name_en" }, { path: "batch_id", select: "batch_no" }])
      .lean(),
    TransferModel.countDocuments({ ...(warehouseIds ? { to_warehouse_id: { $in: warehouseIds } } : {}), state: "dispatched" }),
    TransferModel.countDocuments({ ...wh, state: { $in: ["requested", "draft"] } }),
    StockAdjustmentModel.countDocuments({ ...wh, state: "draft" }),
  ]);
  const variants = await VariantModel.find({ _id: { $in: [...new Set(bals.map((b) => String(b.variant_id)))] }, deleted: false })
    .select("product_id code name_kh name_en min_stock")
    .populate("product_id", "min_stock track_stock deleted")
    .lean();
  const vMap = new Map(variants.filter((v) => v.product_id && !v.product_id.deleted && v.product_id.track_stock !== false).map((v) => [String(v._id), v]));
  const low = [];
  let out = 0;
  let negative = 0;
  bals.forEach((b) => {
    const v = vMap.get(String(b.variant_id));
    if (!whCode.has(String(b.warehouse_id)) || !v) return;
    const min = v.min_stock ?? v.product_id?.min_stock ?? 0;
    if (b.qty < 0) negative += 1;
    if (b.qty <= 0) out += 1;
    else if (min > 0 && b.qty <= min) low.push({ sku: v.code, name_kh: v.name_kh, name_en: v.name_en, warehouse: whCode.get(String(b.warehouse_id)), qty: b.qty, min });
  });
  const exp = expiring.filter((e) => whCode.has(String(e.warehouse_id)));
  return {
    low: low.length,
    out,
    negative,
    expiry_days: alertDays,
    expiring: exp.length,
    expired: exp.filter((e) => e.expiry_date <= now).length,
    transfers_to_receive: toReceive,
    transfers_pending: toSend,
    adjustment_drafts: adjDrafts,
    low_items: low.sort((a, b) => a.qty / a.min - b.qty / b.min).slice(0, 6),
    expiring_items: exp.slice(0, 5).map((e) => ({ sku: e.variant_id?.code, name_kh: e.variant_id?.name_kh, name_en: e.variant_id?.name_en, warehouse: whCode.get(String(e.warehouse_id)), batch_no: e.batch_id?.batch_no, qty: e.qty, days_left: Math.ceil((new Date(e.expiry_date) - now) / 86400000) })),
  };
}

// GET /dashboard/summary → everything the dashboard home needs in ONE request (all queries run in parallel)
//   { warehouses, users (admin only, else null), rate, methods, products, priced, opening, sales (today), alerts (stock) }
const route = (prop) => {
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope];

  prop.app.get(`/${prop.main_route}/dashboard/summary`, ...guard, async (req, res) => {
    try {
      const isAdmin = req.user.is_super_admin || req.user.role === ROLE_ADMIN;
      const [warehouses, users, rate, methods, products, priced, opening, sales] = await Promise.all([
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
        salesToday(req.warehouse_ids, { withCost: req.warehouse_scope === "all" }), // today's POS sales (own shops for a shop role)
      ]);
      const alerts = await stockAlerts(req.warehouse_ids, warehouses);
      res.status(200).json({ success: true, data: { warehouses, users, rate, methods, products, priced: !!priced, opening, sales, alerts } });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
