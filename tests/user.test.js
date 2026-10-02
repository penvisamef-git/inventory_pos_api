// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test");
const mongoose = require(API + "/node_modules/mongoose");
const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const User = require(API + "/src/v1/admin/user/user.model");
const Session = require(API + "/src/v1/admin/session/session.model");
const Warehouse = require(API + "/src/v1/admin/setup/warehouse/warehouse.model");
const ActivityLog = require(API + "/src/v1/admin/activity_log/activity_log.model");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const login = async (email, password = PASS) => (await call("POST", "/auth/login", null, { email, password })).json;
  const created = []; const adminId = new mongoose.Types.ObjectId(); created.push(adminId);
  try {
    await User.create({ _id: adminId, firstname: "Test", lastname: "Admin", email: "zz.u.admin@local.test", password: await bcrypt.hash(PASS, 10), is_super_admin: true, is_first_login: false, status: true, created_by: adminId, updated_by: adminId });
    const admin = (await login("zz.u.admin@local.test")).data.access_token;
    const pp01 = (await Warehouse.findOne({ code: "PP01", deleted: false }))._id.toString();
    const pp02 = (await Warehouse.findOne({ code: "PP02", deleted: false }))._id.toString();
    const wh01 = (await Warehouse.findOne({ code: "WH01", deleted: false }))._id.toString();

    let r = await call("GET", "/users-roles", admin);
    check("roles → 5 with scope", r.json.data?.length === 5 && r.json.data.every((x) => x.scope && x.label_en), JSON.stringify(r.json).slice(0, 150));
    const base = { firstname: "T", lastname: "U", password: "ChangeMe@2026" };
    r = await call("POST", "/users", admin, { ...base, email: "zz.u.cash1@local.test", role: ROLES.CASHIER.value });
    check("cashier without shop → 400", r.status === 400, r.json.message);
    r = await call("POST", "/users", admin, { ...base, email: "zz.u.cash1@local.test", role: ROLES.CASHIER.value, warehouse_ids: [wh01] });
    check("cashier linked to central warehouse → 400", r.status === 400, r.json.message);
    r = await call("POST", "/users", admin, { ...base, email: "zz.u.cash1@local.test", role: ROLES.CASHIER.value, warehouse_ids: ["65f000000000000000000099"] });
    check("cashier with unknown shop → 400", r.status === 400, r.json.message);
    r = await call("POST", "/users", admin, { ...base, email: "zz.u.cash1@local.test", role: ROLES.CASHIER.value, warehouse_ids: [pp01, pp01] });
    check("cashier PP01 → 201, duplicates removed, populated? no (create)", r.status === 201 && r.json.data.warehouse_ids.length === 1, JSON.stringify(r.json).slice(0, 200));
    const cashId = r.json.data?._id; created.push(cashId);
    check("create response hides password + pos_pin", r.json.data && !("password" in r.json.data) && !("pos_pin" in r.json.data) && r.json.data.has_pos_pin === false, Object.keys(r.json.data || {}).join(","));
    r = await call("POST", "/users", admin, { ...base, email: "zz.u.central@local.test", role: ROLES.CENTRAL_MANAGER.value, warehouse_ids: [pp01] });
    check("central manager → 201 with warehouse_ids stored as []", r.status === 201 && r.json.data.warehouse_ids.length === 0, JSON.stringify(r.json.data?.warehouse_ids));
    created.push(r.json.data?._id);

    r = await call("GET", "/users/" + cashId, admin);
    check("get by id → warehouse populated", r.json.data?.warehouse_ids?.[0]?.code === "PP01", JSON.stringify(r.json.data?.warehouse_ids));
    r = await call("GET", "/users?warehouse_id=" + pp01 + "&q=zz.u&q_key=" + encodeURIComponent('["email"]'), admin);
    check("list ?warehouse_id=PP01 → cashier only", r.json.data?.length === 1 && r.json.data[0]._id === cashId, r.json.data?.length);
    r = await call("GET", "/users?role=" + encodeURIComponent(ROLES.CENTRAL_MANAGER.value) + "&q=zz.u&q_key=" + encodeURIComponent('["email"]'), admin);
    check("list ?role=central → 1", r.json.data?.length === 1, r.json.data?.length);

    r = await call("PUT", "/users/" + cashId, admin, { warehouse_ids: [] });
    check("update cashier remove all shops → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/users/" + cashId, admin, { warehouse_ids: [pp01, pp02] });
    check("update cashier → 2 shops", r.status === 200 && r.json.data.warehouse_ids.length === 2, JSON.stringify(r.json).slice(0, 150));
    r = await call("PUT", "/users/" + cashId, admin, { role: ROLES.ACCOUNTANT.value });
    check("change role to accountant → shops cleared", r.status === 200 && r.json.data.warehouse_ids.length === 0, JSON.stringify(r.json.data?.warehouse_ids));
    r = await call("PUT", "/users/" + cashId, admin, { role: ROLES.SHOP_MANAGER.value });
    check("change role to shop manager without shops → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/users/" + cashId, admin, { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [pp02] });
    check("shop manager + PP02 → 200", r.status === 200 && r.json.data.warehouse_ids[0].code === "PP02", JSON.stringify(r.json.data?.warehouse_ids));
    r = await call("PUT", "/users/" + cashId, admin, { pos_pin: "1234" });
    check("pos_pin through normal update is ignored", r.status === 400 || r.json.data?.has_pos_pin === false, JSON.stringify(r.json).slice(0, 120));

    r = await call("PUT", "/users/pos-pin/" + cashId, admin, { pos_pin: "12a4" });
    check("PIN with letters → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/users/pos-pin/" + cashId, admin, { pos_pin: "123" });
    check("PIN 3 digits → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/users/pos-pin/" + cashId, admin, { pos_pin: "2468" });
    check("PIN set → 200, has_pos_pin true, hash hidden", r.status === 200 && r.json.data.has_pos_pin === true && !("pos_pin" in r.json.data), JSON.stringify(r.json).slice(0, 150));
    const dbUser = await User.findById(cashId);
    check("PIN stored as bcrypt hash", dbUser.pos_pin && dbUser.pos_pin !== "2468" && (await bcrypt.compare("2468", dbUser.pos_pin)), dbUser.pos_pin);

    // the shop manager logs in: scope applies right away, no PIN hash in login / me
    const lg = await login("zz.u.cash1@local.test", "ChangeMe@2026");
    check("login response hides pos_pin, shows has_pos_pin", lg.success && !("pos_pin" in lg.data) && lg.data.has_pos_pin === true, Object.keys(lg.data || {}).join(","));
    r = await call("GET", "/auth/me", lg.data.access_token);
    check("/me hides pos_pin", r.status === 200 && !("pos_pin" in r.json.data), Object.keys(r.json.data || {}).join(","));
    r = await call("GET", "/setup/warehouse?limit=50", lg.data.access_token);
    check("shop manager sees only PP02", r.json.data?.length === 1 && r.json.data[0].code === "PP02", JSON.stringify(r.json.data?.map((w) => w.code)));
    r = await call("DELETE", "/setup/warehouse/" + pp02, admin);
    check("delete PP02 while user linked → 400", r.status === 400, r.json.message);

    r = await call("PUT", "/users/pos-pin/" + cashId, admin, { pos_pin: null });
    check("PIN removed", r.status === 200 && r.json.data.has_pos_pin === false, r.json.message);
  } catch (e) { console.error("ERROR", e); results.push(false); }
  finally {
    const ids = created.filter(Boolean);
    const extra = await User.find({ email: /@local\.test$/ }).select("_id"); extra.forEach((u) => ids.push(u._id));
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test users left: ${await User.countDocuments({ email: /@local\.test$/ })}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
