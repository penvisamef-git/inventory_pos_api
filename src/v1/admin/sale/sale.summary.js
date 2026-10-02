// "Today" sales block for the dashboards (admin home + shop portal). warehouseIds: null = every shop.
const { SaleModel, RefundModel, PosDeviceModel, PosShiftModel } = require("../pos/pos.model");

const TZ = "Asia/Phnom_Penh";
const DAY = 86400000;
const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const ymdPP = (d) => new Date(new Date(d).getTime() + 7 * 3600e3).toISOString().slice(0, 10);
const ONLINE_MS = 2 * 60 * 1000; // a POS pings every ~20 s

async function salesToday(warehouseIds, { withCost = false } = {}) {
  const now = new Date();
  const today = new Date(`${ymdPP(now)}T00:00:00+07:00`);
  const yesterday = new Date(today.getTime() - DAY);
  const week = new Date(today.getTime() - 6 * DAY);
  const wh = warehouseIds ? { warehouse_id: { $in: warehouseIds } } : {};
  const paid = { ...wh, state: "paid" };
  const sum = (from, to) =>
    SaleModel.aggregate([{ $match: { ...paid, sold_at: { $gte: from, $lt: to } } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$total" }, tax: { $sum: "$tax_amount" }, cost: { $sum: { $ifNull: ["$cost_total", 0] } }, discount: { $sum: "$discount_total" }, last: { $max: "$sold_at" } } }]);
  const [t, y, days, refunds, top, devices, shifts] = await Promise.all([
    sum(today, now),
    sum(yesterday, new Date(now.getTime() - DAY)), // yesterday until the same time
    SaleModel.aggregate([{ $match: { ...paid, sold_at: { $gte: week, $lt: now } } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$sold_at", timezone: TZ } }, total: { $sum: "$total" }, count: { $sum: 1 } } }]),
    RefundModel.aggregate([{ $match: { ...wh, refunded_at: { $gte: today, $lt: now } } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$total" }, cost: { $sum: { $ifNull: ["$cost_total", 0] } } } }]),
    SaleModel.aggregate([{ $match: { ...paid, sold_at: { $gte: today, $lt: now } } }, { $unwind: "$items" }, { $group: { _id: "$items.variant_id", sku: { $first: "$items.sku" }, name_kh: { $first: "$items.name_kh" }, name_en: { $first: "$items.name_en" }, qty: { $sum: "$items.qty" }, total: { $sum: "$items.line_total" } } }, { $sort: { total: -1 } }, { $limit: 5 }]),
    PosDeviceModel.find({ ...wh, deleted: false }).select("code name status paired_at last_seen_at warehouse_id").lean(),
    PosShiftModel.find({ ...wh, state: "open" }).populate("device_id", "code name").sort({ opened_at: 1 }).lean(),
  ]);
  const a = t[0] || { count: 0, total: 0, tax: 0, cost: 0, discount: 0, last: null };
  const b = y[0] || { count: 0, total: 0 };
  const rf = refunds[0] || { count: 0, total: 0, cost: 0 };
  const dayMap = new Map(days.map((d) => [d._id, d]));
  const out = {
    today: {
      count: a.count,
      total: r2(a.total),
      discount: r2(a.discount),
      average: a.count ? r2(a.total / a.count) : 0,
      refund_count: rf.count,
      refund_total: r2(rf.total),
      net_total: r2(a.total - rf.total),
      last_sale_at: a.last,
    },
    yesterday: { count: b.count, total: r2(b.total) }, // until the same time of day
    days: Array.from({ length: 7 }, (_, k) => {
      const date = ymdPP(week.getTime() + k * DAY + 12 * 3600e3);
      const d = dayMap.get(date);
      return { date, total: r2(d?.total), count: d?.count || 0 };
    }),
    top_items: top.map((i) => ({ variant_id: i._id, sku: i.sku, name_kh: i.name_kh, name_en: i.name_en, qty: r2(i.qty), total: r2(i.total) })),
    pos: {
      devices: devices.filter((d) => d.paired_at && d.status).length,
      online: devices.filter((d) => d.paired_at && d.status && d.last_seen_at && now - new Date(d.last_seen_at) < ONLINE_MS).length,
      list: devices.filter((d) => d.paired_at).map((d) => ({ _id: d._id, code: d.code, name: d.name, status: d.status, online: !!d.last_seen_at && now - new Date(d.last_seen_at) < ONLINE_MS, last_seen_at: d.last_seen_at })),
      open_shifts: shifts.map((s) => ({ _id: s._id, shift_no: s.shift_no, device: s.device_id?.code, opened_by_name: s.opened_by_name, opened_at: s.opened_at })),
    },
  };
  if (withCost) out.today.profit = r2(a.total - a.tax - a.cost - (rf.total - rf.cost));
  return out;
}

module.exports = { salesToday };
