// Turn business actions into Telegram events. Every function is fire-and-forget (never throws, never awaited by callers).
const WarehouseModel = require("../setup/warehouse/warehouse.model");
const { notify, esc, timeText } = require("./telegram.service");

const REASON = {
  damaged: ["ខូចខាត", "Damaged"], expired: ["ផុតកំណត់", "Expired"], lost: ["បាត់", "Lost"], found: ["រកឃើញ", "Found"], other: ["ផ្សេងៗ", "Other"], transfer_shortage: ["ខ្វះពេលផ្ទេរ", "Transfer shortage"],
  stock_count: ["រាប់ស្តុក", "Stock count"],
};
const usd = (v) => `$${Number(v || 0).toFixed(2)}`;
const who = (req) => `${req?.user?.firstname || ""} ${req?.user?.lastname || ""}`.trim() || req?.user?.email || "-";
const codeOf = async (id) => (id?.code ? id.code : (await WarehouseModel.findById(id).select("code").lean())?.code || "-");
const idOf = (w) => w?._id || w;
// "• SKU × qty unit" lines (HTML-escaped)
const itemLines = (items, max = 8, signed = false) => {
  const rows = items.slice(0, max).map((i) => `• ${esc(i.sku)} × ${signed ? i.qty : Math.abs(i.qty)} ${esc(i.unit_code || "")}`);
  if (items.length > max) rows.push(`… +${items.length - max}`);
  return rows.join("\n");
};
const run = (fn) => {
  Promise.resolve()
    .then(fn)
    .catch((err) => console.error("telegram hook:", err.message));
};

const qtyOf = (items) => items.reduce((t, i) => t + Math.abs(i.base_qty || 0), 0);

const khr = (v) => `${Math.round(Number(v || 0)).toLocaleString("en-US")}៛`;
const payText = (payments = []) => payments.map((p) => `${p.name_en || p.code} ${p.currency === "KHR" ? khr(p.amount) : usd(p.amount)}`).join(" + ") || "-";
const saleLines = (items, max = 6) => {
  const rows = items.slice(0, max).map((i) => `• ${esc(i.name_kh || i.sku)} × ${i.qty} ${esc(i.unit_code || "")}`);
  if (items.length > max) rows.push(`… +${items.length - max}`);
  return rows.join("\n");
};

const hooks = {
  transferCreated: (doc, req) =>
    run(async () => {
      if (doc.state !== "requested") return;
      await notify("transfer_requested", {
        warehouse_ids: [idOf(doc.warehouse_id), idOf(doc.to_warehouse_id)],
        data: { doc_no: doc.doc_no, from: await codeOf(doc.warehouse_id), to: await codeOf(doc.to_warehouse_id), lines: doc.items.length, user: who(req) },
        ref: { type: "transfer", id: doc._id },
      });
    }),

  transferDispatched: (doc, req) =>
    run(async () =>
      notify("transfer_dispatched", {
        warehouse_ids: [idOf(doc.warehouse_id), idOf(doc.to_warehouse_id)],
        data: { doc_no: doc.doc_no, from: await codeOf(doc.warehouse_id), to: await codeOf(doc.to_warehouse_id), lines: doc.items.length, qty: qtyOf(doc.items), user: who(req) },
        ref: { type: "transfer", id: doc._id },
      }),
    ),

  transferReceived: (doc, req) =>
    run(async () => {
      const base = { from: await codeOf(doc.warehouse_id), to: await codeOf(doc.to_warehouse_id), doc_no: doc.doc_no, user: who(req) };
      const wh = [idOf(doc.warehouse_id), idOf(doc.to_warehouse_id)];
      await notify("transfer_received", { warehouse_ids: wh, data: { ...base, lines: doc.items.length, qty: doc.items.reduce((t, i) => t + (i.received_base_qty || 0), 0) }, ref: { type: "transfer", id: doc._id } });
      if (doc.shortage_qty > 0) {
        const short = doc.items.filter((i) => (i.received_qty ?? i.qty) < i.qty).map((i) => ({ ...i.toObject?.() ?? i, qty: i.qty - (i.received_qty ?? i.qty) }));
        await notify("transfer_shortage", {
          warehouse_ids: wh,
          data: { ...base, shortage_qty: doc.shortage_qty, shortage_cost: usd(doc.shortage_cost), note: doc.receive_note || "-", __raw: { items: itemLines(short) } },
          ref: { type: "transfer", id: doc._id },
        });
      }
    }),

  // ---------------- POS (sent by the POS with its push) ----------------
  posLogin: (device, a) =>
    run(async () =>
      notify("pos_login", {
        warehouse_ids: [device.warehouse_id],
        data: { warehouse: await codeOf(device.warehouse_id), name: a.name || "-", action: a.action === "login" ? "ចូល" : "ចេញពី", time: timeText(a.at), __en: { action: a.action === "login" ? "logged in to" : "logged out of" } },
        ref: { type: "pos_attendance", id: a._id },
        happened_at: a.at,
      }),
    ),

  shiftOpened: (device, sh) =>
    run(async () =>
      notify("shift_open", {
        warehouse_ids: [device.warehouse_id],
        data: { warehouse: await codeOf(device.warehouse_id), name: sh.opened_by_name || "-", shift_no: sh.shift_no, opening_cash: `${usd(sh.opening_usd)} + ${khr(sh.opening_khr)}` },
        ref: { type: "pos_shift", id: sh._id },
        happened_at: sh.opened_at,
      }),
    ),

  shiftClosed: (device, sh) =>
    run(async () => {
      const r = sh.report || {};
      const d = Number(r.diff_total_usd || 0);
      const diff = Math.abs(d) < 0.005 ? "✅ $0.00" : `${d < 0 ? "🔻 −" : "🔺 +"}${usd(Math.abs(r.diff_usd || 0))} ${r.diff_khr ? `${r.diff_khr < 0 ? "−" : "+"}${khr(Math.abs(r.diff_khr))}` : ""}`.trim();
      await notify("shift_close", {
        warehouse_ids: [device.warehouse_id],
        data: { warehouse: await codeOf(device.warehouse_id), name: sh.closed_by_name || "-", shift_no: sh.shift_no, sales_total: usd(r.net_total ?? r.sales_total), invoice_count: r.invoice_count || 0, difference: diff },
        ref: { type: "pos_shift", id: sh._id },
        happened_at: sh.closed_at || new Date(),
      });
    }),

  saleReceived: (device, sale) =>
    run(async () => {
      const flags = [sale.discount_total > 0 ? `\n🏷 −${usd(sale.discount_total)}${sale.discount_by_name ? ` (${esc(sale.discount_by_name)})` : ""}` : "", sale.stock_override_by_name ? `\n⚠️ out of stock · ${esc(sale.stock_override_by_name)}` : ""].join("");
      await notify("pos_sale", {
        warehouse_ids: [device.warehouse_id],
        data: { warehouse: await codeOf(device.warehouse_id), invoice_no: sale.invoice_no, total: usd(sale.total), payment: payText(sale.payments), name: sale.cashier_name || "-", __raw: { items: saleLines(sale.items), flags } },
        ref: { type: "invoice", id: sale._id },
        happened_at: sale.sold_at,
      });
    }),

  refundReceived: (device, rf) =>
    run(async () =>
      notify("invoice_void", {
        warehouse_ids: [device.warehouse_id],
        data: { warehouse: await codeOf(device.warehouse_id), kind: rf.kind === "void" ? "លុបចោល" : "សងប្រាក់", invoice_no: rf.invoice_no, total: `−${usd(rf.total)}`, name: rf.cashier_name || "-", approved_by: rf.approved_by_name || "-", reason: rf.reason || "-", __raw: { items: saleLines(rf.items) }, __en: { kind: rf.kind === "void" ? "VOID" : "Refund" } },
        ref: { type: "refund", id: rf._id },
        happened_at: rf.refunded_at,
      }),
    ),

  posOffline: (device, hours) =>
    run(async () =>
      notify("pos_offline", {
        warehouse_ids: [device.warehouse_id],
        data: { warehouse: `${await codeOf(device.warehouse_id)} · ${device.code}`, hours },
        ref: { type: "pos_device", id: device._id },
      }),
    ),

  // a shop manager saved a draft → central must approve
  adjustmentCreated: (doc, req) =>
    run(async () => {
      if (doc.state !== "draft" || !req.warehouse_ids) return;
      const [kh, en] = REASON[doc.reason] || [doc.reason, doc.reason];
      await notify("adjustment_waiting", {
        warehouse_ids: [idOf(doc.warehouse_id)],
        data: { warehouse: await codeOf(doc.warehouse_id), reason: kh, doc_no: doc.doc_no, user: who(req), __raw: { items: itemLines(doc.items) }, __en: { reason: en } },
        ref: { type: "stock_adjustment", id: doc._id },
      });
    }),

  adjustmentPosted: (doc, req) =>
    run(async () => {
      const [kh, en] = REASON[doc.reason] || [doc.reason, doc.reason];
      await notify("adjustment_posted", {
        warehouse_ids: [idOf(doc.warehouse_id)],
        data: { warehouse: await codeOf(doc.warehouse_id), reason: kh, doc_no: doc.doc_no, cost: usd(doc.posted_cost), user: who(req), __raw: { items: itemLines(doc.items, 8, true) }, __en: { reason: en } },
        ref: { type: "stock_adjustment", id: doc._id },
      });
    }),

  goodsReceived: (doc, req) =>
    run(async () => {
      const SupplierModel = require("../purchase/supplier/supplier.model");
      const sup = doc.supplier_id?.name || (await SupplierModel.findById(doc.supplier_id).select("name").lean())?.name || "-";
      await notify("goods_received", {
        warehouse_ids: [idOf(doc.warehouse_id)],
        data: { doc_no: doc.doc_no, supplier: sup, warehouse: await codeOf(doc.warehouse_id), lines: doc.items.length, qty: qtyOf(doc.items), cost: usd(doc.posted_cost ?? doc.total_cost), user: who(req) },
        ref: { type: "goods_receive", id: doc._id },
      });
    }),

  // rows: [{ variant code, price, warehouse code|null }]
  priceChanged: (rows, startAt, req) =>
    run(async () => {
      if (!rows.length) return;
      const shops = [...new Set(rows.map((r) => r.warehouse_id).filter(Boolean).map(String))];
      const lines = rows.slice(0, 10).map((r) => `• ${esc(r.sku)} ${r.unit ? esc(r.unit) + " " : ""}= ${r.price === null ? "default" : usd(r.price)}${r.shop ? ` (${esc(r.shop)})` : ""}`);
      if (rows.length > 10) lines.push(`… +${rows.length - 10}`);
      await notify("price_changed", {
        warehouse_ids: shops,
        data: { count: rows.length, scope: shops.length ? "shop" : "default", from_date: new Date(startAt).toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh", hour12: false }), user: who(req), __raw: { items: lines.join("\n") } },
      });
    }),

  staffChanged: (user, warehouseId, action, req) =>
    run(async () => {
      const ACT = { created: ["បានបន្ថែម", "added"], disabled: ["បានបិទ", "disabled"], enabled: ["បានបើក", "enabled"], pin: ["បានប្តូរ PIN", "PIN changed"] };
      const [kh, en] = ACT[action] || [action, action];
      await notify("staff_changed", {
        warehouse_ids: [warehouseId],
        data: { warehouse: await codeOf(warehouseId), action: kh, name: `${user.firstname} ${user.lastname}`.trim(), user: who(req), __en: { action: en } },
        ref: { type: "user", id: user._id },
      });
    }),
};

module.exports = hooks;
