const crypto = require("crypto");
const mongoose = require("mongoose");
const CatalogLinkModel = require("./catalog.model");
const WarehouseModel = require("../setup/warehouse/warehouse.model");
const SettingModel = require("../setup/setting/setting.model");
const CategoryModel = require("../product/category/category.model");
const ProductModel = require("../product/item/product.model");
const VariantModel = require("../product/item/variant.model");
const { StockBalanceModel } = require("../stock/balance.model");
const { priceGrid } = require("../product/price/price.service");
const { categoryWithChildren } = require("../product/item/product.service");
const getFilteredMongoDB = require("../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../util/log");
const { escapeRegex } = require("../../../util/helper");
const { serverError, noIDFound } = require("../../../util/master_crud");
const { can_manage_product } = require("../../../util/permission");

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const newToken = () => crypto.randomBytes(9).toString("base64url"); // 12 url-safe characters
const ok = (res, data, message, status = 200) => res.status(status).json({ success: true, data, message });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const POPULATE = [
  { path: "warehouse_id", select: "code name_kh name_en type" },
  { path: "category_id", select: "code name_kh name_en" },
  { path: "created_by", select: "firstname lastname email" },
];
const NOT_FOUND = "តំណនេះមិនមាន ឬត្រូវបានបិទ / This link does not exist or was turned off";

// ---------------------------------------------------------------------------------------------
// Public catalog data. The heavy part (every product of the link + stock status) is kept 60 s per
// link in this server's memory; search / category / page are done on that copy.
// ---------------------------------------------------------------------------------------------
const CACHE_MS = 60 * 1000;
const cache = new Map(); // token → { at, data }
const clearCatalogCache = (token) => (token ? cache.delete(token) : cache.clear());

function stockStatus(qty, min, tracked) {
  if (!tracked) return "in";
  if (qty <= 0) return "out";
  if (min > 0 && qty <= min) return "low";
  return "in";
}
const pick = (o, keys) => (o ? Object.fromEntries(keys.map((k) => [k, o[k] ?? null])) : null);

async function loadCatalog(link) {
  const hit = cache.get(link.token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const wh = link.warehouse_id;
  const allCats = await CategoryModel.find({ deleted: false }).select("name_kh name_en parent_id sort_order image").lean();
  const catById = new Map(allCats.map((c) => [String(c._id), c]));
  const scopeRoot = link.category_id ? String(link.category_id._id || link.category_id) : null;
  const scopeIds = scopeRoot ? new Set(await categoryWithChildren(scopeRoot)) : null;

  // group = the top category under the link's scope (sub-categories roll up into it)
  const groupOf = (catId) => {
    let c = catById.get(String(catId));
    let guard = 0;
    while (c && guard++ < 20) {
      const parent = c.parent_id ? String(c.parent_id) : null;
      if (scopeRoot ? parent === scopeRoot || String(c._id) === scopeRoot : !parent) return String(c._id);
      c = catById.get(parent);
    }
    return String(catId);
  };

  const pFilter = { deleted: false, status: true };
  if (scopeIds) pFilter.category_id = { $in: [...scopeIds].map((id) => new mongoose.Types.ObjectId(id)) };
  const products = await ProductModel.find(pFilter)
    .select("code name_kh name_en description image category_id brand_id base_unit_id track_stock min_stock sort_order")
    .populate([{ path: "brand_id", select: "name_kh name_en" }, { path: "base_unit_id", select: "code name_kh name_en" }])
    .sort({ sort_order: 1, code: 1 })
    .lean();
  const variants = await VariantModel.find({ deleted: false, status: true, product_id: { $in: products.map((p) => p._id) } })
    .select("product_id code name_kh name_en options image min_stock is_default sort_order")
    .sort({ sort_order: 1 })
    .lean();
  const balances = await StockBalanceModel.find({ warehouse_id: wh._id, variant_id: { $in: variants.map((v) => v._id) } }).select("variant_id qty").lean();
  const qtyOf = new Map(balances.map((b) => [String(b.variant_id), b.qty]));

  const byProduct = new Map();
  variants.forEach((v) => {
    const k = String(v.product_id);
    if (!byProduct.has(k)) byProduct.set(k, []);
    byProduct.get(k).push(v);
  });
  const rank = { in: 0, low: 1, out: 2 };
  const items = [];
  for (const p of products) {
    const vs = byProduct.get(String(p._id)) || [];
    if (!vs.length) continue;
    const tracked = p.track_stock !== false;
    const vrows = vs.map((v) => ({
      _id: v._id,
      code: v.code,
      options: (v.options || []).map((o) => pick(o, ["attribute_code", "value_code", "name_kh", "name_en", "color_hex"])),
      image: v.image?.url || null,
      status: stockStatus(qtyOf.get(String(v._id)) || 0, v.min_stock ?? p.min_stock ?? 0, tracked),
    }));
    const best = Math.min(...vrows.map((v) => rank[v.status]));
    const cat = catById.get(String(p.category_id));
    items.push({
      _id: p._id,
      code: p.code,
      name_kh: p.name_kh,
      name_en: p.name_en || p.name_kh,
      description: p.description || "",
      image: p.image?.url || vrows.find((v) => v.image)?.image || null,
      brand: pick(p.brand_id, ["name_kh", "name_en"]),
      category: cat ? { _id: cat._id, name_kh: cat.name_kh, name_en: cat.name_en || cat.name_kh } : null,
      unit: pick(p.base_unit_id, ["code", "name_kh", "name_en"]),
      group: groupOf(p.category_id),
      status: Object.keys(rank).find((k) => rank[k] === best),
      simple: vs.length === 1 && !!vs[0].is_default,
      variants: vrows,
      search: [p.code, p.name_kh, p.name_en, p.brand_id?.name_kh, p.brand_id?.name_en, cat?.name_kh, cat?.name_en, ...vs.map((v) => `${v.code} ${v.name_kh} ${v.name_en || ""}`)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    });
  }
  // in stock first, out of stock last (shop order kept inside each)
  items.sort((a, b) => (a.status === "out") - (b.status === "out"));

  const counts = new Map();
  items.forEach((i) => counts.set(i.group, (counts.get(i.group) || 0) + 1));
  const categories = [...counts.entries()]
    .map(([id, count]) => {
      const c = catById.get(id);
      return c ? { _id: c._id, name_kh: c.name_kh, name_en: c.name_en || c.name_kh, image: c.image?.url || null, count, sort_order: c.sort_order || 0 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order || a.name_en.localeCompare(b.name_en));

  const setting = await SettingModel.getMain();
  const data = {
    company: {
      name_kh: setting?.company_name_kh || "",
      name_en: setting?.company_name_en || setting?.company_name_kh || "",
      logo: setting?.logo?.url || null,
      phone: setting?.phone || "",
      address: setting?.address || "",
    },
    store: { code: wh.code, name_kh: wh.name_kh, name_en: wh.name_en || wh.name_kh, type: wh.type, address: wh.address || "", phone: wh.phone || "" },
    link: { name: link.name, category: link.category_id ? pick(link.category_id, ["name_kh", "name_en"]) : null },
    categories,
    items,
    total: items.length,
    in_stock: items.filter((i) => i.status !== "out").length,
    updated_at: new Date(),
  };
  cache.set(link.token, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

// /api/admin/catalog — QR code / public catalog links (admin, central manager) + the public page data (no login)
const route = (prop) => {
  const base = `/${prop.main_route}/catalog`;
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_product];
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  };
  const log = (req, title) => logActivity({ title, description: `គណនី: ${req.user.email}`, categoryTitle: "setting", createdBy: req.session.user_id, req });
  const send = async (res, id, message, status = 200) => ok(res, await CatalogLinkModel.findById(id).populate(POPULATE), message, status);
  const checkBody = async (b, partial) => {
    const out = {};
    if (!partial || b.name !== undefined) {
      const name = String(b.name || "").trim();
      if (!name) return { error: "សូមបញ្ចូលឈ្មោះតំណ!" };
      out.name = name.slice(0, 120);
    }
    if (!partial || b.warehouse_id !== undefined) {
      const wid = b.warehouse_id?._id || b.warehouse_id;
      if (!isId(wid) || !(await WarehouseModel.exists({ _id: wid, deleted: false }))) return { error: "សូមជ្រើសរើសហាង / ឃ្លាំង!" };
      out.warehouse_id = wid;
    }
    if (b.category_id !== undefined) {
      const cid = b.category_id?._id || b.category_id || null;
      if (cid && (!isId(cid) || !(await CategoryModel.exists({ _id: cid, deleted: false })))) return { error: "ប្រភេទទំនិញមិនត្រឹមត្រូវ!" };
      out.category_id = cid;
    }
    if (b.status !== undefined) out.status = !!b.status;
    if (b.note !== undefined) out.note = String(b.note || "").slice(0, 300);
    return { data: out };
  };

  // ===================================== PUBLIC (no login): GET /catalog/public/:token ================================================
  //   ?q=&category_id=&page=1&limit=24 → { company, store, link, categories, items (page), total, pagination }
  //   Stock is a status only: in | low | out. Price = this shop's price (else the default), base unit.
  prop.app.get(`${base}/public/:token`, prop.api_auth, wrap(async (req, res) => {
    const token = String(req.params.token || "").slice(0, 40);
    const link = await CatalogLinkModel.findOne({ token, deleted: false, status: true }).populate([
      { path: "warehouse_id", select: "code name_kh name_en type address phone deleted status" },
      { path: "category_id", select: "name_kh name_en" },
    ]);
    if (!link || !link.warehouse_id || link.warehouse_id.deleted) return bad(res, NOT_FOUND, 404);

    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 60);
    const q = String(req.query.q || "").trim().toLowerCase().slice(0, 60);
    const cat = isId(req.query.category_id) ? String(req.query.category_id) : null;
    const only = req.query.only === "in_stock";
    if (page === 1 && !q && !cat) CatalogLinkModel.updateOne({ _id: link._id }, { $inc: { views: 1 }, $set: { last_viewed_at: new Date() } }).catch(() => {});

    const all = await loadCatalog(link);
    let rows = all.items;
    if (cat) rows = rows.filter((i) => i.group === cat);
    if (only) rows = rows.filter((i) => i.status !== "out");
    if (q) {
      const words = q.split(/\s+/).filter(Boolean);
      rows = rows.filter((i) => words.every((w) => i.search.includes(w)));
    }
    const total = rows.length;
    const pageRows = rows.slice((page - 1) * limit, page * limit);

    // prices only for this page (shop override first, then default · base unit)
    const grid = await priceGrid(
      pageRows.flatMap((i) => i.variants.map((v) => ({ _id: v._id, product_id: i._id }))),
      { warehouseId: link.warehouse_id._id },
    );
    const priceOf = new Map(grid.map((g) => [String(g.variant_id), g.units.find((u) => u.is_base)?.price ?? null]));
    const items = pageRows.map(({ search, group, ...i }) => {
      const variants = i.variants.map((v) => ({ ...v, price: priceOf.get(String(v._id)) ?? null }));
      const prices = variants.filter((v) => v.price !== null).map((v) => v.price);
      return { ...i, variants, price_min: prices.length ? Math.min(...prices) : null, price_max: prices.length ? Math.max(...prices) : null };
    });

    res.set("Cache-Control", "public, max-age=30");
    ok(res, {
      company: all.company,
      store: all.store,
      link: all.link,
      categories: all.categories,
      total_items: all.total,
      in_stock: all.in_stock,
      updated_at: all.updated_at,
      items,
      pagination: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) },
    });
  }));

  // ===================================== LINKS (admin, central manager) ================================================
  prop.app.get(base, ...guard, wrap(async (req, res) => {
    const { q, warehouse_id, ...rest } = req.query;
    const extra = [];
    if (isId(warehouse_id)) extra.push({ warehouse_id: new mongoose.Types.ObjectId(warehouse_id) });
    const text = typeof q === "string" ? q.trim() : "";
    if (text) extra.push({ name: { $regex: escapeRegex(text), $options: "i" } });
    if (!rest.sort) rest.sort = "created_date";
    const r = await getFilteredMongoDB(rest, CatalogLinkModel, POPULATE, extra);
    res.status(200).json({ success: true, data: r.data, pagination: r.pagination });
  }));

  prop.app.post(base, ...guard, wrap(async (req, res) => {
    const c = await checkBody(req.body || {}, false);
    if (c.error) return bad(res, c.error);
    const doc = await CatalogLinkModel.create({ ...c.data, token: newToken(), created_by: req.session.user_id, updated_by: req.session.user_id });
    await log(req, `តំណ QR "${doc.name}" ត្រូវបានបង្កើត`);
    send(res, doc._id, "បានបង្កើតតំណ QR", 201);
  }));

  prop.app.put(`${base}/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await CatalogLinkModel.findOne({ _id: req.params.id, deleted: false });
    if (!doc) return bad(res, "មិនមានតំណនេះ", 404);
    const c = await checkBody(req.body || {}, true);
    if (c.error) return bad(res, c.error);
    Object.assign(doc, c.data, { updated_by: req.session.user_id });
    await doc.save();
    clearCatalogCache(doc.token);
    await log(req, `តំណ QR "${doc.name}" ត្រូវបានកែប្រែ${c.data.status === false ? " (បិទ)" : ""}`);
    send(res, doc._id, "បានរក្សាទុក");
  }));

  // new token: the old URL / printed QR stops working at once
  prop.app.put(`${base}/new-token/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await CatalogLinkModel.findOne({ _id: req.params.id, deleted: false });
    if (!doc) return bad(res, "មិនមានតំណនេះ", 404);
    clearCatalogCache(doc.token);
    doc.token = newToken();
    doc.views = 0;
    doc.last_viewed_at = null;
    doc.updated_by = req.session.user_id;
    await doc.save();
    await log(req, `តំណ QR "${doc.name}" បានប្តូរលេខកូដថ្មី (តំណចាស់លែងប្រើបាន)`);
    send(res, doc._id, "បានបង្កើតតំណថ្មី — QR ចាស់លែងប្រើបានទៀតហើយ");
  }));

  prop.app.delete(`${base}/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await CatalogLinkModel.findOne({ _id: req.params.id, deleted: false });
    if (!doc) return bad(res, "មិនមានតំណនេះ", 404);
    doc.deleted = true;
    doc.status = false;
    doc.updated_by = req.session.user_id;
    await doc.save();
    clearCatalogCache(doc.token);
    await log(req, `តំណ QR "${doc.name}" ត្រូវបានលុប`);
    ok(res, { _id: doc._id }, "បានលុប");
  }));
};

module.exports = route;
module.exports.clearCatalogCache = clearCatalogCache;
