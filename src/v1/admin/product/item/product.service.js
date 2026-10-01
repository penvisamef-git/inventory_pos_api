const mongoose = require("mongoose");
const ProductModel = require("./product.model");
const VariantModel = require("./variant.model");
const CategoryModel = require("../category/category.model");
const BrandModel = require("../brand/brand.model");
const UnitModel = require("../unit/unit.model");
const AttributeModel = require("../attribute/attribute.model");
const { round, escapeRegex } = require("../../../../util/helper");

const CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/; // product code
const SKU = /^[A-Z0-9][A-Z0-9_-]{1,59}$/; // variant code
const BARCODE = /^[A-Za-z0-9-]{3,40}$/;
const MAX_ATTRIBUTES = 3;
const MAX_VARIANTS = 300;

// Fields a client may send for a product
const PRODUCT_KEYS = [
  "code", "name_kh", "name_en", "category_id", "brand_id", "base_unit_id", "units", "attribute_ids",
  "image", "description", "track_stock", "track_batch", "min_stock", "allow_discount", "is_taxable",
  "note", "status",
];

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const bool = (v, def) => (v === undefined ? def : v === true || v === "true");
const toSku = (text) => str(text).toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

// "Baby romper (0-3 ខែ / ផ្កាឈូក)"
function variantName(product, options, lang) {
  const base = lang === "en" ? product.name_en || product.name_kh : product.name_kh;
  if (!options.length) return base;
  const parts = options.map((o) => (lang === "en" ? o.name_en || o.name_kh : o.name_kh));
  return `${base} (${parts.join(" / ")})`;
}

/**
 * Validate a product + its variants (create and update share this).
 *   body     request body (for update: only the keys being changed)
 *   current  existing product (update) or null (create)
 *   currentVariants  existing non-deleted variants of the product (update)
 * → { error } | { product: fields, variants: [rows to save], removeIds: [variant ids to delete] }
 */
async function buildProduct(body, current = null, currentVariants = []) {
  const src = {};
  for (const k of PRODUCT_KEYS) if (body[k] !== undefined) src[k] = body[k];
  const p = current ? { ...current.toObject(), ...src } : src;

  // ---------- product ----------
  p.code = str(p.code).toUpperCase();
  if (!CODE.test(p.code)) return { error: "កូដទំនិញត្រូវជាអក្សរអង់គ្លេស លេខ _ ឬ - (2–40 តួ) ឧ. ROMPER01" };
  p.name_kh = str(p.name_kh);
  if (!p.name_kh) return { error: "សូមបញ្ចូល ឈ្មោះ (ខ្មែរ)" };
  p.name_en = str(p.name_en);

  if (!isId(p.category_id) || !(await CategoryModel.exists({ _id: p.category_id, deleted: false })))
    return { error: "សូមជ្រើសរើសប្រភេទទំនិញឲ្យបានត្រឹមត្រូវ!" };
  if (p.brand_id === "" || p.brand_id === undefined) p.brand_id = null;
  if (p.brand_id && (!isId(p.brand_id) || !(await BrandModel.exists({ _id: p.brand_id, deleted: false }))))
    return { error: "ម៉ាកមិនត្រឹមត្រូវ!" };
  if (!isId(p.base_unit_id) || !(await UnitModel.exists({ _id: p.base_unit_id, deleted: false })))
    return { error: "សូមជ្រើសរើសឯកតាមូលដ្ឋានឲ្យបានត្រឹមត្រូវ!" };

  // other units: [{ unit_id, factor, is_sale_unit, is_purchase_unit }]
  if (!Array.isArray(p.units || [])) return { error: "units ត្រូវជាបញ្ជី!" };
  const units = [];
  const seenUnit = new Set([String(p.base_unit_id)]);
  for (const [i, u] of (p.units || []).entries()) {
    const id = String(u?.unit_id?._id || u?.unit_id || "");
    if (!isId(id) || !(await UnitModel.exists({ _id: id, deleted: false }))) return { error: `ឯកតាទី ${i + 1} មិនត្រឹមត្រូវ!` };
    if (seenUnit.has(id)) return { error: `ឯកតាទី ${i + 1}: ស្ទួនគ្នា ឬដូចឯកតាមូលដ្ឋាន!` };
    const factor = round(u.factor, 4);
    if (!(factor > 0)) return { error: `ឯកតាទី ${i + 1}: ចំនួនបម្លែងត្រូវធំជាង 0` };
    seenUnit.add(id);
    units.push({ unit_id: id, factor, is_sale_unit: bool(u.is_sale_unit, true), is_purchase_unit: bool(u.is_purchase_unit, true) });
  }
  p.units = units;
  const unitIds = new Set(units.map((u) => u.unit_id));

  // variant axes
  const attrIds = (p.attribute_ids || []).map((a) => String(a?._id || a));
  if (new Set(attrIds).size !== attrIds.length) return { error: "លក្ខណៈស្ទួនគ្នា!" };
  if (attrIds.length > MAX_ATTRIBUTES) return { error: `លក្ខណៈបានច្រើនបំផុត ${MAX_ATTRIBUTES}` };
  const attributes = [];
  for (const id of attrIds) {
    const a = isId(id) ? await AttributeModel.findOne({ _id: id, deleted: false }).lean() : null;
    if (!a) return { error: "លក្ខណៈមិនត្រឹមត្រូវ ឬមិនមាននៅក្នុងប្រព័ន្ធ!" };
    attributes.push(a);
  }
  p.attribute_ids = attrIds;

  p.image = p.image && p.image.url ? p.image : null;
  p.description = str(p.description);
  p.track_stock = bool(p.track_stock, true);
  p.track_batch = p.track_stock && bool(p.track_batch, false);
  p.min_stock = Math.max(0, Number(p.min_stock) || 0);
  p.allow_discount = bool(p.allow_discount, true);
  p.is_taxable = bool(p.is_taxable, true);
  p.status = bool(p.status, true);

  // ---------- variants ----------
  // update without `variants` → re-check the existing ones (names / codes follow the product)
  let input = body.variants;
  if (input === undefined) input = current ? currentVariants.map((v) => v.toObject()) : [{}];
  if (!Array.isArray(input)) return { error: "variants ត្រូវជាបញ្ជី!" };
  if (!attributes.length) {
    // simple product: exactly one default variant, keep its id
    const def = currentVariants.find((v) => v.is_default);
    const one = { ...(input[0] || def?.toObject() || {}) };
    if (!one._id && def) one._id = def._id;
    input = [one];
  }
  if (!input.length) return { error: "សូមបង្កើតយ៉ាងហោចណាស់ ១ ប្រភេទរង (variant)!" };
  if (input.length > MAX_VARIANTS) return { error: `ប្រភេទរងបានច្រើនបំផុត ${MAX_VARIANTS}` };

  const currentById = new Map(currentVariants.map((v) => [String(v._id), v]));
  const variants = [];
  const keys = new Set();
  const codes = new Set();
  const barcodes = new Set();

  for (const [i, v] of input.entries()) {
    const n = i + 1;
    const id = v._id ? String(v._id) : null;
    if (id && !currentById.has(id)) return { error: `ប្រភេទរងទី ${n}: ID មិនមែនរបស់ទំនិញនេះទេ!` };
    const old = id ? currentById.get(id) : null;

    // options: one value for each attribute, in attribute order
    const options = [];
    for (const a of attributes) {
      const given = (v.options || []).find((o) => String(o.attribute_id?._id || o.attribute_id) === String(a._id));
      const value = given && a.values.find((x) => String(x._id) === String(given.value_id));
      if (!value) return { error: `ប្រភេទរងទី ${n}: សូមជ្រើស ${a.name_kh}` };
      options.push({
        attribute_id: a._id,
        value_id: value._id,
        attribute_code: a.code,
        value_code: value.code,
        name_kh: value.name_kh,
        name_en: value.name_en || value.name_kh,
        color_hex: value.color_hex || null,
      });
    }
    const option_key = options.map((o) => String(o.value_id)).join("|");
    if (keys.has(option_key)) return { error: `ប្រភេទរងទី ${n}: ជម្រើសស្ទួនគ្នានឹងប្រភេទរងផ្សេង!` };
    keys.add(option_key);

    // code (SKU): default variant follows the product code
    let code = toSku(v.code);
    const isDefault = !attributes.length;
    if (isDefault && (!code || (current && code === current.code))) code = p.code;
    if (!code) code = toSku([p.code, ...options.map((o) => o.value_code)].join("-"));
    if (!SKU.test(code)) return { error: `ប្រភេទរងទី ${n}: កូដ SKU មិនត្រឹមត្រូវ (${code})` };
    if (codes.has(code)) return { error: `កូដ SKU "${code}" ស្ទួនគ្នា!` };
    codes.add(code);

    // barcodes (base unit + other units)
    const barcode = str(v.barcode) || null;
    if (barcode) {
      if (!BARCODE.test(barcode)) return { error: `ប្រភេទរងទី ${n}: បាកូដមិនត្រឹមត្រូវ` };
      if (barcodes.has(barcode)) return { error: `បាកូដ "${barcode}" ស្ទួនគ្នា!` };
      barcodes.add(barcode);
    }
    const unit_barcodes = [];
    const seenUb = new Set();
    for (const ub of v.unit_barcodes || []) {
      const uid = String(ub?.unit_id?._id || ub?.unit_id || "");
      const bc = str(ub?.barcode);
      if (!bc) continue;
      if (!unitIds.has(uid)) return { error: `ប្រភេទរងទី ${n}: បាកូដសម្រាប់ឯកតាដែលទំនិញមិនមាន!` };
      if (seenUb.has(uid)) return { error: `ប្រភេទរងទី ${n}: ឯកតាមួយមានបាកូដតែមួយ` };
      if (!BARCODE.test(bc)) return { error: `ប្រភេទរងទី ${n}: បាកូដមិនត្រឹមត្រូវ (${bc})` };
      if (barcodes.has(bc)) return { error: `បាកូដ "${bc}" ស្ទួនគ្នា!` };
      seenUb.add(uid);
      barcodes.add(bc);
      unit_barcodes.push({ unit_id: uid, barcode: bc });
    }

    const minStock = v.min_stock === undefined || v.min_stock === null || v.min_stock === "" ? null : Math.max(0, Number(v.min_stock) || 0);
    variants.push({
      _id: old ? old._id : new mongoose.Types.ObjectId(),
      isNew: !old,
      code,
      name_kh: variantName(p, options, "kh"),
      name_en: variantName(p, options, "en"),
      options,
      option_key,
      is_default: isDefault,
      barcode,
      unit_barcodes,
      image: v.image && v.image.url ? v.image : null,
      min_stock: minStock,
      sort_order: i,
      status: v.status === undefined ? (old ? old.status : true) : bool(v.status, true),
      note: v.note !== undefined ? str(v.note) : old?.note || "",
    });
  }

  // ---------- unique in the whole database ----------
  const productId = current ? current._id : null;
  const productClash = await ProductModel.exists({ code: p.code, deleted: false, ...(productId ? { _id: { $ne: productId } } : {}) });
  if (productClash) return { error: "កូដទំនិញនេះមាននៅក្នុងប្រព័ន្ធរួចហើយ!", status: 409 };

  const others = { deleted: false, ...(productId ? { product_id: { $ne: productId } } : {}) };
  const codeClash = await VariantModel.findOne({ ...others, code: { $in: [...codes] } }).select("code").lean();
  if (codeClash) return { error: `កូដ SKU "${codeClash.code}" មាននៅក្នុងប្រព័ន្ធរួចហើយ!`, status: 409 };
  if (barcodes.size) {
    const list = [...barcodes];
    const bcClash = await VariantModel.findOne({ ...others, $or: [{ barcode: { $in: list } }, { "unit_barcodes.barcode": { $in: list } }] })
      .select("code barcode unit_barcodes").lean();
    if (bcClash) {
      const used = [bcClash.barcode, ...bcClash.unit_barcodes.map((u) => u.barcode)].find((b) => barcodes.has(b));
      return { error: `បាកូដ "${used}" ត្រូវបានប្រើដោយ ${bcClash.code} រួចហើយ!`, status: 409 };
    }
  }

  const keepIds = new Set(variants.filter((v) => !v.isNew).map((v) => String(v._id)));
  const removeIds = currentVariants.filter((v) => !keepIds.has(String(v._id))).map((v) => v._id);

  const product = {};
  for (const k of PRODUCT_KEYS) if (p[k] !== undefined) product[k] = p[k];
  product.variant_count = variants.length;
  return { product, variants, removeIds };
}

// Category + all its children (for ?category_id= filter)
async function categoryWithChildren(id) {
  const rows = await CategoryModel.find({ deleted: false }).select("parent_id").lean();
  const out = new Set([String(id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parent_id && out.has(String(r.parent_id)) && !out.has(String(r._id))) {
        out.add(String(r._id));
        grew = true;
      }
    }
  }
  return [...out].map((x) => new mongoose.Types.ObjectId(x));
}

// Product ids whose variants match a SKU / barcode / name text
async function productIdsByVariantText(q) {
  const rx = { $regex: escapeRegex(q), $options: "i" };
  return VariantModel.distinct("product_id", {
    deleted: false,
    $or: [{ code: rx }, { barcode: q }, { "unit_barcodes.barcode": q }, { name_kh: rx }, { name_en: rx }],
  });
}

module.exports = { buildProduct, categoryWithChildren, productIdsByVariantText, isId, PRODUCT_KEYS, BARCODE };
