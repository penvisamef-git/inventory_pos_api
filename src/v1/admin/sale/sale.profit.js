const mongoose = require("mongoose");
const { SaleModel, RefundModel } = require("../pos/pos.model");
const GoodsReceiveModel = require("../stock/receive/receive.model");
const { StockBalanceModel } = require("../stock/balance.model");

// Profit by product / variant / brand / category / supplier + slow and dead stock.
// Profit = sales − cost (cost of goods when sold); refunds in the period take their money and cost back out.
// Cost is only for users who see every shop (same rule as the sales report).
const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const DAY = 86400000;
const GROUPS = ["product", "variant", "brand", "category", "supplier"];

// last supplier we bought each variant from (posted goods receives)
async function supplierOf(variantIds) {
  if (!variantIds.length) return new Map();
  const rows = await GoodsReceiveModel.aggregate([
    { $match: { state: "posted", "items.variant_id": { $in: variantIds } } },
    { $sort: { posted_at: -1 } },
    { $unwind: "$items" },
    { $match: { "items.variant_id": { $in: variantIds } } },
    { $group: { _id: "$items.variant_id", supplier_id: { $first: "$supplier_id" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.supplier_id]));
}

module.exports = (prop, { base, guard, wrap, saleFilter, seesCost, ok, bad }) => {
  // ?from&to&warehouse_id&group=product|variant|brand|category|supplier
  prop.app.get(`${base}/profit`, ...guard, wrap(async (req, res) => {
    if (!seesCost(req)) return bad(res, "មើលបានតែអ្នកមើលគ្រប់ហាង / Only users who see all shops can see cost", 403);
    const s = saleFilter(req);
    if (!s) return bad(res, "មិនមានសិទ្ធិលើឃ្លាំងនេះ", 403);
    const group = GROUPS.includes(req.query.group) ? req.query.group : "product";
    const rf = { refunded_at: s.filter.sold_at };
    ["warehouse_id", "device_id", "cashier_id"].forEach((k) => s.filter[k] && (rf[k] = s.filter[k]));
    const lineStage = (amountField) => [
      { $unwind: "$items" },
      { $group: { _id: "$items.variant_id", product_id: { $first: "$items.product_id" }, sku: { $first: "$items.sku" }, name_kh: { $first: "$items.name_kh" }, name_en: { $first: "$items.name_en" }, qty: { $sum: "$items.base_qty" }, amount: { $sum: `$items.${amountField}` }, cost: { $sum: { $ifNull: ["$items.cost_total", 0] } }, docs: { $addToSet: "$_id" } } },
    ];
    const [sold, back] = await Promise.all([
      SaleModel.aggregate([{ $match: s.filter }, ...lineStage("line_total")]),
      RefundModel.aggregate([{ $match: rf }, ...lineStage("amount")]),
    ]);
    // per variant: sold − returned
    const byVariant = new Map();
    const add = (x, sign) => {
      const k = String(x._id);
      const v = byVariant.get(k) || { variant_id: x._id, product_id: x.product_id, sku: x.sku, name_kh: x.name_kh, name_en: x.name_en, qty: 0, sales: 0, cost: 0, invoices: 0, returned_qty: 0 };
      v.qty += sign * x.qty;
      v.sales += sign * x.amount;
      v.cost += sign * x.cost;
      if (sign > 0) v.invoices += x.docs.length;
      else v.returned_qty += x.qty;
      byVariant.set(k, v);
    };
    sold.forEach((x) => add(x, 1));
    back.forEach((x) => add(x, -1));
    const variants = [...byVariant.values()];
    const productIds = [...new Set(variants.map((v) => String(v.product_id)).filter((x) => x && x !== "undefined"))].map((x) => new mongoose.Types.ObjectId(x));
    const products = await mongoose.model("Product").find({ _id: { $in: productIds } }).select("code name_kh name_en brand_id category_id image").populate([{ path: "brand_id", select: "code name_kh name_en" }, { path: "category_id", select: "code name_kh name_en" }]).lean();
    const pMap = new Map(products.map((p) => [String(p._id), p]));
    const sMap = group === "supplier" ? await supplierOf(variants.map((v) => v.variant_id)) : new Map();
    let supNames = new Map();
    if (group === "supplier") {
      const sups = await mongoose.model("Supplier").find({ _id: { $in: [...new Set([...sMap.values()].map(String))].map((x) => new mongoose.Types.ObjectId(x)) } }).select("code name").lean();
      supNames = new Map(sups.map((x) => [String(x._id), x]));
    }
    const keyOf = (v) => {
      const p = pMap.get(String(v.product_id));
      if (group === "variant") return { key: String(v.variant_id), code: v.sku, name_kh: v.name_kh, name_en: v.name_en };
      if (group === "product") return p ? { key: String(p._id), code: p.code, name_kh: p.name_kh, name_en: p.name_en, image: p.image?.url || null } : { key: "-", code: "", name_kh: "(លុប)", name_en: "(deleted)" };
      if (group === "brand") return p?.brand_id ? { key: String(p.brand_id._id), code: p.brand_id.code, name_kh: p.brand_id.name_kh, name_en: p.brand_id.name_en } : { key: "-", code: "", name_kh: "គ្មានម៉ាក", name_en: "No brand" };
      if (group === "category") return p?.category_id ? { key: String(p.category_id._id), code: p.category_id.code, name_kh: p.category_id.name_kh, name_en: p.category_id.name_en } : { key: "-", code: "", name_kh: "-", name_en: "-" };
      const sid = sMap.get(String(v.variant_id));
      const sp = sid && supNames.get(String(sid));
      return sp ? { key: String(sid), code: sp.code, name_kh: sp.name, name_en: sp.name } : { key: "-", code: "", name_kh: "មិនស្គាល់ (មិនមានការទិញចូល)", name_en: "Unknown (no goods receive)" };
    };
    const rows = new Map();
    variants.forEach((v) => {
      const k = keyOf(v);
      const row = rows.get(k.key) || { ...k, qty: 0, returned_qty: 0, sales: 0, cost: 0, invoices: 0, items: 0 };
      row.qty += v.qty;
      row.returned_qty += v.returned_qty;
      row.sales += v.sales;
      row.cost += v.cost;
      row.invoices += v.invoices;
      row.items += 1;
      rows.set(k.key, row);
    });
    const out = [...rows.values()].map((x) => {
      const profit = x.sales - x.cost;
      return { ...x, qty: r2(x.qty), returned_qty: r2(x.returned_qty), sales: r2(x.sales), cost: r2(x.cost), profit: r2(profit), margin: x.sales > 0 ? r2((profit / x.sales) * 100) : 0 };
    });
    const sort = ["sales", "profit", "margin", "qty", "cost"].includes(req.query.sort) ? req.query.sort : "profit";
    out.sort((a, b) => b[sort] - a[sort]);
    const tot = out.reduce((t, x) => ({ qty: t.qty + x.qty, sales: t.sales + x.sales, cost: t.cost + x.cost }), { qty: 0, sales: 0, cost: 0 });
    const totals = { qty: r2(tot.qty), sales: r2(tot.sales), cost: r2(tot.cost), profit: r2(tot.sales - tot.cost), margin: tot.sales > 0 ? r2(((tot.sales - tot.cost) / tot.sales) * 100) : 0, rows: out.length };
    ok(res, out, { totals, group, range: { from: s.range.fromYmd, to: s.range.toYmd } });
  }));

  // ?days=60&warehouse_id → what sits on the shelf: no sale in `days` (dead) or selling slowly (≤ days of cover)
  prop.app.get(`${base}/slow-stock`, ...guard, wrap(async (req, res) => {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 60));
    const s = saleFilter(req, { withDate: false });
    if (!s) return bad(res, "មិនមានសិទ្ធិលើឃ្លាំងនេះ", 403);
    const cost = seesCost(req);
    const bf = { qty: { $gt: 0 } };
    if (s.filter.warehouse_id) bf.warehouse_id = s.filter.warehouse_id;
    const since = new Date(Date.now() - days * DAY);
    const [bals, sales, lastSale] = await Promise.all([
      StockBalanceModel.find(bf).select("warehouse_id product_id variant_id qty avg_cost last_movement_at").lean(),
      SaleModel.aggregate([{ $match: { ...s.filter, sold_at: { $gte: since } } }, { $unwind: "$items" }, { $group: { _id: { w: "$warehouse_id", v: "$items.variant_id" }, qty: { $sum: "$items.base_qty" } } }]),
      SaleModel.aggregate([{ $match: { ...s.filter } }, { $unwind: "$items" }, { $group: { _id: { w: "$warehouse_id", v: "$items.variant_id" }, at: { $max: "$sold_at" } } }]),
    ]);
    const k = (w, v) => `${w}|${v}`;
    const soldMap = new Map(sales.map((x) => [k(x._id.w, x._id.v), x.qty]));
    const lastMap = new Map(lastSale.map((x) => [k(x._id.w, x._id.v), x.at]));
    const [variants, whs] = await Promise.all([
      mongoose.model("ProductVariant").find({ _id: { $in: bals.map((b) => b.variant_id) } }).select("sku name_kh name_en product_id").populate({ path: "product_id", select: "code name_kh name_en image" }).lean(),
      mongoose.model("Warehouse").find({ _id: { $in: [...new Set(bals.map((b) => String(b.warehouse_id)))] } }).select("code name_kh name_en type").lean(),
    ]);
    const vMap = new Map(variants.map((v) => [String(v._id), v]));
    const wMap = new Map(whs.map((w) => [String(w._id), w]));
    let rows = bals.map((b) => {
      const v = vMap.get(String(b.variant_id));
      const soldQty = soldMap.get(k(b.warehouse_id, b.variant_id)) || 0;
      const last = lastMap.get(k(b.warehouse_id, b.variant_id)) || null;
      const perDay = soldQty / days;
      const row = {
        warehouse: wMap.get(String(b.warehouse_id)) || null,
        variant_id: b.variant_id,
        sku: v?.sku || "",
        name_kh: v ? `${v.product_id?.name_kh || ""} ${v.name_kh || ""}`.trim() : "",
        name_en: v ? `${v.product_id?.name_en || v.product_id?.name_kh || ""} ${v.name_en || ""}`.trim() : "",
        image: v?.product_id?.image?.url || null,
        qty: r2(b.qty),
        sold_qty: r2(soldQty),
        last_sold_at: last,
        days_since_sale: last ? Math.floor((Date.now() - new Date(last).getTime()) / DAY) : null,
        days_of_cover: perDay > 0 ? Math.round(b.qty / perDay) : null,
        status: soldQty === 0 ? "dead" : b.qty / perDay > days * 2 ? "slow" : "ok",
      };
      if (cost) row.value = r2(b.qty * (b.avg_cost || 0));
      return row;
    });
    rows = rows.filter((r) => r.status !== "ok" && (r.warehouse?.type !== "central" || req.query.central === "1"));
    rows.sort((a, b) => (a.status === b.status ? (b.value || b.qty) - (a.value || a.qty) : a.status === "dead" ? -1 : 1));
    const summary = { days, dead: rows.filter((r) => r.status === "dead").length, slow: rows.filter((r) => r.status === "slow").length };
    if (cost) {
      summary.dead_value = r2(rows.filter((r) => r.status === "dead").reduce((t, r) => t + r.value, 0));
      summary.slow_value = r2(rows.filter((r) => r.status === "slow").reduce((t, r) => t + r.value, 0));
    }
    ok(res, rows.slice(0, 1000), { summary });
  }));
};
