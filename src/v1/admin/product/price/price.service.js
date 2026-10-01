const mongoose = require("mongoose");
const PriceModel = require("./price.model");
const ProductModel = require("../item/product.model");
const VariantModel = require("../item/variant.model");
const WarehouseModel = require("../../setup/warehouse/warehouse.model");
const { round } = require("../../../../util/helper");

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const chainKey = (r) => `${r.variant_id}|${r.unit_id}|${r.warehouse_id || "default"}`;

// row is active at time t
const activeAt = (t) => ({ effective_from: { $lte: t }, $or: [{ effective_to: null }, { effective_to: { $gt: t } }] });
const stateOf = (row, now = new Date()) =>
  row.effective_from > now ? "upcoming" : row.effective_to && row.effective_to <= now ? "past" : "current";

/**
 * Validate one price item → { error } | { row } (row ready to insert, without chain dates)
 * item: { variant_id, unit_id, warehouse_id, price }
 * cache: Map shared by bulk calls (variants / products / shops)
 */
async function checkItem(item, cache = new Map()) {
  const get = async (key, load) => {
    if (!cache.has(key)) cache.set(key, await load());
    return cache.get(key);
  };
  if (!isId(item.variant_id)) return { error: "សូមជ្រើសរើសប្រភេទរងទំនិញ (variant)!" };
  const variant = await get(`v${item.variant_id}`, () => VariantModel.findOne({ _id: item.variant_id, deleted: false }).lean());
  if (!variant) return { error: "ប្រភេទរងទំនិញមិនមាននៅក្នុងប្រព័ន្ធ!" };
  const product = await get(`p${variant.product_id}`, () => ProductModel.findOne({ _id: variant.product_id, deleted: false }).lean());
  if (!product) return { error: "ទំនិញមិនមាននៅក្នុងប្រព័ន្ធ!" };

  // unit = base unit or a sale unit of the product (default: base unit)
  const unitId = item.unit_id ? String(item.unit_id) : String(product.base_unit_id);
  const isBase = unitId === String(product.base_unit_id);
  const pu = product.units.find((u) => String(u.unit_id) === unitId);
  if (!isBase && !pu) return { error: `ឯកតានេះមិនមែនជាឯកតារបស់ ${variant.code} ទេ!` };
  if (!isBase && !pu.is_sale_unit) return { error: `ឯកតានេះមិនមែនជាឯកតាលក់របស់ ${variant.code} ទេ!` };

  let warehouseId = null;
  if (item.warehouse_id) {
    if (!isId(item.warehouse_id)) return { error: "ហាងមិនត្រឹមត្រូវ!" };
    const wh = await get(`w${item.warehouse_id}`, () => WarehouseModel.findOne({ _id: item.warehouse_id, deleted: false }).lean());
    if (!wh || wh.type !== "shop") return { error: "តម្លៃពិសេសកំណត់បានតែសម្រាប់ហាង (មិនមែនឃ្លាំងកណ្តាល)!" };
    warehouseId = wh._id;
  }

  let price = item.price;
  if (price === null || price === "" || price === undefined) {
    if (!warehouseId) return { error: `សូមបញ្ចូលតម្លៃលក់សម្រាប់ ${variant.code}` };
    price = null; // shop goes back to the default price
  } else {
    price = Number(price);
    if (!Number.isFinite(price) || price < 0) return { error: `តម្លៃរបស់ ${variant.code} មិនត្រឹមត្រូវ!` };
    price = round(price, 4);
  }
  return {
    row: { product_id: product._id, variant_id: variant._id, unit_id: oid(unitId), warehouse_id: warehouseId, price },
    variant,
  };
}

// effective_from: missing or in the past → now (old invoices already used the old price)
function startDate(value) {
  const now = new Date();
  if (value === undefined || value === null || value === "") return { date: now };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: "កាលបរិច្ឆេទចាប់ផ្តើមមិនត្រឹមត្រូវ!" };
  return { date: d < now ? now : d };
}

/**
 * Insert rows into their chains (one transaction). Each row: { ...checkItem row, effective_from }
 *   previous row (latest start before) → effective_to = new start
 *   new row → effective_to = start of the next row (or null)
 * → { error } | { saved: [docs] }
 */
async function insertPrices(rows, userId) {
  const seen = new Set();
  for (const r of rows) {
    const k = chainKey(r);
    if (seen.has(k)) return { error: "តម្លៃស្ទួនគ្នា (ទំនិញ + ឯកតា + ហាង ដូចគ្នា)!", status: 400 };
    seen.add(k);
  }
  const session = await mongoose.startSession();
  const saved = [];
  try {
    await session.withTransaction(async () => {
      saved.length = 0;
      for (const r of rows) {
        const chain = { variant_id: r.variant_id, unit_id: r.unit_id, warehouse_id: r.warehouse_id, deleted: false };
        if (await PriceModel.exists({ ...chain, effective_from: r.effective_from }).session(session)) {
          throw new Error("conflict");
        }
        const next = await PriceModel.findOne({ ...chain, effective_from: { $gt: r.effective_from } }).sort({ effective_from: 1 }).session(session);
        await PriceModel.updateOne(
          { ...chain, effective_from: { $lt: r.effective_from }, $or: [{ effective_to: null }, { effective_to: { $gt: r.effective_from } }] },
          { effective_to: r.effective_from, updated_by: userId },
          { session },
        );
        const [doc] = await PriceModel.create(
          [{ ...r, effective_to: next ? next.effective_from : null, deleted: false, created_by: userId, updated_by: userId }],
          { session },
        );
        saved.push(doc);
      }
    });
    return { saved };
  } catch (err) {
    if (err.message === "conflict") return { error: "មានតម្លៃចាប់ផ្តើមនៅពេលនេះរួចហើយ (សូមប្តូរម៉ោង)!", status: 409 };
    throw err;
  } finally {
    await session.endSession();
  }
}

// Remove an upcoming row and give its period back to the previous row
async function removeUpcoming(row, userId) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const chain = { variant_id: row.variant_id, unit_id: row.unit_id, warehouse_id: row.warehouse_id, deleted: false };
      await PriceModel.updateOne({ _id: row._id }, { deleted: true, updated_by: userId }, { session });
      await PriceModel.updateOne(
        { ...chain, _id: { $ne: row._id }, effective_to: row.effective_from },
        { effective_to: row.effective_to, updated_by: userId },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Price grid for variants: per variant → per sale unit →
 *   default { _id, price, effective_from } | null
 *   default_next (upcoming default) | null
 *   shops: [{ warehouse_id, _id, price, effective_from, next }]   (only shops in `shopIds`, null = all)
 *   price / source for `warehouseId` (shop override first, then default)
 */
async function priceGrid(variants, { warehouseId = null, shopIds = null, at = new Date() } = {}) {
  if (!variants.length) return [];
  const productIds = [...new Set(variants.map((v) => String(v.product_id?._id || v.product_id)))];
  const products = await ProductModel.find({ _id: { $in: productIds } })
    .populate([{ path: "base_unit_id", select: "code name_kh name_en" }, { path: "units.unit_id", select: "code name_kh name_en" }])
    .lean();
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const whFilter = shopIds ? { $in: [null, ...shopIds] } : undefined;
  const base = { variant_id: { $in: variants.map((v) => v._id) }, deleted: false, ...(whFilter ? { warehouse_id: whFilter } : {}) };
  const [current, upcoming] = await Promise.all([
    PriceModel.find({ ...base, ...activeAt(at) }).lean(),
    PriceModel.find({ ...base, effective_from: { $gt: at } }).sort({ effective_from: 1 }).lean(),
  ]);
  const key = (r) => `${r.variant_id}|${r.unit_id}`;
  const curMap = new Map();
  current.forEach((r) => {
    const k = key(r);
    if (!curMap.has(k)) curMap.set(k, []);
    curMap.get(k).push(r);
  });
  const nextMap = new Map();
  upcoming.forEach((r) => {
    const k = `${key(r)}|${r.warehouse_id || "default"}`;
    if (!nextMap.has(k)) nextMap.set(k, r); // first upcoming per chain
  });
  const brief = (r) => (r ? { _id: r._id, price: r.price, effective_from: r.effective_from } : null);

  return variants.map((v) => {
    const p = productById.get(String(v.product_id?._id || v.product_id));
    const units = [
      { unit: p.base_unit_id, factor: 1, is_base: true },
      ...p.units.filter((u) => u.is_sale_unit).map((u) => ({ unit: u.unit_id, factor: u.factor, is_base: false })),
    ];
    return {
      variant_id: v._id,
      code: v.code,
      name_kh: v.name_kh,
      name_en: v.name_en,
      options: v.options,
      status: v.status,
      product_id: p._id,
      units: units.map(({ unit, factor, is_base }) => {
        const k = `${v._id}|${unit._id}`;
        const rows = curMap.get(k) || [];
        const def = rows.find((r) => !r.warehouse_id) || null;
        const shopRows = rows.filter((r) => r.warehouse_id);
        const shopIdsHere = new Set([
          ...shopRows.map((r) => String(r.warehouse_id)),
          ...upcoming.filter((r) => r.warehouse_id && key(r) === k).map((r) => String(r.warehouse_id)),
        ]);
        const shops = [...shopIdsHere].map((wid) => {
          const cur = shopRows.find((r) => String(r.warehouse_id) === wid);
          return { warehouse_id: wid, ...(brief(cur) || { _id: null, price: null, effective_from: null }), next: brief(nextMap.get(`${k}|${wid}`)) };
        });
        const out = {
          unit_id: unit._id,
          unit_code: unit.code,
          unit_name_kh: unit.name_kh,
          unit_name_en: unit.name_en,
          factor,
          is_base,
          default: brief(def),
          default_next: brief(nextMap.get(`${k}|default`)),
          shops,
        };
        if (warehouseId) {
          const own = shopRows.find((r) => String(r.warehouse_id) === String(warehouseId));
          const usable = own && own.price !== null ? own : def;
          out.price = usable ? usable.price : null;
          out.source = usable ? (usable === def ? "default" : "shop") : null;
        }
        return out;
      }),
    };
  });
}

// { productId: { min, max } } of current default base-unit prices (product list)
async function priceRanges(productIds, at = new Date()) {
  if (!productIds.length) return {};
  const products = await ProductModel.find({ _id: { $in: productIds } }).select("base_unit_id").lean();
  const baseOf = new Map(products.map((p) => [String(p._id), String(p.base_unit_id)]));
  const rows = await PriceModel.find({ product_id: { $in: productIds }, warehouse_id: null, deleted: false, ...activeAt(at) })
    .select("product_id unit_id price")
    .lean();
  const out = {};
  rows.forEach((r) => {
    if (String(r.unit_id) !== baseOf.get(String(r.product_id))) return;
    const k = String(r.product_id);
    if (!out[k]) out[k] = { min: r.price, max: r.price, count: 0 };
    out[k].min = Math.min(out[k].min, r.price);
    out[k].max = Math.max(out[k].max, r.price);
    out[k].count += 1;
  });
  return out;
}

module.exports = { checkItem, startDate, insertPrices, removeUpcoming, priceGrid, priceRanges, activeAt, stateOf, isId };
