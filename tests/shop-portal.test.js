// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test");
const mongoose = require(API + "/node_modules/mongoose");
const app = require(API + "/index.js");
const User = require(API + "/src/v1/admin/user/user.model"); const Session = require(API + "/src/v1/admin/session/session.model");
const ActivityLog = require(API + "/src/v1/admin/activity_log/activity_log.model");
const W = require(API + "/src/v1/admin/setup/warehouse/warehouse.model");
const results = []; const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const login = async (email) => (await call("POST", "/auth/login", null, { email, password: "Sample@2026" })).json.data.access_token;
  const made = [];
  try {
    const m1 = await login("manager.pp01@inventorypos.test"); const central = await login("central@inventorypos.test");
    const acc = await login("accountant@inventorypos.test");
    const ws = Object.fromEntries((await W.find({ code: { $in: ["WH01", "PP01", "PP02"] } }).lean()).map((w) => [w.code, String(w._id)]));
    let r = await call("GET", `/shop/summary?warehouse_id=${ws.PP01}`, m1);
    check("manager summary own shop → stock, transfers, staff, no value", r.status === 200 && r.json.data.stock.skus > 0 && r.json.data.staff.cashiers >= 1 && r.json.data.stock.value === undefined, JSON.stringify(r.json).slice(0, 300));
    console.log("   ", JSON.stringify({ stock: r.json.data?.stock, expiry: r.json.data?.expiry, transfers: r.json.data?.transfers, adj: r.json.data?.adjustments, staff: r.json.data?.staff }));
    r = await call("GET", `/shop/summary?warehouse_id=${ws.PP02}`, m1);
    check("manager summary other shop → 403", r.status === 403, r.status);
    r = await call("GET", `/shop/summary?warehouse_id=${ws.WH01}`, central);
    check("central summary WH01 → 200 with value", r.status === 200 && r.json.data.stock.value > 0, JSON.stringify(r.json.data?.stock));
    r = await call("GET", `/shop/summary?warehouse_id=${ws.PP01}`, acc);
    check("accountant portal → 403", r.status === 403, r.status);
    r = await call("GET", `/shop/staff?warehouse_id=${ws.PP01}`, m1);
    check("staff list PP01 → manager + cashier", r.status === 200 && r.json.data.length >= 2, r.json.data?.length);
    r = await call("POST", "/shop/staff", m1, { warehouse_id: ws.PP01, firstname: "Test", lastname: "Cashier", email: "zz.cashier@local.test", password: "Pass12345", pos_pin: "5678" });
    const cid = r.json.data?._id; if (cid) made.push(cid);
    check("manager creates cashier with PIN → role cashier, PP01", r.status === 201 && r.json.data.role === "អ្នកគិតលុយ" && r.json.data.has_pos_pin && r.json.data.warehouse_ids[0].code === "PP01", JSON.stringify(r.json).slice(0, 200));
    r = await call("POST", "/shop/staff", m1, { warehouse_id: ws.PP02, firstname: "x", lastname: "y", email: "zz.c2@local.test", password: "Pass12345" });
    check("manager creates cashier in other shop → 403", r.status === 403, r.status);
    r = await call("POST", "/shop/staff", central, { warehouse_id: ws.WH01, firstname: "x", lastname: "y", email: "zz.c3@local.test", password: "Pass12345" });
    check("cashier at central warehouse → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/shop/staff/" + cid, m1, { status: false, contact: "099" });
    check("disable own cashier → 200", r.status === 200 && r.json.data.status === false, r.json.message);
    r = await call("PUT", "/shop/staff/pos-pin/" + cid, m1, { pos_pin: "12" });
    check("bad PIN → 400", r.status === 400, r.status);
    r = await call("PUT", "/shop/staff/reset-password/" + cid, m1, { password: "NewPass123" });
    check("reset password → 200", r.status === 200, r.json.message);
    const m2 = await login("manager.pp02@inventorypos.test");
    r = await call("PUT", "/shop/staff/" + cid, m2, { status: true });
    check("other shop manager edits cashier → 403", r.status === 403, r.status);
    const mgr2 = await User.findOne({ email: "manager.pp02@inventorypos.test" });
    r = await call("PUT", "/shop/staff/" + mgr2._id, central, { status: false });
    check("portal cannot edit a manager (cashiers only) → 403", r.status === 403, r.status);
    r = await call("GET", `/stock/balance?warehouse_id=${ws.PP02}&with_price=true&q=DIAPANT01-M`, central);
    check("balance with_price PP02 → shop price 13.9 for DIAPANT01-M", r.json.data?.[0]?.price === 13.9 && r.json.data[0].price_source === "shop", JSON.stringify(r.json.data?.[0] && { p: r.json.data[0].price, s: r.json.data[0].price_source }));
  } catch (e) { console.error("ERROR", e); results.push(false); }
  finally {
    const zz = await User.find({ email: /@local\.test$/ }).select("_id"); const ids = [...made, ...zz.map((u) => u._id)];
    await ActivityLog.deleteMany({ title: /Test Cashier|អ្នកគិតលុយ Test/ }); await User.deleteMany({ _id: { $in: ids } }); await Session.deleteMany({ user_id: { $in: ids } });
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test users left: ${await User.countDocuments({ email: /@local\.test$/ })}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
