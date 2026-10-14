// Integration test against the test database (UAT) — run all with: npm test
// Profit report (by product / variant / brand / category / supplier) and slow / dead stock: shape, sums, who can see cost
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const M = (p) => require(API + "/src/v1/admin/" + p);
const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model");
const Warehouse = M("setup/warehouse/warehouse.model");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const near = (a, b) => Math.abs(a - b) < 0.05;
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, ...(t ? { Authorization: "Bearer " + t } : {}) } }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "R", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return { id, t: (await fetch(base + "/auth/login", { method: "POST", headers: { "x-api-key": KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASS }) }).then((r) => r.json())).data?.access_token }; };
  const { SaleModel: Sale, RefundModel: Refund } = M("pos/pos.model");
  const Supplier = M("purchase/supplier/supplier.model"), GR = M("stock/receive/receive.model"), Variant = M("product/item/variant.model");
  try {
    const admin = await mk("zz.r.admin@local.test", { is_super_admin: true });
    const shopWh = await Warehouse.findOne({ type: "shop", deleted: false }).lean();
    const shop = await mk("zz.r.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [shopWh._id] });
    // seed: 2 sales of one variant (3 + 1 pcs) and a refund of 1 pc, bought from supplier ZZ
    const v = await Variant.findOne({ deleted: { $ne: true } }).lean();
    const sup = await Supplier.create({ code: "zz_rsup", name: "ZZ R Supplier", created_by: admin.id, updated_by: admin.id });
    const central = await Warehouse.findOne({ type: "central", deleted: false }).lean();
    await GR.collection.insertOne({ doc_no: "ZZGR-R1", doc_date: new Date("2020-01-01"), warehouse_id: central._id, supplier_id: sup._id, items: [{ variant_id: v._id, base_qty: 10 }], total_cost: 20, posted_cost: 20, state: "posted", posted_at: new Date("2020-01-01") });
    const line = (q) => ({ variant_id: v._id, product_id: v.product_id, sku: v.sku, name_kh: "ZZ", name_en: "ZZ", qty: q, base_qty: q, line_total: 5 * q, cost_total: 2 * q });
    const day = new Date("2020-03-03T05:00:00Z");
    await Sale.collection.insertMany([
      { invoice_no: "ZZ-PR-1", uuid: "zz-pr-1", state: "paid", warehouse_id: shopWh._id, sold_at: day, total: 15, items: [line(3)], cost_total: 6 },
      { invoice_no: "ZZ-PR-2", uuid: "zz-pr-2", state: "paid", warehouse_id: shopWh._id, sold_at: day, total: 5, items: [line(1)], cost_total: 2 },
    ]);
    await Refund.collection.insertOne({ refund_no: "ZZ-PR-R1", uuid: "zz-pr-r1", sale_id: new mongoose.Types.ObjectId(), warehouse_id: shopWh._id, refunded_at: day, total: 5, cost_total: 2, items: [{ variant_id: v._id, product_id: v.product_id, sku: v.sku, qty: 1, base_qty: 1, amount: 5, cost_total: 2 }] });
    let x = await call("GET", "/sale/profit?from=2020-03-03&to=2020-03-03&group=supplier", admin.t);
    const sr = x.json.data?.[0];
    check("seeded: by supplier → ZZ R Supplier, 3 pcs net, sales 15, cost 6, profit 9, 2 invoices", x.json.data?.length === 1 && sr.name_en === "ZZ R Supplier" && sr.qty === 3 && sr.returned_qty === 1 && sr.sales === 15 && sr.cost === 6 && sr.profit === 9 && sr.margin === 60 && sr.invoices === 2, JSON.stringify(x.json).slice(0, 300));
    x = await call("GET", "/sale/profit?from=2020-03-03&to=2020-03-03&group=variant", admin.t);
    check("seeded: by variant → that variant", x.json.data?.[0]?.key === String(v._id) && x.json.totals.profit === 9, JSON.stringify(x.json.data?.[0]).slice(0, 200));
    const range = "from=2025-01-01&to=2026-12-31";
    const sums = {};
    for (const g of ["product", "variant", "brand", "category", "supplier"]) {
      const r = await call("GET", `/sale/profit?${range}&group=${g}`, admin.t);
      const rows = r.json.data || [];
      const t = r.json.totals || {};
      sums[g] = t;
      const okRows = rows.every((x) => typeof x.sales === "number" && near(x.profit, x.sales - x.cost) && x.name_kh !== undefined);
      check(`profit by ${g}: ${rows.length} rows, profit = sales − cost`, r.status === 200 && okRows && near(t.profit, t.sales - t.cost) && near(rows.reduce((a, x) => a + x.sales, 0), t.sales), JSON.stringify(t));
    }
    check("every grouping adds up to the same sales and cost", Object.values(sums).every((t) => near(t.sales, sums.product.sales) && near(t.cost, sums.product.cost)), JSON.stringify(sums));
    let r = await call("GET", `/sale/profit?${range}`, shop.t);
    check("shop manager can't see profit (cost)", r.status === 403, r.status);
    r = await call("GET", "/sale/slow-stock?days=30", admin.t);
    check("slow / dead stock list with value", r.status === 200 && Array.isArray(r.json.data) && r.json.summary.days === 30 && r.json.data.every((x) => ["dead", "slow"].includes(x.status) && typeof x.value === "number"), JSON.stringify(r.json.summary));
    r = await call("GET", "/sale/slow-stock?days=30", shop.t);
    check("shop manager sees only own shop, no cost value", r.status === 200 && r.json.data.every((x) => String(x.warehouse?._id) === String(shopWh._id) && x.value === undefined) && r.json.summary.dead_value === undefined, JSON.stringify(r.json.data[0] || {}).slice(0, 200));
  } catch (e) { console.log("ERR", e); results.push(false); } finally {
    await Sale.collection.deleteMany({ invoice_no: /^ZZ-PR-/ }); await Refund.collection.deleteMany({ refund_no: /^ZZ-PR-/ }); await GR.collection.deleteMany({ doc_no: "ZZGR-R1" }); await Supplier.deleteMany({ code: "zz_rsup" });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${await User.countDocuments({ email: /^zz\.r\./ })}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
