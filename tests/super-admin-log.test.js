// Integration test against the test database (UAT) — run all with: npm test
// Super admins leave no activity log, and their sessions / old log rows are not listed.
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const M = (p) => require(API + "/src/v1/admin/" + p);
const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model"), Brand = M("product/brand/brand.model");
const LogCat = M("activity_log_category/activity_log_category.model");
const { clearSuperAdminIds } = require(API + "/src/util/log");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  while (mongoose.connection.readyState !== 1) await wait(300);
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "U", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return id; };
  const login = async (email) => (await call("POST", "/auth/login", null, { email, password: PASS })).json.data?.access_token;
  try {
    const SA = await mk("zz.sa.super@local.test", { is_super_admin: true });
    const AD = await mk("zz.sa.admin@local.test", { role: ROLES.ADMIN.value });
    const CM = await mk("zz.sa.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    const SM = await mk("zz.sa.shop@local.test", { role: ROLES.SHOP_MANAGER.value });
    clearSuperAdminIds();
    const superT = await login("zz.sa.super@local.test");
    const adminT = await login("zz.sa.admin@local.test");
    check("both log in", superT && adminT);
    await wait(300);
    check("super admin login → no log row", (await ActivityLog.countDocuments({ create_by_id: SA })) === 0);
    check("normal admin login → logged", (await ActivityLog.countDocuments({ create_by_id: AD })) >= 1);

    let r = await call("POST", "/product/brand", superT, { code: "zzsalog", name_kh: "តេស្ត log" });
    await call("DELETE", "/product/brand/" + r.json.data?._id, superT);
    await wait(300);
    check("super admin creates / deletes → still no log row", r.status === 201 && (await ActivityLog.countDocuments({ create_by_id: SA })) === 0, r.status);

    // an old row (from before this rule) is hidden from the list
    const cat = await LogCat.findOne({});
    await ActivityLog.create({ title: "ZZ old super admin row", description: "x", activity_log_category_id: cat._id, create_by_id: SA, time: "x" });
    r = await call("GET", "/activity_log?page=1&limit=200&sort=created_date&order=desc", adminT);
    check("activity log list hides super admin rows, shows the admin's", r.status === 200 && !r.json.data.some((x) => String(x.create_by_id?._id || x.create_by_id) === String(SA)) && r.json.data.some((x) => String(x.create_by_id?._id || x.create_by_id) === String(AD)), r.status);

    r = await call("GET", "/activity_log?page=1&limit=200&sort=created_date&order=desc", superT);
    check("super admin sees everything (also super admin rows)", r.status === 200 && r.json.scope === "all" && r.json.data.some((x) => String(x.create_by_id?._id) === String(SA)) && r.json.data.some((x) => String(x.create_by_id?._id) === String(AD)));
    const cmT = await login("zz.sa.central@local.test"); const smT = await login("zz.sa.shop@local.test");
    await wait(300);
    for (const [who, t, id] of [["central manager", cmT, CM], ["shop manager", smT, SM]]) {
      r = await call("GET", "/activity_log?page=1&limit=200", t);
      check(`${who} sees only own rows`, r.status === 200 && r.json.scope === "own" && r.json.data.length >= 1 && r.json.data.every((x) => String(x.create_by_id?._id) === String(id)), r.status + " " + r.json.data?.length);
    }
    r = await call("GET", "/activity_log/category-all", smT);
    check("types list open to every role", r.status === 200, r.status);
    r = await call("GET", "/session?page=1&limit=200", smT);
    check("sessions still admin only (403)", r.status === 403, r.status);

    r = await call("GET", "/session?page=1&limit=200", adminT);
    check("session list hides super admin sessions", r.status === 200 && !r.json.data.some((x) => String(x.user_id?._id || x.user_id) === String(SA)) && r.json.data.some((x) => String(x.user_id?._id || x.user_id) === String(AD)));
    const sess = await Session.findOne({ user_id: SA }).lean();
    r = await call("DELETE", "/session/" + sess._id, adminT);
    check("admin cannot force-logout a super admin (404)", r.status === 404 && (await Session.exists({ _id: sess._id })), r.status);
    r = await call("GET", "/auth/me", superT);
    check("super admin still logged in", r.status === 200, r.status);
  } catch (e) { console.log("ERR", e); } finally {
    await Brand.deleteMany({ code: "zzsalog" });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    const left = (await User.countDocuments({ email: /^zz\.sa\./ })) + (await ActivityLog.countDocuments({ create_by_id: { $in: ids } }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
