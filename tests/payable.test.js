// Integration test against the test database (UAT) — run all with: npm test
// Supplier debts: posted goods receives − payments, oldest bill paid first, overdue by payment terms, roles, void
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const M = (p) => require(API + "/src/v1/admin/" + p);
const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model"), Counter = M("counter/counter.model");
const Supplier = M("purchase/supplier/supplier.model"), GR = M("stock/receive/receive.model"), Pay = M("purchase/payable/supplier_payment.model");
const Warehouse = M("setup/warehouse/warehouse.model");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const DAY = 86400000;
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const counters = await Counter.find({}).lean();
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "P", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return { id, t: (await call("POST", "/auth/login", null, { email, password: PASS })).json.data?.access_token }; };
  let sup;
  try {
    const admin = await mk("zz.p.admin@local.test", { is_super_admin: true });
    const acc = await mk("zz.p.acc@local.test", { role: ROLES.ACCOUNTANT.value });
    const wh = await Warehouse.findOne({ type: "central", deleted: false }).lean();
    const shop = await mk("zz.p.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [] });
    sup = await Supplier.create({ code: "zz_sup", name: "ZZ Supplier", payment_term_days: 30, created_by: admin.id, updated_by: admin.id });
    const now = Date.now();
    const gr = (no, days, cost, state = "posted") => GR.create({ doc_no: no, doc_date: new Date(now - days * DAY), warehouse_id: wh._id, supplier_id: sup._id, items: [], total_cost: cost, posted_cost: state === "posted" ? cost : null, state, posted_at: state === "posted" ? new Date(now - days * DAY) : null, created_by: admin.id, updated_by: admin.id });
    await gr("ZZGR-1", 45, 100); await gr("ZZGR-2", 10, 250); await gr("ZZGR-3", 2, 999, "draft");

    let r = await call("GET", "/purchase/payable?q=ZZ Supplier", acc.t);
    const row = r.json.data?.find((x) => x.supplier.code === "zz_sup");
    check("accountant sees: owed 350 (draft not counted), 100 overdue (45 days > 30)", r.status === 200 && row?.billed === 350 && row.balance === 350 && row.overdue === 100 && row.open_bills === 2 && row.max_days_late === 15, JSON.stringify(row));
    r = await call("GET", "/purchase/payable", shop.t);
    check("shop manager can't see supplier debts", r.status === 403, r.status);
    r = await call("POST", "/purchase/payable/payment", acc.t, { supplier_id: sup._id, amount: 400 });
    check("pay more than owed → 400", r.status === 400, r.status);
    r = await call("POST", "/purchase/payable/payment", acc.t, { supplier_id: sup._id, amount: 0 });
    check("pay 0 → 400", r.status === 400, r.status);
    r = await call("POST", "/purchase/payable/payment", acc.t, { supplier_id: sup._id, amount: 130, method: "bank", reference: "ABA 123" });
    const p1 = r.json.data;
    check("pay 130 → SP-yymm-nnnn", r.status === 201 && /^SP-\d{4}-\d{4}$/.test(p1?.doc_no), JSON.stringify(r.json).slice(0, 200));
    r = await call("GET", `/purchase/payable/${sup._id}`, acc.t);
    const d = r.json.data; const b1 = d?.bills.find((x) => x.doc_no === "ZZGR-1"), b2 = d?.bills.find((x) => x.doc_no === "ZZGR-2");
    check("oldest bill paid first: GR-1 done, GR-2 due 220, nothing overdue", d?.balance === 220 && d.overdue === 0 && b1.due === 0 && !b1.overdue && b2.paid === 30 && b2.due === 220 && d.payments.length === 1, JSON.stringify(d).slice(0, 400));
    r = await call("PUT", `/purchase/payable/payment/${p1._id}/void`, acc.t, { reason: "x" });
    check("accountant can't void a payment", r.status === 403, r.status);
    r = await call("PUT", `/purchase/payable/payment/${p1._id}/void`, admin.t, {});
    check("void needs a reason", r.status === 400, r.status);
    r = await call("PUT", `/purchase/payable/payment/${p1._id}/void`, admin.t, { reason: "wrong supplier" });
    check("admin voids → owed back to 350", r.status === 200 && (await call("GET", `/purchase/payable/${sup._id}`, acc.t)).json.data.balance === 350, r.status);
    r = await call("GET", "/purchase/payable?open=1", acc.t);
    check("open=1 lists the supplier, totals add up", r.json.data.some((x) => x.supplier.code === "zz_sup") && r.json.totals.balance >= 350, JSON.stringify(r.json.totals));
  } catch (e) { console.log("ERR", e); results.push(false); } finally {
    await GR.deleteMany({ doc_no: /^ZZGR-/ }); if (sup) await Pay.deleteMany({ supplier_id: sup._id }); await Supplier.deleteMany({ code: "zz_sup" });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    await Counter.deleteMany({ key: { $nin: counters.map((c) => c.key) } });
    for (const c of counters) await Counter.updateOne({ _id: c._id }, { seq: c.seq });
    const left = (await GR.countDocuments({ doc_no: /^ZZGR-/ })) + (await Supplier.countDocuments({ code: "zz_sup" })) + (await User.countDocuments({ email: /^zz\.p\./ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
