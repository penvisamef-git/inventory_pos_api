// Integration test against the test database (UAT) — run all with: npm test
// Customers + loyalty points + promotions: admin CRUD, POS pull, push (customer made offline, points earn / redeem, refund), promotion rules
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const M = (p) => require(API + "/src/v1/admin/" + p);
const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model");
const Unit = M("product/unit/unit.model"), Category = M("product/category/category.model");
const Product = M("product/item/product.model"), Variant = M("product/item/variant.model"), Price = M("product/price/price.model");
const Warehouse = M("setup/warehouse/warehouse.model"), Movement = M("stock/movement.model"), Opening = M("stock/opening/opening.model");
const { StockBalanceModel: Bal, StockBatchBalanceModel: BBal } = M("stock/balance.model"); const Counter = M("counter/counter.model");
const { PosDeviceModel: Device, SaleModel: Sale, RefundModel: Refund } = M("pos/pos.model");
const { CustomerModel: Cust, CustomerPointModel: Pts } = M("customer/customer.model");
const Promo = M("promotion/promotion.model");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const counters = await Counter.find({}).lean();
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b, extra = {}) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}), ...extra }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "C", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return { id, t: (await call("POST", "/auth/login", null, { email, password: PASS })).json.data?.access_token }; };
  try {
    const admin = await mk("zz.c.admin@local.test", { is_super_admin: true });
    const central = await mk("zz.c.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    let r = await call("POST", "/setup/warehouse", admin.t, { code: "ZZC1", name_kh: "ហាង អតិថិជន តេស្ត", type: "shop" }); const S1 = r.json.data._id;
    const shop = await mk("zz.c.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [S1] });
    const pcs = (await Unit.findOne({ code: "pcs" }))._id;
    r = await call("POST", "/product/item", central.t, { code: "ZZ-CTEE", name_kh: "អាវ តេស្ត", category_id: (await Category.findOne({ code: "clothing_tops" }))._id, base_unit_id: pcs, variants: [{ barcode: "ZZ77001" }] });
    const TEE = r.json.data.variants[0]._id; const TEEP = r.json.data._id;
    await call("POST", "/product/price", central.t, { variant_id: TEE, price: 10 });

    // ---------- customers (admin) ----------
    r = await call("POST", "/customer", shop.t, { name: "ZZ Mom", phone: "+855 12 000 111", kid_name: "Baby", kid_birthday: "2024-10-20" });
    const C1 = r.json.data?._id;
    check("shop manager adds a customer → phone cleaned to 012000111, code C…", r.status === 201 && r.json.data.phone === "012000111" && /^C\d{6}$/.test(r.json.data.code) && String(r.json.data.warehouse_id) === String(S1), JSON.stringify(r.json).slice(0, 200));
    r = await call("POST", "/customer", shop.t, { name: "ZZ Dup", phone: "012-000-111" });
    check("same phone again → 409", r.status === 409, r.status);
    r = await call("POST", "/customer", shop.t, { name: "", phone: "0" });
    check("no name / bad phone → 400", r.status === 400, r.status);
    r = await call("GET", "/customer?q=000111", shop.t);
    check("search by phone digits", r.json.data?.length === 1 && r.json.data[0].name === "ZZ Mom", JSON.stringify(r.json).slice(0, 200));
    r = await call("POST", `/customer/${C1}/points`, shop.t, { points: 50, note: "x" });
    check("shop manager cannot change points (403)", r.status === 403, r.status);
    r = await call("POST", `/customer/${C1}/points`, central.t, { points: 500, note: "welcome gift" });
    check("central adds 500 points", r.status === 200 && r.json.data.points === 500, JSON.stringify(r.json));
    r = await call("POST", `/customer/${C1}/points`, central.t, { points: -9999, note: "x" });
    check("more than the balance → 400", r.status === 400, r.status);

    // ---------- promotions (admin) ----------
    r = await call("POST", "/promotion", shop.t, { name_kh: "x", type: "percent", value: 10 });
    check("shop manager cannot add promotions (403)", r.status === 403, r.status);
    r = await call("POST", "/promotion", central.t, { name_kh: "ZZ ទិញ2ថែម1", type: "buy_x_get_y", buy_qty: 2, get_qty: 1, scope: "product", product_ids: [TEEP], warehouse_ids: [S1] });
    const PR1 = r.json.data?._id;
    check("central adds buy 2 get 1 → code PR…", r.status === 201 && /^PR\d{4}$/.test(r.json.data.code), JSON.stringify(r.json).slice(0, 200));
    r = await call("POST", "/promotion", central.t, { name_kh: "ZZ bad", type: "percent", value: 120 });
    check("120% → 400", r.status === 400, r.status);
    r = await call("POST", "/promotion", central.t, { name_kh: "ZZ bad2", type: "percent", value: 10, scope: "brand" });
    check("brand scope without brands → 400", r.status === 400, r.status);
    r = await call("POST", "/promotion", central.t, { name_kh: "ZZ ended", type: "bill_percent", value: 5, end_at: "2020-01-01T00:00:00Z" });
    const PR_OLD = r.json.data?._id;

    // ---------- POS: pull ----------
    r = await call("POST", "/pos/device", central.t, { warehouse_id: S1, name: "C1" });
    const DID = r.json.data._id; const code = r.json.data.pair_code;
    const D = { "x-device-key": (await call("POST", "/pos-device/pair", null, { code })).json.data.device_key };
    r = await call("GET", "/pos-device/pull", null, null, D);
    const snap = r.json.data || {};
    const mine = (snap.customers || []).find((c) => String(c._id) === String(C1));
    check("pull: customers with points + loyalty setting", mine && mine.points === 500 && snap.setting.points_per_usd >= 0 && snap.setting.point_value_usd > 0, JSON.stringify(mine));
    check("pull: promotions not ended (buy 2 get 1 yes, ended no)", (snap.promotions || []).some((p) => String(p._id) === String(PR1)) && !(snap.promotions || []).some((p) => String(p._id) === String(PR_OLD)));
    const PPU = snap.setting.points_per_usd;

    // ---------- POS: push a customer made offline + an invoice with points used + promotion ----------
    const cu = `zz-cust-${Date.now()}`;
    const inv = (n, extra) => ({ uuid: `zz-cinv-${n}-${Date.now()}`, invoice_no: `ZZC1-P1-2610-0000${n}`, sold_at: new Date().toISOString(), cashier_name: "T C", items: [{ variant_id: TEE, sku: "ZZ-CTEE", unit_id: pcs, factor: 1, qty: 3, price: 10, discount: 10, promo_discount: 10, line_total: 20 }], subtotal: 30, promo_total: 10, promotions: [{ promo_id: PR1, code: "PR", name_kh: "ZZ ទិញ2ថែម1", amount: 10 }], total: 20, rate: 4100, ...extra });
    const I1 = inv(1, { customer_uuid: cu, payments: [{ code: "cash_usd", type: "cash", currency: "USD", amount: 20, amount_usd: 20 }], paid_usd: 20, points_earned: 20 * PPU });
    r = await call("POST", "/pos-device/push", null, { customers: [{ uuid: cu, name: "ZZ Dad", phone: "012 000 222", kid_name: "Kid" }], invoices: [I1] }, D);
    const newC = r.json.data?.customers?.saved?.[0];
    check("push: new customer saved + invoice accepted", r.status === 200 && newC && r.json.data.accepted.length === 1, JSON.stringify(r.json.data).slice(0, 300));
    check("points of that customer back in the answer (earned 20 × rate)", r.json.data.customer_points[String(newC._id)] === Math.floor(20 * PPU), JSON.stringify(r.json.data.customer_points));
    const s1 = await Sale.findOne({ uuid: I1.uuid }).lean();
    check("sale keeps customer + promotions", String(s1.customer_id) === String(newC._id) && s1.customer_name === "ZZ Dad" && s1.promo_total === 10 && s1.promotions.length === 1 && s1.items[0].promo_discount === 10);
    r = await call("POST", "/pos-device/push", null, { customers: [{ uuid: cu, name: "ZZ Dad", phone: "012000222" }] }, D);
    check("same customer again → same id (no duplicate)", String(r.json.data.customers.saved[0]._id) === String(newC._id) && (await Cust.countDocuments({ phone: "012000222" })) === 1);
    r = await call("POST", "/pos-device/push", null, { customers: [{ uuid: `zz-other-${Date.now()}`, name: "ZZ Mom 2", phone: "012000111" }] }, D);
    check("another POS added the same phone offline → merged into the existing customer", r.json.data.customers.saved[0].merged === true && String(r.json.data.customers.saved[0]._id) === String(C1));

    // pays $2 with 200 points ($0.01 each), $18 cash → earns on $18
    const pv = snap.setting.point_value_usd; const usedPts = 200; const usd = Math.round(usedPts * pv * 100) / 100;
    const I2 = inv(2, { customer_id: C1, points_redeemed: usedPts, payments: [{ code: "points", name_en: "Points", type: "points", currency: "USD", amount: usd, amount_usd: usd }, { code: "cash_usd", type: "cash", currency: "USD", amount: 20 - usd, amount_usd: 20 - usd }], paid_usd: 20 });
    r = await call("POST", "/pos-device/push", null, { invoices: [I2] }, D);
    const want = 500 - usedPts + Math.floor((20 - usd) * PPU);
    check(`points used + earned → ${want}`, r.json.data.accepted.length === 1 && r.json.data.customer_points[String(C1)] === want, JSON.stringify(r.json.data).slice(0, 300));
    const led = await Pts.find({ customer_id: C1 }).sort({ at: 1 }).lean();
    check("ledger: adjust, redeem, earn (balance after each)", led.map((l) => l.type).join(",") === "adjust,redeem,earn" && led[led.length - 1].balance === want, led.map((l) => `${l.type}${l.points}=${l.balance}`).join(" "));
    const cust = await Cust.findById(C1).lean();
    check("customer: total spent $20, 1 visit", cust.total_spent === 20 && cust.visits === 1, JSON.stringify({ s: cust.total_spent, v: cust.visits }));

    // full void → earned taken back, used points given back
    const s2 = await Sale.findOne({ uuid: I2.uuid }).lean();
    r = await call("POST", "/pos-device/push", null, { invoices: [], refunds: [{ uuid: `zz-crf-${Date.now()}`, refund_no: "ZZC1-P1-R2610-00001", kind: "void", sale_uuid: I2.uuid, invoice_no: I2.invoice_no, refunded_at: new Date().toISOString(), reason: "test", items: [{ index: 0, variant_id: TEE, sku: "ZZ-CTEE", qty: 3, amount: 20 }], total: 20 - usd, points_back: usedPts, points_back_usd: usd, rate: 4100, payments: [{ code: "cash_usd", type: "cash", currency: "USD", amount: 20 - usd }] }] }, D);
    check("void → back to 500 points, spent 0", r.json.data.refunds.accepted.length === 1 && r.json.data.customer_points[String(C1)] === 500 && (await Cust.findById(C1).lean()).total_spent === 0, JSON.stringify(r.json.data).slice(0, 300) + " earned " + s2.points_earned);

    r = await call("GET", `/customer/${C1}`, shop.t);
    check("customer page: invoices + point history", r.status === 200 && r.json.data.sales.length === 1 && r.json.data.point_history.length >= 4, JSON.stringify(r.json.data).slice(0, 200));
    r = await call("GET", "/customer?birthday_month=10&q=ZZ", shop.t);
    check("birthdays in October", r.json.data.some((c) => c.name === "ZZ Mom"), JSON.stringify(r.json.data.map((c) => c.name)));
  } catch (e) { console.log("ERR", e); results.push(false); } finally {
    const ws = (await Warehouse.find({ code: /^ZZC/ }).select("_id")).map((x) => x._id);
    const ps = (await Product.find({ code: /^ZZ-C/ }).select("_id")).map((x) => x._id);
    const cs = (await Cust.find({ name: /^ZZ / }).select("_id")).map((x) => x._id);
    await Sale.deleteMany({ warehouse_id: { $in: ws } }); await Refund.deleteMany({ warehouse_id: { $in: ws } }); await Device.deleteMany({ warehouse_id: { $in: ws } });
    await Pts.deleteMany({ customer_id: { $in: cs } }); await Cust.deleteMany({ _id: { $in: cs } }); await Promo.deleteMany({ name_kh: /^ZZ/ });
    await Price.deleteMany({ product_id: { $in: ps } }); await Movement.deleteMany({ warehouse_id: { $in: ws } }); await Bal.deleteMany({ warehouse_id: { $in: ws } }); await BBal.deleteMany({ warehouse_id: { $in: ws } }); await Opening.deleteMany({ warehouse_id: { $in: ws } });
    await Variant.deleteMany({ product_id: { $in: ps } }); await Product.deleteMany({ _id: { $in: ps } }); await Warehouse.deleteMany({ _id: { $in: ws } });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    await Counter.deleteMany({ key: { $nin: counters.map((c) => c.key) } });
    for (const c of counters) await Counter.updateOne({ _id: c._id }, { seq: c.seq });
    const left = (await Warehouse.countDocuments({ code: /^ZZC/ })) + (await Cust.countDocuments({ name: /^ZZ / })) + (await Promo.countDocuments({ name_kh: /^ZZ/ })) + (await User.countDocuments({ email: /^zz\.c\./ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
