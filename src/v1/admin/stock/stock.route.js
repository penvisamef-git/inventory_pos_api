const mongoose = require("mongoose");
const StockMovementModel = require("./movement.model");
const { StockBalanceModel, StockBatchBalanceModel } = require("./balance.model");
const ProductModel = require("../product/item/product.model");
const VariantModel = require("../product/item/variant.model");
const WarehouseModel = require("../setup/warehouse/warehouse.model");
const SettingModel = require("../setup/setting/setting.model");
const getFilteredMongoDB = require("../../../util/mongo_db/mongoDB_Queries");
const { escapeRegex, round } = require("../../../util/helper");
const { serverError } = require("../../../util/master_crud");
const { can_view_master } = require("../../../util/permission");
const { warehouse_scope, canAccessWarehouse } = require("../../../util/warehouse_scope");
const { categoryWithChildren } = require("../product/item/product.service");
const { allocateFefo } = require("./stock.engine");
const { isId } = require("./stock.items");

const COST_KEYS = ["avg_cost", "total_value", "unit_cost", "total_cost", "avg_cost_after"];
// shop managers do not see cost
const hideCost = (req, obj) => {
  if (!req.warehouse_ids || !obj) return obj;
  COST_KEYS.forEach((k) => delete obj[k]);
  return obj;
};
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// /api/admin/stock/... — read-only views (scoped: shop manager = own shops, no cost)
const route = (prop) => {
  const base = `/${prop.main_route}/stock`;
  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope];

  // warehouses this request may see (optionally one)
  async function warehousesFor(req, warehouseId) {
    if (warehouseId) {
      if (!isId(warehouseId) || !canAccessWarehouse(req, warehouseId)) return null;
      return WarehouseModel.find({ _id: warehouseId, deleted: false }).sort({ sort_order: 1 }).lean();
    }
    const f = { deleted: false };
    if (req.warehouse_ids) f._id = { $in: req.warehouse_ids };
    return WarehouseModel.find(f).sort({ sort_order: 1 }).lean();
  }

  // ===================================== ON HAND ================================================
  // GET /stock/balance?warehouse_id=&category_id=&product_id=&q=&only=low|negative|in_stock|out&page=&limit=
  // → rows per variant: { variant, product, min_stock, warehouses: [{ warehouse_id, qty, avg_cost, total_value, low }], total_qty, total_value }
  //   + summary { variants, total_qty, total_value, low, negative } over the whole filter
  prop.app.get(`${base}/balance`, ...viewGuard, async (req, res) => {
    try {
      const whs = await warehousesFor(req, req.query.warehouse_id);
      if (!whs) return res.status(403).json({ success: false, message: "អ្នកមិនមានសិទ្ធិមើលឃ្លាំងនេះទេ!" });
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);

      const pFilter = { deleted: false, track_stock: { $ne: false } };
      if (isId(req.query.category_id)) pFilter.category_id = { $in: await categoryWithChildren(req.query.category_id) };
      if (isId(req.query.product_id)) pFilter._id = oid(req.query.product_id);
      const products = await ProductModel.find(pFilter).select("code name_kh name_en min_stock base_unit_id track_batch image category_id").populate("base_unit_id", "code name_kh name_en").lean();
      const pById = new Map(products.map((p) => [String(p._id), p]));
      const vFilter = { deleted: false, product_id: { $in: products.map((p) => p._id) } };
      const text = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (text) {
        const rx = { $regex: escapeRegex(text), $options: "i" };
        vFilter.$or = [{ code: rx }, { name_kh: rx }, { name_en: rx }, { barcode: text }, { "unit_barcodes.barcode": text }];
      }
      const variants = await VariantModel.find(vFilter).select("product_id code name_kh name_en options min_stock status sort_order").lean();
      const balances = await StockBalanceModel.find({ variant_id: { $in: variants.map((v) => v._id) }, warehouse_id: { $in: whs.map((w) => w._id) } }).lean();
      const balMap = new Map(balances.map((b) => [`${b.variant_id}|${b.warehouse_id}`, b]));

      let rows = variants.map((v) => {
        const p = pById.get(String(v.product_id));
        const min = v.min_stock ?? p.min_stock ?? 0;
        const per = whs.map((w) => {
          const b = balMap.get(`${v._id}|${w._id}`);
          const qty = b?.qty || 0;
          return { warehouse_id: w._id, code: w.code, type: w.type, qty, avg_cost: b?.avg_cost || 0, total_value: b?.total_value || 0, low: w.type === "shop" && min > 0 && qty <= min };
        });
        return {
          variant_id: v._id,
          sku: v.code,
          name_kh: v.name_kh,
          name_en: v.name_en,
          options: v.options,
          status: v.status,
          product: { _id: p._id, code: p.code, name_kh: p.name_kh, name_en: p.name_en, image: p.image, track_batch: p.track_batch, base_unit: p.base_unit_id },
          min_stock: min,
          warehouses: per,
          total_qty: round(per.reduce((t, x) => t + x.qty, 0), 4),
          total_value: round(per.reduce((t, x) => t + x.total_value, 0), 4),
          low: per.some((x) => x.low),
          negative: per.some((x) => x.qty < 0),
          _sort: `${p.code}|${String(v.sort_order).padStart(4, "0")}`,
        };
      });
      const only = req.query.only;
      if (only === "low") rows = rows.filter((r) => r.low);
      if (only === "negative") rows = rows.filter((r) => r.negative);
      if (only === "in_stock") rows = rows.filter((r) => r.total_qty > 0);
      if (only === "out") rows = rows.filter((r) => r.total_qty <= 0);
      rows.sort((a, b) => (a._sort < b._sort ? -1 : 1));

      const summary = {
        variants: rows.length,
        total_qty: round(rows.reduce((t, r) => t + r.total_qty, 0), 4),
        total_value: round(rows.reduce((t, r) => t + r.total_value, 0), 2),
        low: rows.filter((r) => r.low).length,
        negative: rows.filter((r) => r.negative).length,
      };
      const pageRows = rows.slice((page - 1) * limit, page * limit);
      // ?with_price=true (one warehouse): current sale price of the base unit (shop price, else default)
      if (req.query.with_price === "true" && whs.length === 1) {
        const PriceModel = require("../product/price/price.model");
        const { activeAt } = require("../product/price/price.service");
        const now = new Date();
        const prices = await PriceModel.find({ variant_id: { $in: pageRows.map((r) => r.variant_id) }, warehouse_id: { $in: [null, whs[0]._id] }, deleted: false, ...activeAt(now) }).lean();
        pageRows.forEach((r) => {
          const baseId = String(r.product.base_unit?._id || "");
          const mine = prices.filter((p) => String(p.variant_id) === String(r.variant_id) && String(p.unit_id) === baseId);
          const shop = mine.find((p) => p.warehouse_id && p.price !== null);
          const def = mine.find((p) => !p.warehouse_id);
          r.price = shop ? shop.price : def ? def.price : null;
          r.price_source = shop ? "shop" : def ? "default" : null;
        });
      }
      const data = pageRows.map(({ _sort, ...r }) => {
        r.warehouses.forEach((w) => hideCost(req, w));
        return hideCost(req, r);
      });
      if (req.warehouse_ids) delete summary.total_value;
      res.status(200).json({
        success: true,
        data,
        warehouses: whs.map((w) => ({ _id: w._id, code: w.code, name_kh: w.name_kh, name_en: w.name_en, type: w.type })),
        summary,
        pagination: { total: rows.length, totalPages: Math.ceil(rows.length / limit), currentPage: page, pageSize: limit },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== MOVEMENTS (ledger) ================================================
  // GET /stock/movement?warehouse_id=&variant_id=&product_id=&batch_id=&type=&ref_type=&from=&to=
  prop.app.get(`${base}/movement`, ...viewGuard, async (req, res) => {
    try {
      const { warehouse_id, variant_id, product_id, batch_id, type, ref_type, from, to, ...rest } = req.query;
      const extra = [];
      if (req.warehouse_ids) extra.push({ warehouse_id: { $in: req.warehouse_ids } });
      if (isId(warehouse_id)) extra.push({ warehouse_id: oid(warehouse_id) });
      if (isId(variant_id)) extra.push({ variant_id: oid(variant_id) });
      if (isId(product_id)) extra.push({ product_id: oid(product_id) });
      if (isId(batch_id)) extra.push({ batch_id: oid(batch_id) });
      if (type) extra.push({ type: { $in: String(type).split(",") } });
      if (ref_type) extra.push({ ref_type });
      if (from) extra.push({ movement_date: { $gte: new Date(from) } });
      if (to) extra.push({ movement_date: { $lte: new Date(to) } });
      if (!rest.sort) rest.sort = "movement_date";
      rest.includeDeleted = "true"; // ledger rows are never deleted
      const result = await getFilteredMongoDB(
        rest,
        StockMovementModel,
        [
          { path: "warehouse_id", select: "code name_kh name_en type" },
          { path: "variant_id", select: "code name_kh name_en options" },
          { path: "batch_id", select: "batch_no expiry_date" },
          { path: "created_by", select: "firstname lastname email" },
        ],
        extra,
      );
      const data = result.data.map((m) => hideCost(req, m.toJSON()));
      res.status(200).json({ success: true, data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== EXPIRY ================================================
  // GET /stock/expiry?warehouse_id=&days= (default Setting.expiry_alert_days) &include_expired=true
  // → batch rows with qty > 0 expiring within `days`, nearest first, with days_left
  prop.app.get(`${base}/expiry`, ...viewGuard, async (req, res) => {
    try {
      const whs = await warehousesFor(req, req.query.warehouse_id);
      if (!whs) return res.status(403).json({ success: false, message: "អ្នកមិនមានសិទ្ធិមើលឃ្លាំងនេះទេ!" });
      const setting = await SettingModel.getMain();
      const days = Math.max(0, parseInt(req.query.days, 10) || setting?.expiry_alert_days || 60);
      const now = new Date();
      const limitDate = new Date(now.getTime() + days * 86400000);
      const f = { warehouse_id: { $in: whs.map((w) => w._id) }, qty: { $gt: 0 }, expiry_date: { $ne: null, $lte: limitDate } };
      if (req.query.include_expired === "false") f.expiry_date.$gt = now;
      const rows = await StockBatchBalanceModel.find(f)
        .sort({ expiry_date: 1 })
        .limit(500)
        .populate([
          { path: "warehouse_id", select: "code name_kh name_en type" },
          { path: "variant_id", select: "code name_kh name_en options" },
          { path: "batch_id", select: "batch_no expiry_date mfg_date" },
        ])
        .lean();
      const data = rows.map((r) => ({ ...r, days_left: Math.ceil((new Date(r.expiry_date) - now) / 86400000), expired: new Date(r.expiry_date) <= now }));
      res.status(200).json({ success: true, data, days });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== AVAILABILITY (forms) ================================================
  // GET /stock/availability?warehouse_id=&variant_ids=a,b → { <variantId>: { qty, avg_cost, batches: [{ batch_id, batch_no, expiry_date, qty, expired }] } }
  prop.app.get(`${base}/availability`, ...viewGuard, async (req, res) => {
    try {
      const { warehouse_id } = req.query;
      if (!isId(warehouse_id) || !canAccessWarehouse(req, warehouse_id)) return res.status(403).json({ success: false, message: "អ្នកមិនមានសិទ្ធិមើលឃ្លាំងនេះទេ!" });
      const ids = String(req.query.variant_ids || "").split(",").filter(isId).slice(0, 300).map(oid);
      const [bals, bbs] = await Promise.all([
        StockBalanceModel.find({ warehouse_id, variant_id: { $in: ids } }).lean(),
        StockBatchBalanceModel.find({ warehouse_id, variant_id: { $in: ids }, qty: { $gt: 0 } }).populate("batch_id", "batch_no expiry_date").sort({ expiry_date: 1 }).lean(),
      ]);
      const now = new Date();
      const out = {};
      ids.forEach((id) => (out[String(id)] = { qty: 0, avg_cost: 0, batches: [] }));
      bals.forEach((b) => Object.assign(out[String(b.variant_id)], { qty: b.qty, avg_cost: b.avg_cost }));
      bbs.forEach((b) =>
        out[String(b.variant_id)].batches.push({ batch_id: b.batch_id._id, batch_no: b.batch_id.batch_no, expiry_date: b.batch_id.expiry_date, qty: b.qty, expired: !!(b.expiry_date && b.expiry_date <= now) }),
      );
      Object.values(out).forEach((o) => hideCost(req, o));
      res.status(200).json({ success: true, data: out });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // GET /stock/fefo?warehouse_id=&variant_id=&qty= → suggested batches (preview before dispatch)
  prop.app.get(`${base}/fefo`, ...viewGuard, async (req, res) => {
    try {
      const { warehouse_id, variant_id } = req.query;
      if (!isId(warehouse_id) || !canAccessWarehouse(req, warehouse_id) || !isId(variant_id)) return res.status(400).json({ success: false, message: "warehouse_id / variant_id មិនត្រឹមត្រូវ" });
      const r = await allocateFefo(warehouse_id, variant_id, Number(req.query.qty) || 0);
      res.status(200).json({ success: true, data: r });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
