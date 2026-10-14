// Integration test against the test database (UAT) — run all with: npm test
// Payment method: fixed QR picture (qr_enabled + qr_image) for the customer display
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt"); const app = require(API + "/index.js");
const PM = require(API + "/src/v1/admin/setup/payment_method/payment_method.model");
const User = require(API + "/src/v1/admin/user/user.model"), Session = require(API + "/src/v1/admin/session/session.model"), ActivityLog = require(API + "/src/v1/admin/activity_log/activity_log.model");
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => { while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}/api/admin`; const K = process.env.API_AUTH_KEY;
  const c = async (m, p, t, x) => { const r = await fetch(b + p, { method: m, headers: { "x-api-key": K, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: x ? JSON.stringify(x) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const id = new mongoose.Types.ObjectId();
  const img = { url: "https://res.cloudinary.com/demo/image/upload/zz_qr.png", public_id: "zz_qr" };
  try {
    await User.create({ _id: id, firstname: "Z", lastname: "Q", email: "zz.qr.admin@local.test", password: await bcrypt.hash("TestPass#2026", 10), is_super_admin: true, is_first_login: false, status: true, created_by: id, updated_by: id });
    const t = (await c("POST", "/auth/login", null, { email: "zz.qr.admin@local.test", password: "TestPass#2026" })).json.data.access_token;
    let r = await c("POST", "/setup/payment-method", t, { code: "zz_qr", name_kh: "QR តេស្ត", type: "qr", qr_enabled: true });
    check("QR switched on without a picture → 400", r.status === 400, r.status);
    r = await c("POST", "/setup/payment-method", t, { code: "zz_qr", name_kh: "QR តេស្ត", type: "qr", qr_enabled: true, qr_image: img });
    const pid = r.json.data?._id;
    check("with the QR picture → 201, saved", r.status === 201 && r.json.data.qr_enabled === true && r.json.data.qr_image?.url === img.url, JSON.stringify(r.json).slice(0, 200));
    r = await c("PUT", "/setup/payment-method/" + pid, t, { qr_enabled: false });
    check("switch off → saved (picture kept)", r.status === 200 && r.json.data.qr_enabled === false && r.json.data.qr_image?.url === img.url, JSON.stringify(r.json).slice(0, 200));
    r = await c("PUT", "/setup/payment-method/" + pid, t, { qr_enabled: true, qr_image: null });
    check("switch on but remove the picture → 400", r.status === 400, r.status);
  } finally {
    await PM.deleteMany({ code: /^zz_/ });
    await Session.deleteMany({ user_id: id }); await ActivityLog.deleteMany({ create_by_id: id }); await User.deleteMany({ _id: id });
    console.log(`${R.filter(Boolean).length}/${R.length} passed · left: ${await PM.countDocuments({ code: /^zz_/ })}`);
    s.close(); await mongoose.connection.close(); process.exit(0); }
})();
