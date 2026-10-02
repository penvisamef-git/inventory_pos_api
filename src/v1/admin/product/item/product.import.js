// Product import / export with Excel (one row per SKU). Used by product.route.js:
//   POST /product/import { rows, apply }  → preview (apply = false) or save (apply = true)
//   GET  /product/import/export            → every product in the same row format (edit in Excel, import again)
//
// Row (keys = template headers):
//   product_code*, name_kh*, name_en, category* (code), brand (code), base_unit* (code), track_batch (yes/no), min_stock,
//   option_1..option_3 ("size=0_3m"), sku, barcode, unit_2 (code), unit_2_factor, unit_2_barcode, price, unit_2_price
// Rows with the same product_code = one product (its variants). Product fields come from the first row that has them.
// Existing product (same code) → updated; its SKUs that are not in the file are kept (import never deletes).
// Prices: a new default price row only when the price differs from today's price (price history stays correct).
const mongoose = require("mongoose");
const ProductModel = require("./product.model");
const VariantModel = require("./variant.model");
const CategoryModel = require("../category/category.model");
const BrandModel = require("../brand/brand.model");
const UnitModel = require("../unit/unit.model");
const AttributeModel = require("../attribute/attribute.model");
const PriceModel = require("../price/price.model");
const { buildProduct } = require("./product.service");
const { checkItem, insertPrices, activeAt } = require("../price/price.service");

const COLUMNS = [
  "product_code", "name_kh", "name_en", "category", "brand", "base_unit", "track_batch", "min_stock",
  "option_1", "option_2", "option_3", "sku", "barcode", "unit_2", "unit_2_factor", "unit_2_barcode", "price", "unit_2_price",
];
const MAX_ROWS = 2000;
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const yes = (v) => /^(1|y|yes|true|ចាស|បាទ)$/i.test(str(v));
const num = (v) => (str(v) === "" ? null : Number(str(v).replace(/[$,\s]/g, "")));

async function lookups() {
  const [cats, brands, units, attrs] = await Promise.all([
    CategoryModel.find({ deleted: false }).select("code").lean(),
    BrandModel.find({ deleted: false }).select("code").lean(),
    UnitModel.find({ deleted: false }).select("code").lean(),
    AttributeModel.find({ deleted: false }).lean(),
  ]);
  const by = (list) => new Map(list.map((x) => [x.code, x]));
  return { cat: by(cats), brand: by(brands), unit: by(units), attr: by(attrs), unitById: new Map(units.map((u) => [String(u._id), u])) };
}

// "size=0_3m" → { attribute, value } | { error }
function parseOption(text, L) {
  const [a, v] = str(text).split("=").map((x) => str(x).toLowerCase());
  if (!a || !v) return { error: `"${text}" ត្រូវសរសេរ លក្ខណៈ=តម្លៃ ឧ. size=0_3m` };
  const attribute = L.attr.get(a);
  if (!attribute) return { error: `លក្ខណៈ "${a}" មិនមានក្នុងប្រព័ន្ធ (បង្កើតនៅ ទំនិញ → លក្ខណៈ)` };
  const value = attribute.values.find((x) => x.code === v);
  if (!value) return { error: `តម្លៃ "${v}" មិនមានក្នុងលក្ខណៈ ${a}` };
  return { attribute, value };
}

/**
 * rows: [{ ...columns, _row (Excel row number) }]
 * ctx: { apply, userId, saveAll, stockLock }
 * → { summary: { products, create, update, error, variants, prices }, results: [{ product_code, rows, action, message, variants, prices }] }
 */
async function importRows(rows, { apply, userId, saveAll, stockLock }) {
  if (!Array.isArray(rows) || !rows.length) return { error: "មិនមានជួរក្នុងឯកសារ!" };
  if (rows.length > MAX_ROWS) return { error: `ជួរបានច្រើនបំផុត ${MAX_ROWS} ក្នុងមួយដង` };
  const L = await lookups();

  // group by product code (keep the file order)
  const groups = new Map();
  rows.forEach((r, i) => {
    const code = str(r.product_code).toUpperCase();
    const row = { ...r, _row: r._row || i + 2 };
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(row);
  });

  // the same SKU / barcode twice in the file (across products)
  const seenSku = new Map();
  const seenBc = new Map();
  for (const [code, list] of groups)
    for (const r of list) {
      const sku = str(r.sku).toUpperCase();
      if (sku) seenSku.set(sku, [...(seenSku.get(sku) || []), code]);
      [str(r.barcode), str(r.unit_2_barcode)].filter(Boolean).forEach((b) => seenBc.set(b, [...(seenBc.get(b) || []), code]));
    }
  const fileDup = (code, list) => {
    for (const r of list) {
      const sku = str(r.sku).toUpperCase();
      if (sku && new Set(seenSku.get(sku)).size > 1) return `SKU ${sku} មានក្នុងទំនិញផ្សេងទៀតក្នុងឯកសារ`;
      for (const b of [str(r.barcode), str(r.unit_2_barcode)].filter(Boolean)) if (new Set(seenBc.get(b)).size > 1) return `បាកូដ ${b} ស្ទួនក្នុងឯកសារ`;
    }
    return null;
  };

  const results = [];
  for (const [code, list] of groups) {
    const res = { product_code: code || "-", rows: list.map((r) => r._row), action: "error", message: "", variants: 0, prices: 0 };
    results.push(res);
    try {
      const fail = (m) => {
        res.message = m;
        return null;
      };
      if (!code) {
        fail("គ្មាន product_code");
        continue;
      }
      const dup = fileDup(code, list);
      if (dup) {
        fail(dup);
        continue;
      }
      const first = (k) => str(list.find((r) => str(r[k]) !== "")?.[k]);

      const current = await ProductModel.findOne({ code, deleted: false });
      const currentVariants = current ? await VariantModel.find({ product_id: current._id, deleted: false }).sort({ sort_order: 1 }) : [];

      // product fields (blank in the file = keep the current value)
      const catCode = first("category").toLowerCase();
      const brandCode = first("brand").toLowerCase();
      const unitCode = first("base_unit").toLowerCase();
      const category = catCode ? L.cat.get(catCode) : null;
      if (catCode && !category) {
        fail(`ប្រភេទ "${catCode}" មិនមាន`);
        continue;
      }
      const brand = brandCode && brandCode !== "-" ? L.brand.get(brandCode) : null;
      if (brandCode && brandCode !== "-" && !brand) {
        fail(`ម៉ាក "${brandCode}" មិនមាន`);
        continue;
      }
      const baseUnit = unitCode ? L.unit.get(unitCode) : null;
      if (unitCode && !baseUnit) {
        fail(`ឯកតា "${unitCode}" មិនមាន`);
        continue;
      }
      if (!current && (!first("name_kh") || !category || !baseUnit)) {
        fail("ទំនិញថ្មីត្រូវមាន name_kh, category និង base_unit");
        continue;
      }

      // second unit (box / pack)
      const u2Code = first("unit_2").toLowerCase();
      const u2 = u2Code ? L.unit.get(u2Code) : null;
      if (u2Code && !u2) {
        fail(`ឯកតា "${u2Code}" មិនមាន`);
        continue;
      }
      const u2Factor = num(first("unit_2_factor"));
      if (u2 && !(u2Factor > 0)) {
        fail("unit_2_factor ត្រូវធំជាង 0");
        continue;
      }
      let units = current ? current.units.map((u) => ({ unit_id: u.unit_id, factor: u.factor, is_sale_unit: u.is_sale_unit, is_purchase_unit: u.is_purchase_unit })) : [];
      if (u2) {
        const at = units.findIndex((u) => String(u.unit_id) === String(u2._id));
        if (at >= 0) units[at] = { ...units[at], factor: u2Factor };
        else units.push({ unit_id: u2._id, factor: u2Factor, is_sale_unit: true, is_purchase_unit: true });
      }

      // options of each row → attributes (same set on every row)
      let attrIds = null;
      let optError = null;
      const parsed = list.map((r) => {
        const opts = ["option_1", "option_2", "option_3"].map((k) => str(r[k])).filter(Boolean).map((t) => parseOption(t, L));
        const bad = opts.find((o) => o.error);
        if (bad) optError = optError || `ជួរ ${r._row}: ${bad.error}`;
        const ids = opts.filter((o) => !o.error).map((o) => String(o.attribute._id));
        if (attrIds === null) attrIds = ids;
        else if (ids.join() !== attrIds.join()) optError = optError || `ជួរ ${r._row}: លក្ខណៈត្រូវដូចគ្នាគ្រប់ជួររបស់ ${code}`;
        return { r, opts: opts.filter((o) => !o.error) };
      });
      if (optError) {
        fail(optError);
        continue;
      }
      if (current && current.attribute_ids.map(String).join() !== attrIds.join() && !(attrIds.length === 0 && list.length === 1 && current.attribute_ids.length === 0)) {
        fail("មិនអាចប្តូរលក្ខណៈ (ទំហំ / ពណ៌) តាម Excel បានទេ — កែនៅក្នុងកម្មវិធី");
        continue;
      }
      if (!attrIds.length && list.length > 1) {
        fail("ទំនិញគ្មានលក្ខណៈ មានបានតែ ១ ជួរ (បន្ថែម option_1 ដើម្បីបង្កើតប្រភេទរង)");
        continue;
      }

      // variants: existing ones first (kept), then rows update / add
      const variants = currentVariants.map((v) => ({
        _id: v._id,
        options: v.options.map((o) => ({ attribute_id: o.attribute_id, value_id: o.value_id })),
        code: v.code,
        barcode: v.barcode,
        unit_barcodes: v.unit_barcodes.map((b) => ({ unit_id: b.unit_id, barcode: b.barcode })),
        min_stock: v.min_stock,
        image: v.image,
        status: v.status,
        note: v.note,
      }));
      const keyOf = (opts) => opts.map((o) => String(o.value_id || o.value._id)).join("|");
      const rowVariant = new Map(); // row → variant object (to find its id / code after saving)
      for (const { r, opts } of parsed) {
        const k = keyOf(opts);
        const sku = str(r.sku).toUpperCase();
        let v = attrIds.length ? variants.find((x) => keyOf(x.options) === k) : variants[0];
        if (!v && sku) v = variants.find((x) => x.code === sku);
        if (!v) {
          v = { options: opts.map((o) => ({ attribute_id: o.attribute._id, value_id: o.value._id })), unit_barcodes: [] };
          variants.push(v);
        }
        if (sku) v.code = sku;
        if (str(r.barcode)) v.barcode = str(r.barcode);
        if (str(r.unit_2_barcode)) {
          if (!u2) {
            fail(`ជួរ ${r._row}: មាន unit_2_barcode ប៉ុន្តែគ្មាន unit_2`);
            break;
          }
          v.unit_barcodes = [...(v.unit_barcodes || []).filter((b) => String(b.unit_id) !== String(u2._id)), { unit_id: u2._id, barcode: str(r.unit_2_barcode) }];
        }
        if (str(r.min_stock) !== "" && attrIds.length) v.min_stock = num(r.min_stock);
        rowVariant.set(r, v);
      }
      if (res.message) continue;

      const body = {
        code,
        name_kh: first("name_kh") || current?.name_kh,
        name_en: first("name_en") || current?.name_en || "",
        category_id: category?._id || current?.category_id,
        brand_id: brandCode === "-" ? null : brand?._id || current?.brand_id || null,
        base_unit_id: baseUnit?._id || current?.base_unit_id,
        units,
        attribute_ids: attrIds,
        track_batch: first("track_batch") ? yes(first("track_batch")) : current ? current.track_batch : false,
        min_stock: !attrIds.length && first("min_stock") !== "" ? num(first("min_stock")) : current?.min_stock || 0,
        variants,
      };
      const built = await buildProduct(body, current, currentVariants);
      if (built.error) {
        fail(built.error);
        continue;
      }
      if (current) {
        const locked = await stockLock(current, built);
        if (locked) {
          fail(locked);
          continue;
        }
      }
      res.variants = built.variants.length;

      // prices that change (base unit + unit_2)
      const priceRows = [];
      for (const { r } of parsed) {
        const v = rowVariant.get(r);
        const idx = variants.indexOf(v);
        const bv = built.variants[idx]; // same order as the input
        if (num(r.price) !== null) priceRows.push({ variant: bv, unit_id: built.product.base_unit_id, price: num(r.price), row: r._row });
        if (num(r.unit_2_price) !== null) {
          if (!u2) {
            fail(`ជួរ ${r._row}: មាន unit_2_price ប៉ុន្តែគ្មាន unit_2`);
            break;
          }
          priceRows.push({ variant: bv, unit_id: u2._id, price: num(r.unit_2_price), row: r._row });
        }
      }
      if (res.message) continue;
      const badPrice = priceRows.find((p) => !Number.isFinite(p.price) || p.price < 0);
      if (badPrice) {
        fail(`ជួរ ${badPrice.row}: តម្លៃមិនត្រឹមត្រូវ`);
        continue;
      }
      const changed = [];
      for (const p of priceRows) {
        if (!p.variant.isNew) {
          const now = await PriceModel.findOne({ variant_id: p.variant._id, unit_id: p.unit_id, warehouse_id: null, deleted: false, ...activeAt(new Date()) }).lean();
          if (now && Math.abs(now.price - p.price) < 0.00005) continue;
        }
        changed.push(p);
      }
      res.prices = changed.length;
      res.action = current ? "update" : "create";

      if (apply) {
        const saved = await saveAll({ productId: current?._id || null, ...built, userId });
        if (changed.length) {
          const items = [];
          const cache = new Map();
          for (const p of changed) {
            const c = await checkItem({ variant_id: p.variant._id, unit_id: p.unit_id, price: p.price }, cache);
            if (c.error) throw new Error(c.error);
            items.push({ ...c.row, effective_from: new Date() });
          }
          const r = await insertPrices(items, userId);
          if (r.error) throw new Error(r.error);
        }
        res.product_id = saved._id;
      }
    } catch (err) {
      res.action = "error";
      res.message = err.message;
    }
  }

  const count = (a) => results.filter((r) => r.action === a).length;
  return {
    summary: {
      products: results.length,
      create: count("create"),
      update: count("update"),
      error: count("error"),
      variants: results.reduce((t, r) => t + (r.action !== "error" ? r.variants : 0), 0),
      prices: results.reduce((t, r) => t + (r.action !== "error" ? r.prices : 0), 0),
    },
    results,
  };
}

// every product in the import format (today's default prices)
async function exportRows() {
  const L = await lookups();
  const catById = new Map([...L.cat.values()].map((c) => [String(c._id), c.code]));
  const brandById = new Map([...L.brand.values()].map((b) => [String(b._id), b.code]));
  const products = await ProductModel.find({ deleted: false }).sort({ sort_order: 1, code: 1 }).lean();
  const variants = await VariantModel.find({ deleted: false, product_id: { $in: products.map((p) => p._id) } }).sort({ sort_order: 1 }).lean();
  const prices = await PriceModel.find({ warehouse_id: null, deleted: false, ...activeAt(new Date()) }).lean();
  const priceOf = new Map(prices.map((p) => [`${p.variant_id}|${p.unit_id}`, p.price]));
  const byProduct = new Map();
  variants.forEach((v) => byProduct.set(String(v.product_id), [...(byProduct.get(String(v.product_id)) || []), v]));
  const rows = [];
  for (const p of products) {
    const u2 = p.units[0] || null;
    for (const [i, v] of (byProduct.get(String(p._id)) || []).entries()) {
      const opts = v.options.map((o) => `${o.attribute_code}=${o.value_code}`);
      rows.push({
        product_code: p.code,
        name_kh: i === 0 ? p.name_kh : "",
        name_en: i === 0 ? p.name_en || "" : "",
        category: i === 0 ? catById.get(String(p.category_id)) || "" : "",
        brand: i === 0 ? brandById.get(String(p.brand_id)) || "" : "",
        base_unit: i === 0 ? L.unitById.get(String(p.base_unit_id))?.code || "" : "",
        track_batch: i === 0 ? (p.track_batch ? "yes" : "no") : "",
        min_stock: opts.length ? (v.min_stock ?? "") : p.min_stock || 0,
        option_1: opts[0] || "",
        option_2: opts[1] || "",
        option_3: opts[2] || "",
        sku: v.code,
        barcode: v.barcode || "",
        unit_2: u2 && i === 0 ? L.unitById.get(String(u2.unit_id))?.code || "" : u2 ? L.unitById.get(String(u2.unit_id))?.code || "" : "",
        unit_2_factor: u2 ? u2.factor : "",
        unit_2_barcode: u2 ? v.unit_barcodes.find((b) => String(b.unit_id) === String(u2.unit_id))?.barcode || "" : "",
        price: priceOf.get(`${v._id}|${p.base_unit_id}`) ?? "",
        unit_2_price: u2 ? (priceOf.get(`${v._id}|${u2.unit_id}`) ?? "") : "",
      });
    }
  }
  return rows;
}

// code lists for the template's second sheet
async function codeLists() {
  const [cats, brands, units, attrs] = await Promise.all([
    CategoryModel.find({ deleted: false }).select("code name_kh name_en").sort({ sort_order: 1 }).lean(),
    BrandModel.find({ deleted: false }).select("code name_kh name_en").sort({ sort_order: 1 }).lean(),
    UnitModel.find({ deleted: false }).select("code name_kh name_en").sort({ sort_order: 1 }).lean(),
    AttributeModel.find({ deleted: false }).select("code name_kh name_en values").sort({ sort_order: 1 }).lean(),
  ]);
  return {
    categories: cats.map(({ code, name_kh, name_en }) => ({ code, name_kh, name_en })),
    brands: brands.map(({ code, name_kh, name_en }) => ({ code, name_kh, name_en })),
    units: units.map(({ code, name_kh, name_en }) => ({ code, name_kh, name_en })),
    options: attrs.flatMap((a) => a.values.map((v) => ({ code: `${a.code}=${v.code}`, name_kh: `${a.name_kh}: ${v.name_kh}`, name_en: `${a.name_en || a.name_kh}: ${v.name_en || v.name_kh}` }))),
  };
}

module.exports = { importRows, exportRows, codeLists, COLUMNS, isValidObjectId: mongoose.isValidObjectId };
