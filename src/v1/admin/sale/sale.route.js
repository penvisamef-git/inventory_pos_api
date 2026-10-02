const mongoose = require("mongoose");
const { SaleModel, PosShiftModel, PosDeviceModel, RefundModel } = require("../pos/pos.model");
const WarehouseModel = require("../setup/warehouse/warehouse.model");
const { serverError } = require("../../../util/master_crud");
const { allow_roles, ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_ACCOUNTANT, ROLE_SHOP_MANAGER } = require("../../../util/permission");
const { warehouse_scope, canAccessWarehouse } = require("../../../util/warehouse_scope");

// =============================================================================================
// Sales received from the POS — for the admin web (Sales) and the shop portal.
//   GET /sale            invoices (filters + totals of the filter)
//   GET /sale/report     totals, by day / hour / shop / cashier / payment / category / item
//   GET /sale/shift      cash drawer shifts (float, expected vs counted)
//   GET /sale/filters    shops, POS, cashiers, payment methods to filter with
//   GET /sale/:id        one invoice
// Admin / central manager / accountant: every shop, with cost and profit.
// Shop manager: own shops only, no cost / profit (same rule as the stock screens).
// Filters: from, to (YYYY-MM-DD, Phnom Penh day), warehouse_id, device_id, cashier_id, method (payment code), q
// =============================================================================================
const TZ = "Asia/Phnom_Penh";
const DAY = 86400000;
const MAX_DAYS = 400;
const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const ok = (res, data, extra = {}) => res.status(200).json({ success: true, data, ...extra });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const ymdPP = (d) => new Date(new Date(d).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// from / to → { from: Date, to: Date (exclusive), fromYmd, toYmd } — default: today
function dateRange(q) {
  const today = ymdPP(Date.now());
  const ok1 = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  let fromYmd = ok1(q.from) ? q.from : today;
  let toYmd = ok1(q.to) ? q.to : fromYmd;
  if (toYmd < fromYmd) [fromYmd, toYmd] = [toYmd, fromYmd];
  const from = new Date(`${fromYmd}T00:00:00+07:00`);
  let to = new Date(new Date(`${toYmd}T00:00:00+07:00`).getTime() + DAY);
  if ((to - from) / DAY > MAX_DAYS) {
    to = new Date(from.getTime() + MAX_DAYS * DAY);
    toYmd = ymdPP(to.getTime() - 1);
  }
  return { from, to, fromYmd, toYmd };
}

// the Mongo filter for the request (scope + query)
function saleFilter(req, { withDate = true } = {}) {
  const q = req.query;
  const f = { state: "paid" };
  if (req.warehouse_ids) f.warehouse_id = { $in: req.warehouse_ids };
  if (isId(q.warehouse_id)) {
    if (!canAccessWarehouse(req, q.warehouse_id)) return null;
    f.warehouse_id = oid(q.warehouse_id);
  }
  if (isId(q.device_id)) f.device_id = oid(q.device_id);
  if (isId(q.cashier_id)) f.cashier_id = oid(q.cashier_id);
  if (q.method) f["payments.code"] = String(q.method);
  if (q.q) {
    const re = { $regex: escapeRe(String(q.q).trim()), $options: "i" };
    f.$or = [{ invoice_no: re }, { "items.sku": re }, { cashier_name: re }];
  }
  if (q.flag === "discount") f.discount_total = { $gt: 0 };
  if (q.flag === "override") f.stock_override_by = { $ne: null };
  if (q.flag === "refunded") f.refund_count = { $gt: 0 };
  let range = null;
  if (withDate) {
    range = dateRange(q);
    f.sold_at = { $gte: range.from, $lt: range.to };
  }
  return { filter: f, range };
}

const seesCost = (req) => req.warehouse_scope === "all";
const hideCost = (row) => {
  if (!row) return row;
  const { cost_total, profit, margin, ...rest } = row;
  if (Array.isArray(rest.items)) rest.items = rest.items.map(({ unit_cost, cost_total: c, ...i }) => i);
  return rest;
};

// payments are what the customer handed over; take the change back out of the cash methods
function netMethods(methods, change) {
  let leftUsd = change.give_usd;
  let leftKhrUsd = change.give_khr_usd;
  let other = change.other; // old sales without the split: out of USD cash first
  const rows = methods.map((m) => ({ ...m, net_usd: m.amount_usd }));
  const cash = (cur) => rows.find((m) => m.type === "cash" && (m.currency || "USD") === cur);
  const take = (row, v) => {
    if (!row || v <= 0) return v;
    const t = Math.min(v, row.net_usd);
    row.net_usd -= t;
    return v - t;
  };
  leftUsd = take(cash("USD"), leftUsd);
  leftKhrUsd = take(cash("KHR"), leftKhrUsd);
  other = take(cash("USD"), other + leftUsd);
  take(cash("KHR"), other + leftKhrUsd);
  return rows.map((m) => ({ ...m, amount_usd: r2(m.amount_usd), net_usd: r2(m.net_usd), amount: m.currency === "KHR" ? Math.round(m.amount) : r2(m.amount) })).sort((a, b) => b.net_usd - a.net_usd);
}

const route = (prop) => {
  const base = `/${prop.main_route}/sale`;
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_ACCOUNTANT, ROLE_SHOP_MANAGER), warehouse_scope];
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  };

  // ===================================== invoices ================================================
  prop.app.get(base, ...guard, wrap(async (req, res) => {
    const s = saleFilter(req);
    if (!s) return bad(res, "មិនមានសិទ្ធិលើឃ្លាំងនេះ", 403);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);
    const [out] = await SaleModel.aggregate([
      { $match: s.filter },
      {
        $facet: {
          rows: [
            { $sort: { sold_at: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            { $addFields: { item_count: { $size: "$items" }, item_qty: { $sum: "$items.qty" } } },
            { $project: { items: 0, stock_override_items: 0 } },
          ],
          sum: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                total: { $sum: "$total" },
                discount_total: { $sum: "$discount_total" },
                tax_total: { $sum: "$tax_amount" },
                cost_total: { $sum: { $ifNull: ["$cost_total", 0] } },
              },
            },
          ],
        },
      },
    ]);
    const rows = out.rows;
    const [whs, devs] = await Promise.all([
      WarehouseModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.warehouse_id)))] } }).select("code name_kh name_en").lean(),
      PosDeviceModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.device_id)))] } }).select("code name").lean(),
    ]);
    const wMap = new Map(whs.map((w) => [String(w._id), w]));
    const dMap = new Map(devs.map((d) => [String(d._id), d]));
    const cost = seesCost(req);
    const data = rows.map((r) => {
      const row = { ...r, warehouse_id: wMap.get(String(r.warehouse_id)) || r.warehouse_id, device_id: dMap.get(String(r.device_id)) || r.device_id };
      if (cost && r.cost_total !== null && r.cost_total !== undefined) row.profit = r2(r.total - r.tax_amount - r.cost_total);
      return cost ? row : hideCost(row);
    });
    const sm = out.sum[0] || { count: 0, total: 0, discount_total: 0, tax_total: 0, cost_total: 0 };
    const summary = { count: sm.count, total: r2(sm.total), discount_total: r2(sm.discount_total), tax_total: r2(sm.tax_total), average: sm.count ? r2(sm.total / sm.count) : 0 };
    if (cost) {
      summary.cost_total = r2(sm.cost_total);
      summary.profit = r2(sm.total - sm.tax_total - sm.cost_total);
    }
    ok(res, data, { summary, range: { from: s.range.fromYmd, to: s.range.toYmd }, pagination: { total: sm.count, page, limit, totalPages: Math.max(Math.ceil(sm.count / limit), 1) } });
  }));

  // ===================================== report ================================================
  prop.app.get(`${base}/report`, ...guard, wrap(async (req, res) => {
    const s = saleFilter(req);
    if (!s) return bad(res, "មិនមានសិទ្ធិលើឃ្លាំងនេះ", 403);
    const cost = seesCost(req);
    const days = Math.round((s.range.to - s.range.from) / DAY);
    // the same length just before, to compare
    const prevFilter = { ...s.filter, sold_at: { $gte: new Date(s.range.from.getTime() - days * DAY), $lt: s.range.from } };
    const sumStage = {
      $group: {
        _id: null,
        count: { $sum: 1 },
        total: { $sum: "$total" },
        total_khr: { $sum: "$total_khr" },
        subtotal: { $sum: "$subtotal" },
        discount_total: { $sum: "$discount_total" },
        discount_count: { $sum: { $cond: [{ $gt: ["$discount_total", 0] }, 1, 0] } },
        override_count: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$stock_override_by", null] }, null] }, 1, 0] } },
        tax_total: { $sum: "$tax_amount" },
        cost_total: { $sum: { $ifNull: ["$cost_total", 0] } },
        item_qty: { $sum: { $sum: "$items.qty" } },
        give_usd: { $sum: { $ifNull: ["$change_give_usd", 0] } },
        give_khr_usd: { $sum: { $divide: [{ $ifNull: ["$change_give_khr", 0] }, { $ifNull: ["$rate", 4100] }] } },
        change_usd: { $sum: { $ifNull: ["$change_usd", 0] } },
        first_at: { $min: "$sold_at" },
        last_at: { $max: "$sold_at" },
      },
    };
    const byGroup = (key) => [{ $group: { _id: key, count: { $sum: 1 }, total: { $sum: "$total" }, tax: { $sum: "$tax_amount" }, cost: { $sum: { $ifNull: ["$cost_total", 0] } }, name: { $first: "$cashier_name" } } }, { $sort: { total: -1 } }];
    // refunds / voids made in the period (counted on the day of the refund)
    const rf = { refunded_at: s.filter.sold_at };
    ["warehouse_id", "device_id", "cashier_id"].forEach((k) => s.filter[k] && (rf[k] = s.filter[k]));
    const refundSum = (match) =>
      RefundModel.aggregate([{ $match: match }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$total" }, cost: { $sum: { $ifNull: ["$cost_total", 0] } }, voids: { $sum: { $cond: [{ $eq: ["$kind", "void"] }, 1, 0] } } } }]);
    const [refundNow, refundPrev, refundDays] = await Promise.all([
      refundSum(rf),
      refundSum({ ...rf, refunded_at: prevFilter.sold_at }),
      RefundModel.aggregate([{ $match: rf }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$refunded_at", timezone: TZ } }, total: { $sum: "$total" } } }]),
    ]);
    const rn = refundNow[0] || { count: 0, total: 0, cost: 0, voids: 0 };
    const rp = refundPrev[0] || { count: 0, total: 0, cost: 0 };
    const [[out], prev] = await Promise.all([
      SaleModel.aggregate([
        { $match: s.filter },
        {
          $facet: {
            sum: [sumStage],
            by_day: [{ $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$sold_at", timezone: TZ } }, count: { $sum: 1 }, total: { $sum: "$total" }, tax: { $sum: "$tax_amount" }, cost: { $sum: { $ifNull: ["$cost_total", 0] } } } }, { $sort: { _id: 1 } }],
            by_hour: [{ $group: { _id: { $hour: { date: "$sold_at", timezone: TZ } }, count: { $sum: 1 }, total: { $sum: "$total" } } }, { $sort: { _id: 1 } }],
            by_weekday: [{ $group: { _id: { $isoDayOfWeek: { date: "$sold_at", timezone: TZ } }, count: { $sum: 1 }, total: { $sum: "$total" } } }, { $sort: { _id: 1 } }],
            by_shop: byGroup("$warehouse_id"),
            by_device: byGroup("$device_id"),
            by_cashier: byGroup("$cashier_id"),
            methods: [
              { $unwind: "$payments" },
              { $group: { _id: "$payments.code", name_kh: { $first: "$payments.name_kh" }, name_en: { $first: "$payments.name_en" }, type: { $first: "$payments.type" }, currency: { $first: "$payments.currency" }, count: { $sum: 1 }, amount: { $sum: "$payments.amount" }, amount_usd: { $sum: "$payments.amount_usd" } } },
            ],
            items: [
              { $unwind: "$items" },
              { $group: { _id: "$items.variant_id", product_id: { $first: "$items.product_id" }, sku: { $first: "$items.sku" }, name_kh: { $first: "$items.name_kh" }, name_en: { $first: "$items.name_en" }, qty: { $sum: "$items.base_qty" }, total: { $sum: "$items.line_total" }, cost: { $sum: { $ifNull: ["$items.cost_total", 0] } }, invoices: { $sum: 1 } } },
              { $sort: { total: -1 } },
              { $limit: 30 },
            ],
            categories: [
              { $unwind: "$items" },
              { $lookup: { from: "products", localField: "items.product_id", foreignField: "_id", as: "p", pipeline: [{ $project: { category_id: 1 } }] } },
              { $group: { _id: { $first: "$p.category_id" }, qty: { $sum: "$items.base_qty" }, total: { $sum: "$items.line_total" }, cost: { $sum: { $ifNull: ["$items.cost_total", 0] } } } },
              { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "c", pipeline: [{ $project: { code: 1, name_kh: 1, name_en: 1, parent_id: 1 } }] } },
              { $sort: { total: -1 } },
            ],
          },
        },
      ]),
      SaleModel.aggregate([{ $match: prevFilter }, sumStage]),
    ]);

    const sm = out.sum[0] || {};
    const pv = prev[0] || {};
    const [whs, devs, product] = await Promise.all([
      WarehouseModel.find({ _id: { $in: out.by_shop.map((x) => x._id) } }).select("code name_kh name_en").lean(),
      PosDeviceModel.find({ _id: { $in: out.by_device.map((x) => x._id) } }).select("code name warehouse_id").lean(),
      mongoose.model("Product").find({ _id: { $in: out.items.map((x) => x.product_id) } }).select("name_kh name_en code image").lean(),
    ]);
    const wMap = new Map(whs.map((w) => [String(w._id), w]));
    const dMap = new Map(devs.map((d) => [String(d._id), d]));
    const pMap = new Map(product.map((p) => [String(p._id), p]));
    const money = (x) => {
      const row = { count: x.count, total: r2(x.total) };
      if (cost) {
        row.cost = r2(x.cost);
        row.profit = r2(x.total - (x.tax || 0) - x.cost);
      }
      return row;
    };
    const total = r2(sm.total);
    const kpi = {
      count: sm.count || 0,
      total,
      total_khr: Math.round(sm.total_khr || 0),
      subtotal: r2(sm.subtotal),
      discount_total: r2(sm.discount_total),
      discount_count: sm.discount_count || 0,
      override_count: sm.override_count || 0,
      tax_total: r2(sm.tax_total),
      item_qty: r2(sm.item_qty),
      average: sm.count ? r2(total / sm.count) : 0,
      first_at: sm.first_at || null,
      last_at: sm.last_at || null,
      refund_count: rn.count,
      void_count: rn.voids,
      refund_total: r2(rn.total),
      net_total: r2(total - rn.total), // sales − money given back
      prev: { count: pv.count || 0, total: r2(pv.total), net_total: r2((pv.total || 0) - rp.total), from: ymdPP(prevFilter.sold_at.$gte), to: ymdPP(s.range.from.getTime() - 1) },
    };
    if (cost) {
      // goods that came back return their cost, so profit loses (refund − its cost)
      kpi.cost_total = r2((sm.cost_total || 0) - rn.cost);
      kpi.profit = r2(total - (sm.tax_total || 0) - (sm.cost_total || 0) - (rn.total - rn.cost));
      const netNoTax = total - (sm.tax_total || 0) - rn.total;
      kpi.margin = netNoTax > 0 ? r2((kpi.profit / netNoTax) * 100) : 0;
      kpi.prev.profit = r2((pv.total || 0) - (pv.tax_total || 0) - (pv.cost_total || 0) - (rp.total - rp.cost));
    }
    // every day of the range (0 when nothing was sold)
    const dayMap = new Map(out.by_day.map((d) => [d._id, d]));
    const byDay = [];
    for (let t = s.range.from.getTime(); t < s.range.to.getTime() && byDay.length < MAX_DAYS; t += DAY) {
      const k = ymdPP(t);
      const d = dayMap.get(k) || { count: 0, total: 0, tax: 0, cost: 0 };
      const back = refundDays.find((x) => x._id === k)?.total || 0;
      byDay.push({ date: k, ...money(d), refund: r2(back) });
    }
    ok(res, {
      range: { from: s.range.fromYmd, to: s.range.toYmd, days },
      scope: req.warehouse_scope,
      kpi,
      by_day: byDay,
      by_hour: out.by_hour.map((h) => ({ hour: h._id, count: h.count, total: r2(h.total) })),
      by_weekday: out.by_weekday.map((h) => ({ day: h._id, count: h.count, total: r2(h.total) })),
      by_shop: out.by_shop.map((x) => ({ _id: x._id, warehouse: wMap.get(String(x._id)) || null, ...money(x) })),
      by_device: out.by_device.map((x) => ({ _id: x._id, device: dMap.get(String(x._id)) || null, warehouse: wMap.get(String(dMap.get(String(x._id))?.warehouse_id)) || null, ...money(x) })),
      by_cashier: out.by_cashier.map((x) => ({ _id: x._id, name: x.name || "-", ...money(x) })),
      methods: netMethods(out.methods.map(({ _id, ...m }) => ({ code: _id, ...m })), { give_usd: sm.give_usd || 0, give_khr_usd: sm.give_khr_usd || 0, other: Math.max(0, (sm.change_usd || 0) - (sm.give_usd || 0) - (sm.give_khr_usd || 0)) }),
      categories: out.categories.map((c) => {
        const cat = c.c?.[0];
        const row = { _id: c._id, category: cat ? { code: cat.code, name_kh: cat.name_kh, name_en: cat.name_en } : null, qty: r2(c.qty), total: r2(c.total) };
        if (cost) {
          row.cost = r2(c.cost);
          row.profit = r2(c.total - c.cost);
        }
        return row;
      }),
      top_items: out.items.map((i) => {
        const p = pMap.get(String(i.product_id));
        const row = { variant_id: i._id, product: p ? { _id: p._id, code: p.code, name_kh: p.name_kh, name_en: p.name_en, image: p.image?.url || null } : null, sku: i.sku, name_kh: i.name_kh, name_en: i.name_en, qty: r2(i.qty), total: r2(i.total), invoices: i.invoices };
        if (cost) {
          row.cost = r2(i.cost);
          row.profit = r2(i.total - i.cost);
        }
        return row;
      }),
    });
  }));

  // ===================================== shifts ================================================
  prop.app.get(`${base}/shift`, ...guard, wrap(async (req, res) => {
    const q = req.query;
    const f = {};
    if (req.warehouse_ids) f.warehouse_id = { $in: req.warehouse_ids };
    if (isId(q.warehouse_id)) {
      if (!canAccessWarehouse(req, q.warehouse_id)) return bad(res, "មិនមានសិទ្ធិលើឃ្លាំងនេះ", 403);
      f.warehouse_id = oid(q.warehouse_id);
    }
    if (isId(q.device_id)) f.device_id = oid(q.device_id);
    if (q.state === "open" || q.state === "closed") f.state = q.state;
    if (q.flag === "diff") Object.assign(f, { state: "closed", "report.diff_total_usd": { $not: { $gte: -0.009, $lte: 0.009 } } });
    const range = dateRange(q);
    f.opened_at = { $gte: range.from, $lt: range.to };
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 30, 1), 200);
    const [rows, total, sum] = await Promise.all([
      PosShiftModel.find(f).populate([{ path: "warehouse_id", select: "code name_kh name_en" }, { path: "device_id", select: "code name" }]).sort({ opened_at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PosShiftModel.countDocuments(f),
      PosShiftModel.aggregate([{ $match: f }, { $group: { _id: null, sales: { $sum: { $ifNull: ["$report.sales_total", 0] } }, diff: { $sum: { $ifNull: ["$report.diff_total_usd", 0] } }, open: { $sum: { $cond: [{ $eq: ["$state", "open"] }, 1, 0] } }, short: { $sum: { $cond: [{ $lt: [{ $ifNull: ["$report.diff_total_usd", 0] }, -0.009] }, 1, 0] } } } }]),
    ]);
    const sm = sum[0] || {};
    ok(res, rows, {
      summary: { count: total, open: sm.open || 0, short: sm.short || 0, sales_total: r2(sm.sales), diff_total_usd: r2(sm.diff) },
      range: { from: range.fromYmd, to: range.toYmd },
      pagination: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) },
    });
  }));

  // ===================================== filter lists ================================================
  prop.app.get(`${base}/filters`, ...guard, wrap(async (req, res) => {
    const scope = req.warehouse_ids ? { warehouse_id: { $in: req.warehouse_ids } } : {};
    if (isId(req.query.warehouse_id) && canAccessWarehouse(req, req.query.warehouse_id)) scope.warehouse_id = oid(req.query.warehouse_id);
    const since = new Date(Date.now() - 400 * DAY);
    const [shops, devices, cashiers, methods] = await Promise.all([
      WarehouseModel.find({ deleted: false, ...(req.warehouse_ids ? { _id: { $in: req.warehouse_ids } } : {}) }).select("code name_kh name_en type").sort({ code: 1 }).lean(),
      PosDeviceModel.find({ deleted: false, ...scope }).select("code name warehouse_id").sort({ code: 1 }).lean(),
      SaleModel.aggregate([{ $match: { ...scope, sold_at: { $gte: since } } }, { $group: { _id: "$cashier_id", name: { $last: "$cashier_name" } } }, { $sort: { name: 1 } }]),
      SaleModel.aggregate([{ $match: { ...scope, sold_at: { $gte: since } } }, { $unwind: "$payments" }, { $group: { _id: "$payments.code", name_kh: { $first: "$payments.name_kh" }, name_en: { $first: "$payments.name_en" } } }, { $sort: { _id: 1 } }]),
    ]);
    ok(res, { shops, devices, cashiers: cashiers.filter((c) => c._id), methods: methods.map((m) => ({ code: m._id, name_kh: m.name_kh, name_en: m.name_en })), cost: seesCost(req) });
  }));

  // ===================================== one invoice ================================================
  prop.app.get(`${base}/:id`, ...guard, wrap(async (req, res) => {
    const id = req.params.id;
    const doc = await SaleModel.findOne(isId(id) ? { _id: id } : { invoice_no: String(id) })
      .populate([{ path: "warehouse_id", select: "code name_kh name_en address phone" }, { path: "device_id", select: "code name" }])
      .lean();
    if (!doc || !canAccessWarehouse(req, doc.warehouse_id?._id)) return bad(res, "រកមិនឃើញវិក្កយបត្រ", 404);
    const shift = doc.shift_no ? await PosShiftModel.findOne({ device_id: doc.device_id?._id, shift_no: doc.shift_no }).select("shift_no state opened_at closed_at opened_by_name closed_by_name").lean() : null;
    const refunds = await RefundModel.find({ sale_id: doc._id }).sort({ refunded_at: 1 }).lean();
    const row = { ...doc, shift, refunds: seesCost(req) ? refunds : refunds.map((x) => ({ ...x, cost_total: undefined, items: x.items.map(({ unit_cost, cost_total: c, ...i }) => i) })) };
    if (seesCost(req) && doc.cost_total !== null && doc.cost_total !== undefined) row.profit = r2(doc.total - doc.tax_amount - doc.cost_total);
    ok(res, seesCost(req) ? row : hideCost(row));
  }));
};

module.exports = route;
