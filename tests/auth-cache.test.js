// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js"); const M = (p) => require(API + "/src/v1/admin/" + p);
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const User = M("user/user.model"), Session = M("session/session.model"), Log = M("activity_log/activity_log.model"); const { ROLES } = require(API + "/src/util/user_roles");
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}/api/admin`; const K = process.env.API_AUTH_KEY;
  const c = async (m, p, t, x) => { const r = await fetch(b + p, { method: m, headers: { "x-api-key": K, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: x ? JSON.stringify(x) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), timing: r.headers.get("server-timing") }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "Z", lastname: "C", email, password: await bcrypt.hash("TestPass#2026", 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return { id, tok: (await c("POST", "/auth/login", null, { email, password: "TestPass#2026" })).json.data.access_token }; };
  try {
    const admin = await mk("zz.c.admin@local.test", { is_super_admin: true });
    const u = await mk("zz.c.user@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    let r = await c("GET", "/auth/me", u.tok); await c("GET", "/auth/me", u.tok);
    r = await c("GET", "/setup/warehouse-all", u.tok);
    check("cached auth: 1 db call for warehouse-all (only the list)", /db;desc="1 calls"/.test(r.timing), r.timing);
    r = await c("GET", "/telegram/bot", u.tok); check("central → telegram admin route 403", r.status === 403, r.status);
    await c("PUT", `/users/${u.id}`, admin.tok, { role: ROLES.ADMIN.value });
    r = await c("GET", "/telegram/bot", u.tok);
    check("role changed to admin → seen at once (sessions reset or role applied)", r.status === 200 || r.status === 401, r.status);
    const u2 = await mk("zz.c.user2@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    await c("GET", "/auth/me", u2.tok);
    await User.updateOne({ _id: u2.id }, { status: false });
    r = await c("GET", "/auth/me", u2.tok); check("disabled user → 401 at once", r.status === 401, r.status);
    const u3 = await mk("zz.c.user3@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    await c("GET", "/auth/me", u3.tok); await c("POST", "/auth/logout", u3.tok);
    r = await c("GET", "/auth/me", u3.tok); check("logout → token refused at once", r.status === 401, r.status);
    r = await c("GET", "/auth/me", admin.tok); check("other users still fine", r.status === 200, r.status);
  } catch (e) { console.log("ERR", e); } finally {
    await Session.deleteMany({ user_id: { $in: ids } }); await Log.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    console.log(`\n${R.filter(Boolean).length}/${R.length} passed · left ${await User.countDocuments({ email: /@local\.test$/ })}`);
    s.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
