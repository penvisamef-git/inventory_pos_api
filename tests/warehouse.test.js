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

const PASS = "TestPass#2026";
const results = [];
const check = (name, cond, info = "") => { results.push(cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  → " + info}`); };

(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const KEY = process.env.API_AUTH_KEY;
  const call = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const ids = [];
  const mkUser = async (email, extra) => {
    const id = new mongoose.Types.ObjectId(); ids.push(id);
    await User.create({ _id: id, firstname: "Test", lastname: email.split("@")[0], email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, deleted: false, created_by: id, updated_by: id, ...extra });
    const r = await call("POST", "/auth/login", null, { email, password: PASS });
    return { id, token: r.json.data?.access_token };
  };
  try {
    const admin = await mkUser("zz.test.admin@local.test", { role: ROLES.ADMIN.value }); // normal admin: super admins leave no log
    check("admin login", !!admin.token);

    let r = await call("POST", "/setup/warehouse", admin.token, { code: "zzt1", name_kh: "ឃ្លាំងតេស្ត", name_en: "Test Central", type: "central" });
    check("create central → 201 + code uppercased + negative false", r.status === 201 && r.json.data.code === "ZZT1" && r.json.data.allow_negative_stock === false, JSON.stringify(r.json));
    const w1 = r.json.data?._id;
    r = await call("POST", "/setup/warehouse", admin.token, { code: "ZZT2", name_kh: "ហាងតេស្ត", type: "shop", phone: "012000000" });
    check("create shop → 201 + negative true", r.status === 201 && r.json.data.allow_negative_stock === true, JSON.stringify(r.json));
    const w2 = r.json.data?._id;
    r = await call("POST", "/setup/warehouse", admin.token, { code: "zzt1", name_kh: "x", type: "shop" });
    check("duplicate code → 409", r.status === 409, r.status + " " + r.json.message);
    r = await call("POST", "/setup/warehouse", admin.token, { code: "ZZT3", name_kh: "x", type: "store" });
    check("bad type → 400", r.status === 400, r.json.message);
    r = await call("POST", "/setup/warehouse", admin.token, { code: "ZZT3", type: "shop" });
    check("missing name_kh → 400 Khmer message", r.status === 400 && /សូមបញ្ចូល/.test(r.json.message), r.json.message);

    r = await call("GET", "/setup/warehouse?type=shop&q=ZZT&q_key=" + encodeURIComponent('["code"]'), admin.token);
    check("list ?type=shop → only shops", r.status === 200 && r.json.data.length >= 1 && r.json.data.every((w) => w.type === "shop"), JSON.stringify(r.json).slice(0, 200));

    const shop = await mkUser("zz.test.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [w2] });
    r = await call("GET", "/setup/warehouse?limit=200", shop.token);
    check("shop manager list → only own shop", r.status === 200 && r.json.data.length === 1 && r.json.data[0]._id === w2, JSON.stringify(r.json).slice(0, 200));
    r = await call("GET", "/setup/warehouse-all", shop.token);
    check("shop manager -all → only own shop", r.status === 200 && r.json.data.length === 1, r.json.data?.length);
    r = await call("GET", "/setup/warehouse/" + w1, shop.token);
    check("shop manager get other warehouse → 404", r.status === 404, r.status);
    r = await call("GET", "/setup/warehouse/" + w2, shop.token);
    check("shop manager get own → 200", r.status === 200, r.status);
    r = await call("POST", "/setup/warehouse", shop.token, { code: "ZZT9", name_kh: "x", type: "shop" });
    check("shop manager create → 403", r.status === 403, r.status);

    const cashier = await mkUser("zz.test.cashier@local.test", { role: ROLES.CASHIER.value, warehouse_ids: [w2] });
    r = await call("GET", "/setup/warehouse", cashier.token);
    check("cashier list → 403 (no admin web)", r.status === 403, r.status);
    const noWh = await mkUser("zz.test.nowh@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [] });
    r = await call("GET", "/setup/warehouse", noWh.token);
    check("shop manager without warehouse → 403 Khmer message", r.status === 403 && /ឃ្លាំង/.test(r.json.message), r.json.message);
    const central = await mkUser("zz.test.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    r = await call("GET", "/setup/warehouse?q=ZZT&q_key=" + encodeURIComponent('["code"]'), central.token);
    check("central manager sees all (2 test rows)", r.status === 200 && r.json.data.length === 2, r.json.data?.length);
    r = await call("PUT", "/setup/warehouse/" + w2, central.token, { phone: "1" });
    check("central manager update → 403 (admin only)", r.status === 403, r.status);

    r = await call("PUT", "/setup/warehouse/" + w2, admin.token, { manager_id: "65f000000000000000000099" });
    check("update bad manager → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/setup/warehouse/" + w2, admin.token, { manager_id: String(shop.id), name_en: "Test Shop" });
    check("update manager → 200 populated", r.status === 200 && r.json.data.manager_id?.email === "zz.test.shop@local.test", JSON.stringify(r.json).slice(0, 200));
    r = await call("PUT", "/setup/warehouse/" + w2, admin.token, { manager_id: null });
    check("clear manager with null → 200", r.status === 200 && r.json.data.manager_id === null, JSON.stringify(r.json.data?.manager_id));
    r = await call("PUT", "/setup/warehouse/" + w2, admin.token, { code: "zzt1" });
    check("update to existing code → 409", r.status === 409, r.status);
    r = await call("PUT", "/setup/warehouse/" + w2, admin.token, {});
    check("update nothing → 400", r.status === 400, r.status);

    r = await call("PUT", "/setup/warehouse-sort", admin.token, { items: [{ _id: w1, sort_order: 5 }, { _id: w2, sort_order: 6 }] });
    check("sort → 200", r.status === 200 && r.json.data.modified === 2, JSON.stringify(r.json));

    r = await call("DELETE", "/setup/warehouse/" + w2, admin.token);
    check("delete shop with linked users → 400", r.status === 400, r.json.message);
    r = await call("DELETE", "/setup/warehouse/" + w1, admin.token);
    check("delete central → 200", r.status === 200, r.json.message);
    r = await call("GET", "/setup/warehouse/" + w1, admin.token);
    check("get deleted → 404", r.status === 404, r.status);
    r = await call("PUT", "/setup/warehouse/restore/" + w1, admin.token);
    check("restore → 200", r.status === 200 && r.json.data.deleted === false, r.json.message);

    const logs = await ActivityLog.countDocuments({ create_by_id: admin.id });
    check("activity logs written", logs >= 6, logs);
  } catch (e) {
    console.error("ERROR", e);
    results.push(false);
  } finally {
    await Warehouse.deleteMany({ code: /^ZZT/ });
    await Session.deleteMany({ user_id: { $in: ids } });
    await ActivityLog.deleteMany({ create_by_id: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    const left = (await Warehouse.countDocuments({ code: /^ZZT/ })) + (await User.countDocuments({ email: /@local\.test$/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · cleanup left ${left} test rows`);
    server.close();
    await mongoose.connection.close();
    process.exit(0);
  }
})();
