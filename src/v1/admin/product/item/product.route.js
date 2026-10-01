const mongoose = require("mongoose");
const ProductModel = require("./product.model");
const VariantModel = require("./variant.model");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { checkValidtion, escapeRegex } = require("../../../../util/helper");
const { saveSortOrder } = require("../../../../util/sort_order");
const { serverError, noIDFound } = require("../../../../util/master_crud");
const { can_manage_product, can_view_master } = require("../../../../util/permission");
const { buildProduct, categoryWithChildren, productIdsByVariantText, isId } = require("./product.service");
const { priceRanges } = require("../price/price.service");

const document = "ទំនិញ";
const noDataFound = "មិនមានទំនិញនៅក្នុងប្រព័ន្ធ!";
const noBarcode = "រកមិនឃើញទំនិញដែលមានបាកូដនេះទេ!";

const POPULATE = [
  { path: "category_id", select: "code name_kh name_en" },
  { path: "brand_id", select: "code name_kh name_en" },
  { path: "base_unit_id", select: "code name_kh name_en" },
  { path: "units.unit_id", select: "code name_kh name_en" },
  { path: "attribute_ids", select: "code name_kh name_en type" },
];
const VARIANT_POPULATE = [{ path: "unit_barcodes.unit_id", select: "code name_kh name_en" }];
const PRODUCT_BRIEF = "code name_kh name_en category_id brand_id base_unit_id units image track_stock track_batch min_stock allow_discount is_taxable status";

const StockMovementModel = require("../../stock/movement.model");
const { StockBalanceModel } = require("../../stock/balance.model");

// Once a product has stock history: base unit, batch tracking and the factor of an existing unit are locked;
// a variant that still has stock cannot be removed.
async function stockLock(current, built) {
  const used = await StockMovementModel.exists({ product_id: current._id });
  if (used) {
    if (String(built.product.base_unit_id) !== String(current.base_unit_id)) return "មិនអាចប្តូរឯកតាមូលដ្ឋានបានទេ ព្រោះទំនិញមានប្រវត្តិស្តុករួចហើយ!";
    if (!!built.product.track_batch !== !!current.track_batch) return "មិនអាចប្តូរការតាមដាន Batch បានទេ ព្រោះទំនិញមានប្រវត្តិស្តុករួចហើយ!";
    for (const u of current.units) {
      const nu = built.product.units.find((x) => String(x.unit_id) === String(u.unit_id));
      if (nu && Number(nu.factor) !== Number(u.factor)) return "មិនអាចប្តូរចំនួនបម្លែងឯកតាបានទេ ព្រោះទំនិញមានប្រវត្តិស្តុករួចហើយ!";
    }
  }
  if (built.removeIds.length && (await StockBalanceModel.exists({ variant_id: { $in: built.removeIds }, qty: { $ne: 0 } })))
    return "មិនអាចលុបប្រភេទរងដែលនៅមានស្តុកបានទេ!";
  return null;
}

// /api/admin/product/item     — Product (style) + its variants (SKU)
// /api/admin/product/variant  — flat variant list (pickers, stock, price, POS sync)
const route = (prop) => {
  const base = `/${prop.main_route}/product/item`;
  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master];
  const editGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_product];

  const nameOf = (d) => `${d.name_kh} (${d.code})`;
  const variantsOf = (productId, session) =>
    VariantModel.find({ product_id: productId, deleted: false }).sort({ sort_order: 1 }).session(session || null);

  async function fullProduct(id) {
    const product = await ProductModel.findOne({ _id: id, deleted: false }).populate(POPULATE);
    if (!product) return null;
    const variants = await VariantModel.find({ product_id: id, deleted: false }).sort({ sort_order: 1 }).populate(VARIANT_POPULATE);
    return { ...product.toJSON(), variants };
  }

  // write product + variants in one transaction
  async function saveAll({ productId, product, variants, removeIds, userId }) {
    const session = await mongoose.startSession();
    try {
      let saved;
      await session.withTransaction(async () => {
        if (productId) {
          saved = await ProductModel.findOneAndUpdate(
            { _id: productId, deleted: false },
            { ...product, updated_by: userId },
            { returnDocument: "after", runValidators: true, session },
          );
        } else {
          [saved] = await ProductModel.create([{ ...product, deleted: false, created_by: userId, updated_by: userId }], { session });
        }
        if (removeIds.length) {
          await VariantModel.updateMany({ _id: { $in: removeIds } }, { deleted: true, updated_by: userId }, { session });
        }
        for (const v of variants) {
          const { isNew, _id, ...fields } = v;
          if (isNew) {
            await VariantModel.create([{ _id, ...fields, product_id: saved._id, deleted: false, created_by: userId, updated_by: userId }], { session });
          } else {
            await VariantModel.updateOne({ _id }, { ...fields, updated_by: userId }, { session, runValidators: true });
          }
        }
      });
      return saved;
    } finally {
      await session.endSession();
    }
  }

  // ===================================== CREATE ================================================
  // body: product fields + variants: [{ options: [{ attribute_id, value_id }], code?, barcode, unit_barcodes, image, min_stock, status }]
  prop.app.post(`${base}`, ...editGuard, async (req, res) => {
    try {
      const ok = checkValidtion(res, req, [
        { key: "code", label: "កូដទំនិញ" },
        { key: "name_kh", label: "ឈ្មោះ (ខ្មែរ)" },
        { key: "category_id", label: "ប្រភេទទំនិញ" },
        { key: "base_unit_id", label: "ឯកតាមូលដ្ឋាន" },
      ]);
      if (!ok) return;
      const { user_id: userId } = req.session;

      const built = await buildProduct(req.body || {}, null, []);
      if (built.error) return res.status(built.status || 400).json({ success: false, message: built.error });

      const saved = await saveAll({ productId: null, ...built, userId });
      const data = await fullProduct(saved._id);

      await logActivity({
        title: `${document}ថ្មី ${nameOf(saved)} ត្រូវបានបង្កើត (${built.variants.length} ប្រភេទរង)!`,
        description: `បង្កើតដោយគណនី: ${req.user.email}`,
        categoryTitle: "product",
        createdBy: userId,
        req,
      });
      res.status(201).json({ success: true, data, message: `${document}ថ្មីត្រូវបានរក្សារទុក!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET LIST ================================================
  // ?q= (code, name, SKU, barcode) · ?category_id= (with sub-categories) · ?brand_id= · ?track_batch= · ?status= · ?attribute_id=
  prop.app.get(`${base}`, ...viewGuard, async (req, res) => {
    try {
      const { q, category_id, brand_id, track_batch, status, attribute_id, ...rest } = req.query;
      const extra = [];
      if (isId(category_id)) extra.push({ category_id: { $in: await categoryWithChildren(category_id) } });
      if (isId(brand_id)) extra.push({ brand_id: new mongoose.Types.ObjectId(brand_id) });
      if (isId(attribute_id)) extra.push({ attribute_ids: new mongoose.Types.ObjectId(attribute_id) });
      if (track_batch === "true" || track_batch === "false") extra.push({ track_batch: track_batch === "true" });
      if (status === "true" || status === "false") extra.push({ status: status === "true" });
      const text = typeof q === "string" ? q.trim() : "";
      if (text) {
        const rx = { $regex: escapeRegex(text), $options: "i" };
        const ids = await productIdsByVariantText(text);
        extra.push({ $or: [{ code: rx }, { name_kh: rx }, { name_en: rx }, { _id: { $in: ids } }] });
      }
      const result = await getFilteredMongoDB(rest, ProductModel, POPULATE, extra);
      // price_range: current default price of the base unit { min, max, count } (count < variant_count → some have no price)
      const ranges = await priceRanges(result.data.map((p) => p._id));
      const data = result.data.map((p) => ({ ...p.toJSON(), price_range: ranges[String(p._id)] || null }));
      res.status(200).json({ success: true, data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET ALL (dropdown) ================================================
  prop.app.get(`${base}-all`, ...viewGuard, async (req, res) => {
    try {
      const data = await ProductModel.find({ deleted: false, status: true })
        .select("code name_kh name_en category_id base_unit_id units attribute_ids variant_count track_batch image")
        .populate([{ path: "base_unit_id", select: "code name_kh name_en" }, { path: "units.unit_id", select: "code name_kh name_en" }])
        .sort({ sort_order: 1, code: 1 });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SORT ================================================
  prop.app.put(`${base}-sort`, ...editGuard, async (req, res) => {
    try {
      const result = await saveSortOrder(ProductModel, req.body.items, req.session.user_id);
      if (!result.ok) return res.status(400).json({ success: false, message: result.message });
      res.status(200).json({ success: true, message: "លំដាប់ត្រូវបានរក្សាទុក!", data: { modified: result.modified } });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== BARCODE / SKU LOOKUP ================================================
  // → { product, variant, unit: { unit_id, code, name_kh, name_en, factor, is_base } }
  prop.app.get(`${base}/barcode/:barcode`, ...viewGuard, async (req, res) => {
    try {
      const code = String(req.params.barcode || "").trim();
      if (!code) return res.status(400).json({ success: false, message: noBarcode });
      const variant =
        (await VariantModel.findOne({ deleted: false, $or: [{ barcode: code }, { "unit_barcodes.barcode": code }] })) ||
        (await VariantModel.findOne({ deleted: false, code: code.toUpperCase() }));
      if (!variant) return res.status(404).json({ success: false, message: noBarcode });
      const product = await ProductModel.findOne({ _id: variant.product_id, deleted: false }).populate(POPULATE);
      if (!product) return res.status(404).json({ success: false, message: noBarcode });

      const ub = variant.unit_barcodes.find((u) => u.barcode === code);
      let unit;
      if (ub) {
        const pu = product.units.find((u) => String(u.unit_id?._id) === String(ub.unit_id));
        unit = { unit_id: pu.unit_id._id, code: pu.unit_id.code, name_kh: pu.unit_id.name_kh, name_en: pu.unit_id.name_en, factor: pu.factor, is_base: false };
      } else {
        const bu = product.base_unit_id;
        unit = { unit_id: bu._id, code: bu.code, name_kh: bu.name_kh, name_en: bu.name_en, factor: 1, is_base: true };
      }
      res.status(200).json({ success: true, data: { product, variant, unit } });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== CHECK CODE / BARCODE (form helper) ================================================
  // ?value=ABC&product_id=<skip this product> → { product_code, sku, barcode } each { free, used_by }
  prop.app.get(`${base}/check-code`, ...viewGuard, async (req, res) => {
    try {
      const value = String(req.query.value || "").trim();
      if (!value) return res.status(400).json({ success: false, message: "សូមបញ្ចូលកូដ" });
      const skip = isId(req.query.product_id) ? req.query.product_id : null;
      const pFilter = { deleted: false, ...(skip ? { _id: { $ne: skip } } : {}) };
      const vFilter = { deleted: false, ...(skip ? { product_id: { $ne: skip } } : {}) };
      const [p, sku, bc] = await Promise.all([
        ProductModel.findOne({ ...pFilter, code: value.toUpperCase() }).select("code name_kh").lean(),
        VariantModel.findOne({ ...vFilter, code: value.toUpperCase() }).select("code name_kh").lean(),
        VariantModel.findOne({ ...vFilter, $or: [{ barcode: value }, { "unit_barcodes.barcode": value }] }).select("code name_kh").lean(),
      ]);
      const r = (x) => ({ free: !x, used_by: x ? `${x.name_kh} (${x.code})` : null });
      res.status(200).json({ success: true, data: { product_code: r(p), sku: r(sku), barcode: r(bc) } });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET BY ID (with variants) ================================================
  prop.app.get(`${base}/:id`, ...viewGuard, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ success: false, message: noIDFound });
      const data = await fullProduct(id);
      if (!data) return res.status(404).json({ success: false, message: noDataFound });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== UPDATE ================================================
  // Send only what changes. `variants` (when sent) is the full list:
  //   with _id → update · without _id → new · existing not in the list → deleted
  prop.app.put(`${base}/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!isId(id)) return res.status(400).json({ success: false, message: noIDFound });
      const current = await ProductModel.findOne({ _id: id, deleted: false });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });
      if (!req.body || !Object.keys(req.body).length) return res.status(400).json({ success: false, message: "មិនមានទិន្នន័យដើម្បីកែប្រែ!" });

      const currentVariants = await variantsOf(id);
      const built = await buildProduct(req.body, current, currentVariants);
      if (built.error) return res.status(built.status || 400).json({ success: false, message: built.error });
      const locked = await stockLock(current, built);
      if (locked) return res.status(400).json({ success: false, message: locked });

      await saveAll({ productId: id, ...built, userId });
      const data = await fullProduct(id);

      const changed = Object.keys(req.body).filter((k) => k !== "variants");
      const vInfo = req.body.variants
        ? ` · ប្រភេទរង: ${built.variants.filter((v) => v.isNew).length} ថ្មី, ${built.variants.filter((v) => !v.isNew).length} កែ, ${built.removeIds.length} លុប`
        : "";
      await logActivity({
        title: `${document} ${nameOf(data)} ត្រូវបានកែប្រែ!`,
        description: `គណនី: ${req.user.email} បានកែប្រែ: ${changed.join(", ")}${vInfo}`.slice(0, 600),
        categoryTitle: "product",
        createdBy: userId,
        req,
      });
      res.status(200).json({ success: true, data, message: `${document} ${nameOf(data)} ត្រូវបានកែប្រែ និងរក្សារទុក!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SOFT DELETE (product + variants) ================================================
  prop.app.delete(`${base}/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!isId(id)) return res.status(400).json({ success: false, message: noIDFound });
      const current = await ProductModel.findOne({ _id: id, deleted: false });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });
      if (await StockBalanceModel.exists({ product_id: id, qty: { $ne: 0 } }))
        return res.status(400).json({ success: false, message: "មិនអាចលុបទំនិញដែលនៅមានស្តុកបានទេ!" });

      current.deleted = true;
      current.updated_by = userId;
      await current.save();
      await VariantModel.updateMany({ product_id: id, deleted: false }, { deleted: true, deleted_with_product: true, updated_by: userId });

      await logActivity({
        title: `${document} ${nameOf(current)} ត្រូវបានលុប!`,
        description: `គណនី: ${req.user.email} បានលុបទិន្នន័យចេញពីប្រព័ន្ធ។`,
        categoryTitle: "product",
        createdBy: userId,
        req,
      });
      res.status(200).json({ success: true, data: `${document} ${nameOf(current)} បានលុប`, message: `${document} ${nameOf(current)} ត្រូវបានលុបចេញពីប្រព័ន្ធ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== RESTORE ================================================
  prop.app.put(`${base}/restore/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!isId(id)) return res.status(400).json({ success: false, message: noIDFound });
      const current = await ProductModel.findOne({ _id: id, deleted: true });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });

      const variants = await VariantModel.find({ product_id: id, deleted: true, deleted_with_product: true });
      if (await ProductModel.exists({ code: current.code, deleted: false }))
        return res.status(409).json({ success: false, message: "កូដទំនិញនេះមាននៅក្នុងប្រព័ន្ធរួចហើយ!" });
      const codes = variants.map((v) => v.code);
      const bcs = variants.flatMap((v) => [v.barcode, ...v.unit_barcodes.map((u) => u.barcode)]).filter(Boolean);
      const clash = await VariantModel.findOne({
        deleted: false,
        $or: [{ code: { $in: codes } }, { barcode: { $in: bcs } }, { "unit_barcodes.barcode": { $in: bcs } }],
      }).select("code").lean();
      if (clash) return res.status(409).json({ success: false, message: `SKU / បាកូដ ត្រូវបានប្រើដោយ ${clash.code} រួចហើយ!` });

      current.deleted = false;
      current.updated_by = userId;
      await current.save();
      await VariantModel.updateMany({ _id: { $in: variants.map((v) => v._id) } }, { deleted: false, deleted_with_product: false, updated_by: userId });

      await logActivity({
        title: `${document} ${nameOf(current)} ត្រូវបានស្តារឡើងវិញ!`,
        description: `គណនី: ${req.user.email} បានស្តារទិន្នន័យចូលក្នុងប្រព័ន្ធ។`,
        categoryTitle: "product",
        createdBy: userId,
        req,
      });
      res.status(200).json({ success: true, data: await fullProduct(id), message: `${document} ${nameOf(current)} បានស្តារឡើងវិញ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== VARIANT LIST (flat) ================================================
  // ?q= (SKU, name, barcode) · ?product_id= · ?category_id= · ?status= · ?ids=  → rows with product_id populated
  const vBase = `/${prop.main_route}/product/variant`;
  prop.app.get(`${vBase}`, ...viewGuard, async (req, res) => {
    try {
      const { q, product_id, category_id, status, ids, ...rest } = req.query;
      const extra = [];
      // ?ids=a,b,c → these variants only (document editors)
      if (ids) extra.push({ _id: { $in: String(ids).split(",").filter(isId).slice(0, 300).map((x) => new mongoose.Types.ObjectId(x)) } });
      // only variants of live products
      const pFilter = { deleted: false };
      if (isId(category_id)) pFilter.category_id = { $in: await categoryWithChildren(category_id) };
      if (isId(product_id)) pFilter._id = new mongoose.Types.ObjectId(product_id);
      extra.push({ product_id: { $in: await ProductModel.distinct("_id", pFilter) } });
      if (status === "true" || status === "false") extra.push({ status: status === "true" });
      const text = typeof q === "string" ? q.trim() : "";
      if (text) {
        const rx = { $regex: escapeRegex(text), $options: "i" };
        extra.push({ $or: [{ code: rx }, { name_kh: rx }, { name_en: rx }, { barcode: text }, { "unit_barcodes.barcode": text }] });
      }
      if (!rest.sort) rest.sort = "code";
      if (!rest.order) rest.order = "asc";
      const result = await getFilteredMongoDB(rest, VariantModel, [
        { path: "product_id", select: PRODUCT_BRIEF, populate: [{ path: "base_unit_id", select: "code name_kh name_en" }, { path: "units.unit_id", select: "code name_kh name_en" }] },
        ...VARIANT_POPULATE,
      ], extra);
      res.status(200).json({ success: true, data: result.data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  prop.app.get(`${vBase}/:id`, ...viewGuard, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ success: false, message: noIDFound });
      const data = await VariantModel.findOne({ _id: id, deleted: false }).populate([
        { path: "product_id", select: PRODUCT_BRIEF, populate: [{ path: "base_unit_id", select: "code name_kh name_en" }, { path: "units.unit_id", select: "code name_kh name_en" }] },
        ...VARIANT_POPULATE,
      ]);
      if (!data) return res.status(404).json({ success: false, message: "មិនមានប្រភេទរងនៅក្នុងប្រព័ន្ធ!" });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
