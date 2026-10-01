const mongoose = require("mongoose");
const ProductModel = require("../product/item/product.model");
const VariantModel = require("../product/item/variant.model");
const UnitModel = require("../product/unit/unit.model");
const BatchModel = require("./batch.model");
const { round } = require("../../../util/helper");

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * Validate document lines → { error } | { items }
 * item in : { variant_id | sku, unit_id | unit (code), qty, unit_cost?, batch_no?, expiry_date?, mfg_date?, batch_id?, note? }
 * options :
 *   cost       "required" | "optional" | "none"   unit_cost is per the chosen unit
 *   batch      "in"   → track_batch needs batch_no + expiry_date (new or existing batch)
 *              "out"  → batch_id optional (empty = FEFO when posting)
 *              "none"
 *   signed     qty may be negative (adjustment: + in, − out)
 * item out: { product_id, variant_id, sku, name_kh, name_en, track_batch, unit_id, unit_code, unit_name_kh, unit_name_en,
 *             factor, qty, base_qty, unit_cost, base_unit_cost, line_total, batch_no, expiry_date, mfg_date, batch_id, note }
 */
async function normalizeItems(input, { cost = "none", batch = "none", signed = false } = {}) {
  if (!Array.isArray(input) || !input.length) return { error: "សូមបញ្ចូលទំនិញយ៉ាងហោចណាស់ ១ ជួរ!" };
  if (input.length > 500) return { error: "ទំនិញបានច្រើនបំផុត 500 ជួរ" };
  const vCache = new Map();
  const pCache = new Map();
  const units = await UnitModel.find({ deleted: false }).lean();
  const unitById = new Map(units.map((u) => [String(u._id), u]));
  const unitByCode = new Map(units.map((u) => [u.code, u]));
  const items = [];

  for (const [i, it] of input.entries()) {
    const n = `ជួរទី ${i + 1}`;
    // variant by id or SKU / barcode (Excel import)
    let variant;
    const vKey = isId(it?.variant_id) ? `id:${it.variant_id}` : `sku:${str(it?.sku).toUpperCase()}`;
    if (vCache.has(vKey)) variant = vCache.get(vKey);
    else {
      if (isId(it?.variant_id)) variant = await VariantModel.findOne({ _id: it.variant_id, deleted: false }).lean();
      else if (str(it?.sku)) {
        const s = str(it.sku);
        variant = await VariantModel.findOne({ deleted: false, $or: [{ code: s.toUpperCase() }, { barcode: s }] }).lean();
      }
      vCache.set(vKey, variant);
    }
    if (!variant) return { error: `${n}: រកមិនឃើញទំនិញ (SKU ${str(it?.sku) || it?.variant_id || "-"})` };
    if (!pCache.has(String(variant.product_id))) pCache.set(String(variant.product_id), await ProductModel.findOne({ _id: variant.product_id, deleted: false }).lean());
    const product = pCache.get(String(variant.product_id));
    if (!product) return { error: `${n}: ទំនិញ ${variant.code} ត្រូវបានលុប` };
    if (product.track_stock === false) return { error: `${n}: ${variant.code} ជាសេវា មិនតាមដានស្តុកទេ` };

    // unit (default base)
    let unit;
    if (isId(it?.unit_id)) unit = unitById.get(String(it.unit_id));
    else if (str(it?.unit)) unit = unitByCode.get(str(it.unit).toLowerCase());
    else unit = unitById.get(String(product.base_unit_id));
    if (!unit) return { error: `${n}: ឯកតាមិនត្រឹមត្រូវ` };
    let factor = 1;
    if (String(unit._id) !== String(product.base_unit_id)) {
      const pu = product.units.find((u) => String(u.unit_id) === String(unit._id));
      if (!pu) return { error: `${n}: ${variant.code} មិនមានឯកតា ${unit.code}` };
      factor = pu.factor;
    }

    const qty = round(it?.qty, 4);
    if (!Number.isFinite(qty) || qty === 0 || (!signed && qty < 0)) return { error: `${n}: ចំនួនមិនត្រឹមត្រូវ (${variant.code})` };

    let unitCost = null;
    if (cost !== "none") {
      const raw = it?.unit_cost;
      if (raw === undefined || raw === null || raw === "") {
        if (cost === "required") return { error: `${n}: សូមបញ្ចូលថ្លៃដើម (${variant.code})` };
      } else {
        unitCost = Number(raw);
        if (!Number.isFinite(unitCost) || unitCost < 0) return { error: `${n}: ថ្លៃដើមមិនត្រឹមត្រូវ (${variant.code})` };
        unitCost = round(unitCost, 4);
      }
    }

    const row = {
      product_id: product._id,
      variant_id: variant._id,
      sku: variant.code,
      name_kh: variant.name_kh,
      name_en: variant.name_en,
      track_batch: !!product.track_batch,
      unit_id: unit._id,
      unit_code: unit.code,
      unit_name_kh: unit.name_kh,
      unit_name_en: unit.name_en,
      factor,
      qty,
      base_qty: round(qty * factor, 4),
      unit_cost: unitCost,
      base_unit_cost: unitCost === null ? null : round(unitCost / factor, 6),
      line_total: unitCost === null ? null : round(Math.abs(qty) * unitCost, 4),
      batch_no: null,
      expiry_date: null,
      mfg_date: null,
      batch_id: null,
      note: str(it?.note),
    };

    // batches
    const goesIn = batch === "in" && (!signed || qty > 0);
    const goesOut = batch === "out" || (batch === "in" && signed && qty < 0);
    if (product.track_batch && goesIn) {
      row.batch_no = str(it?.batch_no).toUpperCase();
      row.expiry_date = toDate(it?.expiry_date);
      row.mfg_date = toDate(it?.mfg_date);
      if (!row.batch_no && isId(it?.batch_id)) {
        const b = await BatchModel.findOne({ _id: it.batch_id, variant_id: variant._id }).lean();
        if (b) Object.assign(row, { batch_no: b.batch_no, expiry_date: b.expiry_date, batch_id: b._id });
      }
      if (!row.batch_no) return { error: `${n}: ${variant.code} ត្រូវការលេខ Batch` };
      if (!row.expiry_date) return { error: `${n}: ${variant.code} ត្រូវការថ្ងៃផុតកំណត់ (Batch ${row.batch_no})` };
      if (row.expiry_date === undefined || row.mfg_date === undefined) return { error: `${n}: កាលបរិច្ឆេទមិនត្រឹមត្រូវ` };
    } else if (product.track_batch && goesOut && it?.batch_id) {
      if (!isId(it.batch_id)) return { error: `${n}: Batch មិនត្រឹមត្រូវ` };
      const b = await BatchModel.findOne({ _id: it.batch_id, variant_id: variant._id }).lean();
      if (!b) return { error: `${n}: Batch មិនមែនរបស់ ${variant.code}` };
      Object.assign(row, { batch_id: b._id, batch_no: b.batch_no, expiry_date: b.expiry_date });
    }
    items.push(row);
  }
  return { items };
}

module.exports = { normalizeItems, isId, str, toDate };
