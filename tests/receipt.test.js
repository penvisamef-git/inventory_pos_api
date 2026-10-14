// Integration test against the test database (UAT) — run all with: npm test
// POS receipt style (setting.receipt_template, 24 styles)
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt"); const app = require(API + "/index.js");
const S = require(API + "/src/v1/admin/setup/setting/setting.model");
const User = require(API + "/src/v1/admin/user/user.model"), Session = require(API + "/src/v1/admin/session/session.model"), ActivityLog = require(API + "/src/v1/admin/activity_log/activity_log.model");
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => { while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}/api/admin`; const K = process.env.API_AUTH_KEY;
  const c = async (m, p, t, x) => { const r = await fetch(b + p, { method: m, headers: { "x-api-key": K, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: x ? JSON.stringify(x) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const before = (await S.getMain()).receipt_template;
  const id = new mongoose.Types.ObjectId();
  try {
    check("24 receipt styles", S.RECEIPT_TEMPLATES.length === 24 && new Set(S.RECEIPT_TEMPLATES).size === 24);
    await User.create({ _id: id, firstname: "Z", lastname: "R", email: "zz.rc.admin@local.test", password: await bcrypt.hash("TestPass#2026", 10), is_super_admin: true, is_first_login: false, status: true, created_by: id, updated_by: id });
    const t = (await c("POST", "/auth/login", null, { email: "zz.rc.admin@local.test", password: "TestPass#2026" })).json.data.access_token;
    let r = await c("PUT", "/setup/setting", t, { receipt_template: "retro" });
    check("admin picks a receipt style → saved", r.status === 200 && r.json.data.receipt_template === "retro", JSON.stringify(r.json).slice(0, 200));
    r = await c("PUT", "/setup/setting", t, { receipt_template: "fancy" });
    check("unknown style → 400", r.status === 400, r.status);
    r = await c("GET", "/setup/setting", t);
    check("setting returns it", r.json.data.receipt_template === "retro");
  } finally {
    await S.updateOne({ key: "main" }, { receipt_template: before || "classic" });
    await Session.deleteMany({ user_id: id }); await ActivityLog.deleteMany({ create_by_id: id }); await User.deleteMany({ _id: id });
    console.log(`${R.filter(Boolean).length}/${R.length} passed · style restored: ${(await S.getMain()).receipt_template}`);
    s.close(); await mongoose.connection.close(); process.exit(0); }
})();
