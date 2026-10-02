// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt"); const app = require(API + "/index.js");
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => { while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const User = require(API + "/src/v1/admin/user/user.model"), Session = require(API + "/src/v1/admin/session/session.model"), Log = require(API + "/src/v1/admin/activity_log/activity_log.model");
  const { LoginAttempt } = require(API + "/src/util/login_guard");
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}/api/admin`; const K = process.env.API_AUTH_KEY;
  const login = async (email, password, ip = "203.0.113.7") => { const r = await fetch(b + "/auth/login", { method: "POST", headers: { "x-api-key": K, "Content-Type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ email, password }) }); return { status: r.status, json: await r.json() }; };
  const id = new mongoose.Types.ObjectId(); const email = "zz.guard@local.test";
  await User.create({ _id: id, firstname: "Z", lastname: "G", email, password: await bcrypt.hash("Right#Pass2026", 10), is_first_login: false, is_super_admin: true, status: true, created_by: id, updated_by: id });
  try {
    let r = await login(email, "Right#Pass2026"); check("right password → 200", r.status === 200);
    for (let i = 0; i < 8; i++) r = await login(email, "wrong" + i);
    check("8 wrong passwords → still 401", r.status === 401, r.status);
    r = await login(email, "Right#Pass2026"); check("9th try (even correct) → 429 wait", r.status === 429 && /នាទី/.test(r.json.message) && r.json.retry_after > 800, JSON.stringify(r.json));
    r = await login("zz.other@local.test", "x", "198.51.100.9"); check("another email / IP not blocked", r.status === 401, r.status);
    await LoginAttempt.updateOne({ key: `email:${email}` }, { reset_at: new Date(Date.now() - 1000) });
    r = await login(email, "Right#Pass2026"); check("after the window → login works again", r.status === 200, r.status);
    check("success clears the email counter", !(await LoginAttempt.exists({ key: `email:${email}` })));
    for (let i = 0; i < 30; i++) await login(`zz.spray${i}@local.test`, "x", "192.0.2.50");
    r = await login(email, "Right#Pass2026", "192.0.2.50"); check("30 fails from one IP (many emails) → IP blocked", r.status === 429, r.status);
    r = await login(email, "Right#Pass2026", "192.0.2.51"); check("same user from another IP → ok", r.status === 200, r.status);
  } finally {
    await LoginAttempt.deleteMany({ $or: [{ key: /local\.test$/ }, { key: /^ip:(203\.0\.113\.7|198\.51\.100\.9|192\.0\.2\.5[01])$/ }] });
    await Session.deleteMany({ user_id: id }); await Log.deleteMany({ create_by_id: id }); await User.deleteMany({ _id: id });
    console.log(`${R.filter(Boolean).length}/${R.length} passed · rows left ${await LoginAttempt.countDocuments({ key: /local\.test|203\.0\.113|198\.51|192\.0\.2/ })}`);
    s.close(); await mongoose.connection.close(); process.exit(0); }
})();
