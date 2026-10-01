const mongoose = require("mongoose");
const PriceModel = require("./price.model");
const VariantModel = require("../item/variant.model");
const ProductModel = require("../item/product.model");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { escapeRegex } = require("../../../../util/helper");
const { serverError, noIDFound } = require("../../../../util/master_crud");
const { can_manage_product, can_view_master } = require("../../../../util/permission");
const { warehouse_scope, canAccessWarehouse } = require("../../../../util/warehouse_scope");
const { categoryWithChildren } = require("../item/product.service");
const { checkItem, startDate, insertPrices, removeUpcoming, priceGrid, activeAt, stateOf, isId } = require("./price.service");

const telegram = require("../../telegram/telegram.hooks");
const document = "តម្លៃលក់";
const MAX_BULK = 500;
const POPULATE = [
  { path: "variant_id", select: "code name_kh name_en options" },
  { path: "unit_id", select: "code name_kh name_en" },
  { path: "warehouse_id", select: "code name_kh name_en type" },
  { path: "created_by", select: "firstname lastname email" },
];
const money = (v) => (v === null ? "តម្លៃលំនាំដើម" : `$${v}`);

// /api/admin/product/price — sale prices (USD) with history; default + per-shop override
// view: all web roles (shop manager: default + own shops) · edit: admin, central manager
const route = (prop) => {
  const base = `/${prop.main_route}/product/price`;
  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope];
  const editGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_product];

  // ===================================== SET ONE PRICE ================================================
  // { variant_id, unit_id?, warehouse_id?: null | shop, price, effective_from? }  (no date / past = now)
  prop.app.post(`${base}`, ...editGuard, async (req, res) => {
    try {
      const { user_id: userId } = req.session;
      const start = startDate(req.body?.effective_from);
      if (start.error) return res.status(400).json({ success: false, message: start.error });
      const item = await checkItem(req.body || {});
      if (item.error) return res.status(400).json({ success: false, message: item.error });

      const result = await insertPrices([{ ...item.row, effective_from: start.date }], userId);
      if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });
      const data = await PriceModel.findById(result.saved[0]._id).populate(POPULATE);

      await logActivity({
        title: `${document} ${item.variant.code} = ${money(item.row.price)}${item.row.warehouse_id ? ` (ហាង ${data.warehouse_id?.code})` : ""}`,
        description: `គណនី: ${req.user.email} · ឯកតា ${data.unit_id?.code} · ចាប់ពី ${start.date.toISOString()}`,
        categoryTitle: "price",
        createdBy: userId,
        req,
      });
      telegram.priceChanged([{ sku: item.variant.code, unit: data.unit_id?.code, price: item.row.price, warehouse_id: item.row.warehouse_id, shop: data.warehouse_id?.code }], start.date, req);
      res.status(201).json({ success: true, data, message: `${document}ថ្មីត្រូវបានរក្សារទុក!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== BULK ================================================
  // { effective_from?, items: [{ variant_id, unit_id?, warehouse_id?, price }] } — all or nothing
  prop.app.post(`${base}/bulk`, ...editGuard, async (req, res) => {
    try {
      const { user_id: userId } = req.session;
      const items = req.body?.items;
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ success: false, message: "សូមបញ្ចូល items" });
      if (items.length > MAX_BULK) return res.status(400).json({ success: false, message: `បានច្រើនបំផុត ${MAX_BULK} ក្នុងមួយដង` });
      const start = startDate(req.body.effective_from);
      if (start.error) return res.status(400).json({ success: false, message: start.error });

      const cache = new Map();
      const rows = [];
      const skus = [];
      for (const [i, it] of items.entries()) {
        const item = await checkItem(it || {}, cache);
        if (item.error) return res.status(400).json({ success: false, message: `ជួរទី ${i + 1}: ${item.error}` });
        rows.push({ ...item.row, effective_from: start.date });
        skus.push({ sku: item.variant.code, price: item.row.price, warehouse_id: item.row.warehouse_id });
      }
      const result = await insertPrices(rows, userId);
      if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });

      await logActivity({
        title: `${document} ${rows.length} ត្រូវបានកំណត់`,
        description: `គណនី: ${req.user.email} · ចាប់ពី ${start.date.toISOString()}`,
        categoryTitle: "price",
        createdBy: userId,
        req,
      });
      telegram.priceChanged(skus, start.date, req);
      res.status(201).json({ success: true, data: { count: result.saved.length, effective_from: start.date }, message: `${document} ${rows.length} ត្រូវបានរក្សារទុក!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== CURRENT PRICES (grid) ================================================
  // ?product_id= | ?variant_id= | ?category_id= & q= (SKU / name) · ?warehouse_id=<shop> → price + source per unit
  // paginated over variants (limit ≤ 200)
  prop.app.get(`${base}/current`, ...viewGuard, async (req, res) => {
    try {
      const { product_id, variant_id, category_id, warehouse_id, q } = req.query;
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      if (warehouse_id && (!isId(warehouse_id) || !canAccessWarehouse(req, warehouse_id)))
        return res.status(403).json({ success: false, message: "អ្នកមិនមានសិទ្ធិមើលហាងនេះទេ!" });

      const pFilter = { deleted: false };
      if (isId(product_id)) pFilter._id = new mongoose.Types.ObjectId(product_id);
      if (isId(category_id)) pFilter.category_id = { $in: await categoryWithChildren(category_id) };
      const vFilter = { deleted: false, product_id: { $in: await ProductModel.distinct("_id", pFilter) } };
      if (isId(variant_id)) vFilter._id = new mongoose.Types.ObjectId(variant_id);
      const text = typeof q === "string" ? q.trim() : "";
      if (text) {
        const rx = { $regex: escapeRegex(text), $options: "i" };
        vFilter.$or = [{ code: rx }, { name_kh: rx }, { name_en: rx }, { barcode: text }, { "unit_barcodes.barcode": text }];
      }
      const [variants, total] = await Promise.all([
        VariantModel.find(vFilter).sort({ product_id: 1, sort_order: 1 }).skip((page - 1) * limit).limit(limit).lean(),
        VariantModel.countDocuments(vFilter),
      ]);
      const data = await priceGrid(variants, { warehouseId: warehouse_id || null, shopIds: req.warehouse_ids });
      res.status(200).json({ success: true, data, pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page, pageSize: limit } });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== HISTORY ================================================
  // ?variant_id=&product_id=&unit_id=&warehouse_id=<id | default>&state=current|upcoming|past
  prop.app.get(`${base}`, ...viewGuard, async (req, res) => {
    try {
      const { variant_id, product_id, unit_id, warehouse_id, state, ...rest } = req.query;
      const extra = [];
      if (isId(variant_id)) extra.push({ variant_id: new mongoose.Types.ObjectId(variant_id) });
      if (isId(product_id)) extra.push({ product_id: new mongoose.Types.ObjectId(product_id) });
      if (isId(unit_id)) extra.push({ unit_id: new mongoose.Types.ObjectId(unit_id) });
      if (warehouse_id === "default") extra.push({ warehouse_id: null });
      else if (isId(warehouse_id)) {
        if (!canAccessWarehouse(req, warehouse_id)) return res.status(403).json({ success: false, message: "អ្នកមិនមានសិទ្ធិមើលហាងនេះទេ!" });
        extra.push({ warehouse_id: new mongoose.Types.ObjectId(warehouse_id) });
      }
      // shop manager: defaults + own shops only
      if (req.warehouse_ids) extra.push({ warehouse_id: { $in: [null, ...req.warehouse_ids] } });
      const now = new Date();
      if (state === "current") extra.push(activeAt(now));
      if (state === "upcoming") extra.push({ effective_from: { $gt: now } });
      if (state === "past") extra.push({ effective_to: { $ne: null, $lte: now } });
      if (!rest.sort) rest.sort = "effective_from";
      const result = await getFilteredMongoDB(rest, PriceModel, POPULATE, extra);
      const data = result.data.map((r) => ({ ...r.toJSON(), state: stateOf(r, now) }));
      res.status(200).json({ success: true, data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== DELETE (upcoming only) ================================================
  prop.app.delete(`${base}/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!isId(id)) return res.status(400).json({ success: false, message: noIDFound });
      const row = await PriceModel.findOne({ _id: id, deleted: false }).populate(POPULATE);
      if (!row) return res.status(404).json({ success: false, message: `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!` });
      if (row.effective_from <= new Date())
        return res.status(400).json({ success: false, message: `${document}ដែលបានចាប់ផ្តើមប្រើរួច មិនអាចលុបបានទេ (សូមកំណត់តម្លៃថ្មី)!` });

      await removeUpcoming(row, userId);
      await logActivity({
        title: `${document} ${row.variant_id?.code} = ${money(row.price)} (មិនទាន់ចាប់ផ្តើម) ត្រូវបានលុប`,
        description: `គណនី: ${req.user.email}`,
        categoryTitle: "price",
        createdBy: userId,
        req,
      });
      res.status(200).json({ success: true, data: id, message: `${document}ត្រូវបានលុប!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
