// Integration test against the test database (UAT) — run all with: npm test
// POS: device pairing, pull (snapshot of one shop), push invoices → Sale + stock out.
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const M = (p) => require(API + "/src/v1/admin/" + p);
const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model");
const Unit = M("product/unit/unit.model"), Category = M("product/category/category.model");
const Product = M("product/item/product.model"), Variant = M("product/item/variant.model"), Price = M("product/price/price.model");
const Warehouse = M("setup/warehouse/warehouse.model"), Movement = M("stock/movement.model"), Opening = M("stock/opening/opening.model"), Batch = M("stock/batch.model");
const { StockBalanceModel: Bal, StockBatchBalanceModel: BBal } = M("stock/balance.model"); const Counter = M("counter/counter.model");
const { PosDeviceModel: Device, SaleModel: Sale, PosShiftModel: PosShift, RefundModel: Refund } = M("pos/pos.model");
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const counters = await Counter.find({}).lean();
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b, extra = {}) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}), ...extra }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "U", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return { id, t: (await call("POST", "/auth/login", null, { email, password: PASS })).json.data?.access_token }; };
  try {
    const admin = await mk("zz.p.admin@local.test", { is_super_admin: true });
    const central = await mk("zz.p.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    let r = await call("POST", "/setup/warehouse", admin.t, { code: "ZZP1", name_kh: "ហាង POS តេស្ត", type: "shop" }); const S1 = r.json.data._id;
    const cashier = await mk("zz.p.cashier@local.test", { role: ROLES.CASHIER.value, warehouse_ids: [S1], pos_pin: await bcrypt.hash("1234", 10) });
    const shop = await mk("zz.p.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [S1] });
    const pcs = (await Unit.findOne({ code: "pcs" }))._id, can = (await Unit.findOne({ code: "can" }))._id;
    r = await call("POST", "/product/item", central.t, { code: "ZZ-PTEE", name_kh: "អាវ POS", category_id: (await Category.findOne({ code: "clothing_tops" }))._id, base_unit_id: pcs, variants: [{ barcode: "ZZ88001" }] });
    const TEE = r.json.data.variants[0]._id; const TEEP = r.json.data._id;
    r = await call("POST", "/product/item", central.t, { code: "ZZ-PMILK", name_kh: "ទឹកដោះ POS", category_id: (await Category.findOne({ code: "feeding_formula" }))._id, base_unit_id: can, track_batch: true });
    const MILK = r.json.data.variants[0]._id;
    await call("POST", "/product/price", central.t, { variant_id: TEE, price: 5 });
    await call("POST", "/product/price", central.t, { variant_id: TEE, warehouse_id: S1, price: 4.5 });
    await call("POST", "/product/price", central.t, { variant_id: MILK, price: 20 });
    r = await call("POST", "/stock/opening", central.t, { warehouse_id: S1, items: [{ variant_id: TEE, qty: 10, unit_cost: 2 }, { variant_id: MILK, qty: 3, unit_cost: 12, batch_no: "ZZB1", expiry_date: days(100) }] });
    await call("PUT", "/stock/opening/post/" + r.json.data._id, central.t);

    // ---------- devices (admin) ----------
    r = await call("POST", "/pos/device", shop.t, { warehouse_id: S1, name: "x" });
    check("shop manager cannot add POS devices (403)", r.status === 403, r.status);
    const central0 = (await Warehouse.findOne({ type: "central", deleted: false }))._id;
    r = await call("POST", "/pos/device", central.t, { warehouse_id: central0, name: "x" });
    check("POS only for a shop (400)", r.status === 400, r.status);
    r = await call("POST", "/pos/device", central.t, { warehouse_id: S1, name: "Counter 1" });
    const DID = r.json.data?._id; let code = r.json.data?.pair_code;
    check("central adds a POS → code ZZP1-P1 + 6-digit pairing code", r.status === 201 && r.json.data.code === "ZZP1-P1" && /^\d{6}$/.test(code), JSON.stringify(r.json).slice(0, 200));
    r = await call("GET", "/pos/device?warehouse_id=" + S1, central.t);
    check("list shows it waiting for pairing", r.json.data?.[0]?.pair_code_valid === true && !r.json.data[0].paired && r.json.data[0].key_hash === undefined);

    // ---------- pair ----------
    r = await call("POST", "/pos-device/pair", null, { code: "000000" === code ? "111111" : "000000" });
    check("wrong pairing code → 404", r.status === 404, r.status);
    r = await call("POST", "/pos-device/pair", null, { code, app_version: "0.1.0" });
    const KEYD = r.json.data?.device_key;
    check("pair with the code → device key (once)", r.status === 200 && KEYD && KEYD.startsWith(DID + ".") && r.json.data.warehouse.code === "ZZP1", JSON.stringify(r.json).slice(0, 200));
    r = await call("POST", "/pos-device/pair", null, { code });
    check("the code works only once", r.status === 404, r.status);
    const D = { "x-device-key": KEYD };
    r = await call("GET", "/pos-device/ping", null, null, { "x-device-key": DID + ".wrong" });
    check("wrong device key → 401", r.status === 401, r.status);

    // ---------- pull ----------
    r = await call("GET", "/pos-device/pull", null, null, D);
    const snap = r.json.data || {};
    const tee = (snap.products || []).find((p) => p.code === "ZZ-PTEE");
    const milk = (snap.products || []).find((p) => p.code === "ZZ-PMILK");
    check("pull → shop, setting, rate, payment methods, products", r.status === 200 && snap.warehouse.code === "ZZP1" && snap.setting && snap.rate?.rate > 0 && snap.payment_methods.length > 0 && tee && milk, r.status);
    check("pull: shop price (4.5) and shop stock (10) per variant, barcode", tee.variants[0].prices[String(pcs)] === 4.5 && tee.variants[0].stock === 10 && tee.variants[0].barcode === "ZZ88001", JSON.stringify(tee?.variants?.[0]));
    check("pull: only this shop's staff with a PIN (cashier yes, manager without PIN no)", snap.users.some((u) => u.email === "zz.p.cashier@local.test" && u.pin_hash) && !snap.users.some((u) => u.email === "zz.p.shop@local.test"));
    check("pull: no cost in the snapshot", !/avg_cost|unit_cost|total_value/.test(JSON.stringify(snap)));

    // ---------- push ----------
    const inv = (n, items, extra = {}) => ({ uuid: `zz-uuid-${n}-${Date.now()}`, invoice_no: `ZZP1-P1-2610-0000${n}`, sold_at: new Date().toISOString(), cashier_id: cashier.id, cashier_name: "T U", items, subtotal: 0, total: 0, rate: 4100, payments: [{ code: "cash_usd", type: "cash", currency: "USD", amount: 100, amount_usd: 100 }], paid_usd: 100, ...extra });
    const teeLine = (q) => ({ variant_id: TEE, sku: "ZZ-PTEE", unit_id: pcs, factor: 1, qty: q, price: 4.5, line_total: 4.5 * q });
    const milkLine = (q) => ({ variant_id: MILK, sku: "ZZ-PMILK", unit_id: can, factor: 1, qty: q, price: 20, line_total: 20 * q });
    const I1 = inv(1, [teeLine(2), milkLine(5)], { subtotal: 109, total: 109 });
    r = await call("POST", "/pos-device/push", null, { invoices: [I1] }, D);
    check("push an invoice → accepted", r.status === 200 && r.json.data.accepted.length === 1, JSON.stringify(r.json));
    const tb = await Bal.findOne({ warehouse_id: S1, variant_id: TEE }); const mb = await Bal.findOne({ warehouse_id: S1, variant_id: MILK });
    check("stock out: tee 10 → 8, milk 3 → −2 (shop may go negative)", tb.qty === 8 && mb.qty === -2, `${tb.qty} ${mb.qty}`);
    const bb = await BBal.findOne({ warehouse_id: S1, variant_id: MILK });
    check("batch FEFO: the 3 in batch ZZB1 taken first", bb.qty === 0, bb?.qty);
    const sale = await Sale.findOne({ uuid: I1.uuid });
    check("sale saved with cost (2×2 + 5×12 = 64)", sale && Math.abs(sale.cost_total - 64) < 0.001 && sale.items[0].unit_cost === 2, sale?.cost_total);
    const mv = await Movement.find({ ref_id: sale._id });
    check("ledger rows: sale_out, ref invoice", mv.length === 3 && mv.every((m) => m.type === "sale_out" && m.ref_type === "invoice"), mv.length);
    r = await call("POST", "/pos-device/push", null, { invoices: [I1] }, D);
    check("same invoice again → duplicate, stock not taken twice", r.json.data.duplicate.length === 1 && (await Bal.findOne({ warehouse_id: S1, variant_id: TEE })).qty === 8);
    r = await call("POST", "/pos-device/push", null, { invoices: [{ ...inv(2, [teeLine(1)]), invoice_no: "OTHER-2610-1" }, inv(3, [{ ...teeLine(1), variant_id: new mongoose.Types.ObjectId() }])] }, D);
    check("bad prefix / unknown item → failed, nothing saved", r.json.data.failed.length === 2 && (await Sale.countDocuments({ device_id: DID })) === 1, JSON.stringify(r.json.data));
    r = await call("GET", "/pos/sale?warehouse_id=" + S1, central.t);
    check("admin sees the sale", r.status === 200 && r.json.data.length === 1 && r.json.data[0].invoice_no === I1.invoice_no);

    // ---------- Telegram: a chat for this test shop that wants every POS event (not sent: fake bot) ----------
    const TG = M("telegram/telegram.model");
    const tgBot = new mongoose.Types.ObjectId(), tgChat = new mongoose.Types.ObjectId();
    await TG.TelegramBotModel.collection.insertOne({ _id: tgBot, name: "ZZ POS bot", username: "zz_pos_bot", token_enc: "v1:zz", token_hint: "x", status: true, deleted: false });
    await TG.TelegramChatModel.collection.insertOne({ _id: tgChat, bot_id: tgBot, chat_id: "-100zzpos", title: "ZZ POS chat", language: "en", warehouse_ids: [new mongoose.Types.ObjectId(S1)], event_codes: ["pos_sale", "invoice_void", "shift_open", "shift_close", "pos_login"], status: true, deleted: false });

    // ---------- sales screens: list, report, invoice, shifts ----------
    const I4 = inv(4, [teeLine(1)], { subtotal: 4.5, discount_total: 0.5, total: 4, discount_by_name: "ZZ Manager", shift_no: "ZZP1-P1-S261002-1", payments: [{ code: "cash_khr", name_en: "Cash KHR", type: "cash", currency: "KHR", amount: 20500, amount_usd: 5 }], paid_usd: 5, change_usd: 1, change_give_usd: 0, change_give_khr: 4100 });
    const sh = { shift_no: "ZZP1-P1-S261002-1", state: "open", opened_by: cashier.id, opened_by_name: "T U", opened_at: new Date().toISOString(), opening_usd: 20, opening_khr: 40000 };
    r = await call("POST", "/pos-device/push", null, { invoices: [I4], shifts: [sh] }, D);
    check("push: invoice + open shift", r.json.data?.accepted.length === 1 && r.json.data.shifts.saved.length === 1, JSON.stringify(r.json.data));
    r = await call("POST", "/pos-device/push", null, { invoices: [], shifts: [{ ...sh, state: "closed", closed_by_name: "T U", closed_at: new Date().toISOString(), counted_usd: 20, counted_khr: 39000, report: { invoice_count: 1, sales_total: 4, expected_usd: 20, expected_khr: 40000, diff_usd: 0, diff_khr: -1000, diff_total_usd: -0.24 } }, { ...sh, shift_no: "OTHER-S1" }] }, D);
    check("push the closing again → same row closed; wrong prefix refused", r.json.data.shifts.saved.length === 1 && r.json.data.shifts.failed.length === 1 && (await PosShift.countDocuments({ device_id: DID })) === 1 && (await PosShift.findOne({ device_id: DID })).state === "closed");
    check("sale keeps who approved + change split", (await Sale.findOne({ uuid: I4.uuid })).discount_by_name === "ZZ Manager" && (await Sale.findOne({ uuid: I4.uuid })).change_give_khr === 4100);

    r = await call("GET", "/sale?warehouse_id=" + S1, central.t);
    check("sales list (today): 2 invoices, totals, cost + profit for central", r.status === 200 && r.json.data.length === 2 && r.json.summary.count === 2 && r.json.summary.total === 113 && r.json.summary.cost_total === 66 && r.json.summary.profit === 47 && r.json.data[0].item_count >= 1 && r.json.data[0].warehouse_id.code === "ZZP1", JSON.stringify(r.json.summary));
    r = await call("GET", "/sale", shop.t);
    check("shop manager: own shop, no cost / profit", r.status === 200 && r.json.summary.count === 2 && r.json.summary.cost_total === undefined && !JSON.stringify(r.json.data).includes("cost_total"), JSON.stringify(r.json).slice(0, 200));
    r = await call("GET", "/sale?warehouse_id=" + central0, shop.t);
    check("shop manager: another warehouse → 403", r.status === 403, r.status);
    r = await call("GET", "/sale", cashier.t);
    check("cashier: no sales screen (403)", r.status === 403, r.status);
    r = await call("GET", `/sale?warehouse_id=${S1}&q=ZZ-PMILK`, central.t);
    const r2_ = await call("GET", `/sale?warehouse_id=${S1}&flag=discount`, central.t);
    check("search by item code / only discounted", r.json.data.length === 1 && r2_.json.data.length === 1 && r2_.json.data[0].invoice_no === I4.invoice_no);
    r = await call("GET", `/sale?warehouse_id=${S1}&from=2020-01-01&to=2020-01-02`, central.t);
    check("another date range → empty", r.json.data.length === 0 && r.json.range.from === "2020-01-01");

    r = await call("GET", "/sale/report?warehouse_id=" + S1, central.t);
    const R = r.json.data || {};
    const khrM = (R.methods || []).find((m) => m.code === "cash_khr");
    check("report: kpi 2 invoices, $113, profit $47, margin", r.status === 200 && R.kpi.count === 2 && R.kpi.total === 113 && R.kpi.profit === 47 && R.kpi.margin > 0 && R.kpi.discount_count === 1, JSON.stringify(R.kpi));
    check("report: by day / shop / cashier / POS, change taken out of KHR cash (5 → 4)", R.by_day.length === 1 && R.by_day[0].count === 2 && R.by_shop[0].warehouse.code === "ZZP1" && R.by_cashier.length === 1 && R.by_device[0].device.code === "ZZP1-P1" && khrM && khrM.net_usd === 4, JSON.stringify(R.methods));
    check("report: top items (tee 3 pcs) and 2 categories", R.top_items.some((i) => i.sku === "ZZ-PTEE" && i.qty === 3 && i.profit !== undefined) && R.categories.length === 2, JSON.stringify(R.top_items).slice(0, 200));
    r = await call("GET", "/sale/report", shop.t);
    check("report for a shop manager: no cost / profit anywhere", r.status === 200 && r.json.data.kpi.count === 2 && !/"(cost|profit|cost_total|margin)"/.test(JSON.stringify(r.json.data)), JSON.stringify(r.json.data.kpi));

    const sid = (await Sale.findOne({ uuid: I4.uuid }))._id;
    r = await call("GET", "/sale/" + sid, central.t);
    check("one invoice: lines with cost, shift, POS, shop", r.status === 200 && r.json.data.items[0].unit_cost === 2 && r.json.data.shift?.state === "closed" && r.json.data.device_id.code === "ZZP1-P1", JSON.stringify(r.json.data).slice(0, 200));
    r = await call("GET", "/sale/" + I4.invoice_no, shop.t);
    check("by invoice no for a shop manager, without cost", r.status === 200 && r.json.data.items[0].unit_cost === undefined && r.json.data.profit === undefined);
    r = await call("GET", "/sale/shift?flag=diff", shop.t);
    check("shifts: closed with a difference, summary", r.status === 200 && r.json.data.length === 1 && r.json.data[0].report.diff_khr === -1000 && r.json.summary.short === 1, JSON.stringify(r.json).slice(0, 300));
    r = await call("GET", "/sale/filters", shop.t);
    check("filters: own shop, its POS, cashiers, payment methods", r.status === 200 && r.json.data.shops.length === 1 && r.json.data.devices.length === 1 && r.json.data.cashiers.length === 1 && r.json.data.methods.length === 2 && r.json.data.cost === false, JSON.stringify(r.json.data).slice(0, 300));

    // ---------- refund pushed by the POS: stock back into the same batch, cost of the sale ----------
    const rfd = (n, items, extra = {}) => ({ uuid: `zz-rf-${n}-${Date.now()}`, refund_no: `ZZP1-P1-R2610-0000${n}`, sale_uuid: I1.uuid, invoice_no: I1.invoice_no, refunded_at: new Date().toISOString(), reason: "test", approved_by_name: "ZZ Manager", items, total: items.reduce((t, i) => t + i.amount, 0), rate: 4100, payments: [{ code: "cash_usd", type: "cash", currency: "USD", amount: 80, amount_usd: 80 }], ...extra });
    r = await call("POST", "/pos-device/push", null, { invoices: [], refunds: [rfd(1, [{ index: 1, variant_id: MILK, qty: 4, amount: 80 }])] }, D);
    const bbAfter = await BBal.findOne({ warehouse_id: S1, variant_id: MILK });
    const mAfter = await Bal.findOne({ warehouse_id: S1, variant_id: MILK });
    check("refund 4 milk → accepted; batch ZZB1 gets its 3 back first, total −2 → 2", r.json.data?.refunds?.accepted.length === 1 && bbAfter.qty === 3 && mAfter.qty === 2, JSON.stringify(r.json.data?.refunds) + ` batch ${bbAfter?.qty} total ${mAfter?.qty}`);
    const sAfter = await Sale.findOne({ uuid: I1.uuid });
    check("invoice: refunded_qty 4 of 5 milk, partial, $80", sAfter.items[1].refunded_qty === 4 && sAfter.refund_status === "partial" && sAfter.refunded_total === 80);
    r = await call("POST", "/pos-device/push", null, { invoices: [], refunds: [rfd(2, [{ index: 1, variant_id: MILK, qty: 2, amount: 40 }])] }, D);
    check("refund more than left (2 > 1) → failed", r.json.data.refunds.failed.length === 1, JSON.stringify(r.json.data.refunds));
    r = await call("GET", "/sale/report?warehouse_id=" + S1, central.t);
    check("report: refund $80, net = sales − 80, profit loses the margin of the goods back", r.json.data.kpi.refund_total === 80 && r.json.data.kpi.net_total === r2(r.json.data.kpi.total - 80) && r.json.data.kpi.profit === r2(47 - (80 - 48)), JSON.stringify(r.json.data.kpi));
    r = await call("GET", "/sale/" + I1.invoice_no, shop.t);
    check("invoice detail lists its refund (no cost for a shop manager)", r.json.data.refunds.length === 1 && r.json.data.refunds[0].cost_total === undefined && r.json.data.refunds[0].items[0].unit_cost === undefined);
    r = await call("GET", `/sale?warehouse_id=${S1}&flag=refunded`, central.t);
    check("invoices with a refund (filter)", r.json.data.length === 1 && r.json.data[0].refunded_total === 80);

    // ---------- login / logout (attendance) + Telegram ----------
    const PosAtt = M("pos/pos.model").PosAttendanceModel;
    const ev = { uuid: "zz-ev-" + Date.now(), user_id: cashier.id, name: "T U", action: "login", at: new Date().toISOString() };
    r = await call("POST", "/pos-device/push", null, { invoices: [], events: [ev, { ...ev }] }, D);
    check("login event saved once (attendance)", r.json.data.events.saved.length === 2 && (await PosAtt.countDocuments({ uuid: ev.uuid })) === 1);
    await new Promise((x) => setTimeout(x, 1500));
    const msgs = await TG.TelegramMessageModel.find({ chat_ref: tgChat }).lean();
    const codes = [...new Set(msgs.map((m) => m.code))].sort();
    check("Telegram queued: new sale, void/refund, shift open + close, login", ["invoice_void", "pos_login", "pos_sale", "shift_close", "shift_open"].every((c) => codes.includes(c)), codes.join(","));
    check("message text: sale has items + payment, shift close has the cash difference", /ZZP1/.test(msgs.find((m) => m.code === "pos_sale")?.text || "") && /−\$0\.24|-\$0.24|−\$0\.00|🔻/.test(msgs.find((m) => m.code === "shift_close")?.text || ""), (msgs.find((m) => m.code === "shift_close")?.text || "").slice(0, 200));
    r = await call("GET", `/telegram/report/preview?code=daily_sales&warehouse_ids=${S1}&language=en`, admin.t);
    check("daily sales report (ZZP1: sales, refunds, net, payments, top items)", r.status === 200 && /ZZP1/.test(JSON.stringify(r.json.data)) && /refund|net/i.test(JSON.stringify(r.json.data)), JSON.stringify(r.json).slice(0, 300));
    r = await call("GET", `/telegram/report/preview?code=attendance&warehouse_ids=${S1}&language=en`, admin.t);
    check("attendance report: T U in", r.status === 200 && /T U/.test(JSON.stringify(r.json.data)), JSON.stringify(r.json).slice(0, 300));
    await TG.TelegramMessageModel.deleteMany({ chat_ref: tgChat }); await TG.TelegramChatModel.deleteMany({ _id: tgChat }); await TG.TelegramBotModel.deleteMany({ _id: tgBot });

    // ---------- dashboards: today's sales ----------
    r = await call("GET", "/shop/summary?warehouse_id=" + S1, shop.t);
    const sd = r.json.data?.sales; if (!sd) console.log("DBG", JSON.stringify(r.json).slice(0, 400));
    check("shop portal: today 2 invoices $113, refunds $80, net $33, POS online, no profit for a shop manager", r.status === 200 && sd.today.count === 2 && sd.today.total === 113 && sd.today.refund_total === 80 && sd.today.net_total === 33 && sd.pos.devices === 1 && sd.pos.online === 1 && sd.today.profit === undefined && sd.days.length === 7 && sd.top_items.length >= 1, JSON.stringify(sd).slice(0, 300));
    r = await call("GET", "/shop/summary?warehouse_id=" + S1, central.t);
    check("central sees the profit of today", typeof r.json.data.sales.today.profit === "number", JSON.stringify(r.json.data.sales.today));
    r = await call("GET", "/dashboard/summary", central.t);
    check("admin home: sales block (all shops)", r.status === 200 && r.json.data.sales.today.count >= 2 && r.json.data.sales.days.length === 7, JSON.stringify(r.json.data.sales?.today));

    // ---------- off / new code ----------
    await call("PUT", "/pos/device/" + DID, central.t, { status: false });
    r = await call("GET", "/pos-device/ping", null, null, D);
    check("POS turned off → 403", r.status === 403, r.status);
    await call("PUT", "/pos/device/" + DID, central.t, { status: true });
    r = await call("PUT", "/pos/device/pair-code/" + DID, central.t);
    check("new pairing code → old key stops (401)", /^\d{6}$/.test(r.json.data?.pair_code) && (await call("GET", "/pos-device/ping", null, null, D)).status === 401);
  } catch (e) { console.log("ERR", e); } finally {
    const ws = await Warehouse.find({ code: /^ZZP/ }).select("_id"); const w = ws.map((x) => x._id);
    const ps = await Product.find({ code: /^ZZ-P/ }).select("_id"); const p = ps.map((x) => x._id);
    await Sale.deleteMany({ warehouse_id: { $in: w } }); await PosShift.deleteMany({ warehouse_id: { $in: w } }); await Refund.deleteMany({ warehouse_id: { $in: w } }); await M("pos/pos.model").PosAttendanceModel.deleteMany({ warehouse_id: { $in: w } }); await Device.deleteMany({ warehouse_id: { $in: w } });
    await Price.deleteMany({ product_id: { $in: p } }); await Batch.deleteMany({ product_id: { $in: p } });
    await Movement.deleteMany({ warehouse_id: { $in: w } }); await Bal.deleteMany({ warehouse_id: { $in: w } }); await BBal.deleteMany({ warehouse_id: { $in: w } }); await Opening.deleteMany({ warehouse_id: { $in: w } });
    await Variant.deleteMany({ product_id: { $in: p } }); await Product.deleteMany({ _id: { $in: p } }); await Warehouse.deleteMany({ _id: { $in: w } });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    await Counter.deleteMany({ key: { $nin: counters.map((c) => c.key) } });
    for (const c of counters) await Counter.updateOne({ _id: c._id }, { seq: c.seq });
    const left = (await Warehouse.countDocuments({ code: /^ZZP/ })) + (await Product.countDocuments({ code: /^ZZ-P/ })) + (await User.countDocuments({ email: /^zz\.p\./ })) + (await Sale.countDocuments({ invoice_no: /^ZZP/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
