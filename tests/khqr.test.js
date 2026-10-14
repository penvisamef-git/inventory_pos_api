// Integration test against the test database (UAT) — run all with: npm test
// Bakong KHQR: payment method fields + the md5 check (against a local fake Bakong)
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const http = require("http");
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt"); const app = require(API + "/index.js");
const PM = require(API + "/src/v1/admin/setup/payment_method/payment_method.model");
const bakong = require(API + "/src/util/bakong");
const User = require(API + "/src/v1/admin/user/user.model"), Session = require(API + "/src/v1/admin/session/session.model"), ActivityLog = require(API + "/src/v1/admin/activity_log/activity_log.model");
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const PAID = "a".repeat(32);
(async () => { while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}/api/admin`; const K = process.env.API_AUTH_KEY;
  const c = async (m, p, t, x) => { const r = await fetch(b + p, { method: m, headers: { "x-api-key": K, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: x ? JSON.stringify(x) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  let seen = null;
  const fake = http.createServer((q, w) => { let d = ""; q.on("data", (x) => (d += x)); q.on("end", () => {
    seen = { auth: q.headers.authorization, path: q.url };
    const md5 = JSON.parse(d || "{}").md5;
    w.setHeader("Content-Type", "application/json");
    w.end(JSON.stringify(md5 === PAID ? { responseCode: 0, data: { hash: "h1", amount: 13.5, currency: "USD", fromAccountId: "buyer@aba" } } : { responseCode: 1, errorCode: 1 }));
  }); }).listen(0);
  const keep = { t: process.env.BAKONG_TOKEN, u: process.env.BAKONG_API_URL };
  const id = new mongoose.Types.ObjectId();
  try {
    await User.create({ _id: id, firstname: "Z", lastname: "K", email: "zz.khqr.admin@local.test", password: await bcrypt.hash("TestPass#2026", 10), is_super_admin: true, is_first_login: false, status: true, created_by: id, updated_by: id });
    const t = (await c("POST", "/auth/login", null, { email: "zz.khqr.admin@local.test", password: "TestPass#2026" })).json.data.access_token;
    let r = await c("POST", "/setup/payment-method", t, { code: "zz_khqr", name_kh: "KHQR តេស្ត", type: "qr", online_mode: true, bakong_account_id: "bad account" });
    check("bad Bakong account → 400", r.status === 400, r.status);
    r = await c("POST", "/setup/payment-method", t, { code: "zz_khqr", name_kh: "KHQR តេស្ត", type: "qr", currency: "USD", online_mode: true, bakong_account_id: "kidsshop@aclb" });
    const pid = r.json.data?._id;
    check("KHQR saved, merchant name from the account", r.status === 201 && r.json.data.bakong_account_id === "kidsshop@aclb" && r.json.data.merchant_name === "kidsshop" && r.json.data.merchant_city === "Phnom Penh", JSON.stringify(r.json).slice(0, 200));
    r = await c("PUT", "/setup/payment-method/" + pid, t, { merchant_name: "Kids Shop", bakong_account_id: "x y" });
    check("edit with a bad account → 400", r.status === 400, r.status);
    r = await c("PUT", "/setup/payment-method/" + pid, t, { merchant_name: "Kids Shop" });
    check("edit merchant name → saved, account kept", r.status === 200 && r.json.data.merchant_name === "Kids Shop" && r.json.data.bakong_account_id === "kidsshop@aclb", JSON.stringify(r.json).slice(0, 200));

    delete process.env.BAKONG_TOKEN;
    check("no BAKONG_TOKEN → not ready, not paid", JSON.stringify(await bakong.checkMd5(PAID)) === JSON.stringify({ ready: false, paid: false }));
    process.env.BAKONG_TOKEN = "zz-test-token"; process.env.BAKONG_API_URL = `http://127.0.0.1:${fake.address().port}/`;
    let x = await bakong.checkMd5("b".repeat(32));
    check("unpaid md5 → paid false", x.ready && !x.paid, JSON.stringify(x));
    check("sends Bearer token to /v1/check_transaction_by_md5", seen?.auth === "Bearer zz-test-token" && seen?.path === "/v1/check_transaction_by_md5", JSON.stringify(seen));
    x = await bakong.checkMd5(PAID);
    check("paid md5 → paid, amount, hash", x.paid && x.amount === 13.5 && x.hash === "h1", JSON.stringify(x));
    r = await c("POST", "/pos-device/khqr/check", null, { md5: PAID });
    check("device route needs the device key", r.status === 401 || r.status === 403, r.status);
  } finally {
    process.env.BAKONG_TOKEN = keep.t || ""; if (!keep.t) delete process.env.BAKONG_TOKEN; if (keep.u) process.env.BAKONG_API_URL = keep.u; else delete process.env.BAKONG_API_URL;
    await PM.deleteMany({ code: /^zz_/ });
    await Session.deleteMany({ user_id: id }); await ActivityLog.deleteMany({ create_by_id: id }); await User.deleteMany({ _id: id });
    console.log(`${R.filter(Boolean).length}/${R.length} passed · left: ${await PM.countDocuments({ code: /^zz_/ })}`);
    fake.close(); s.close(); await mongoose.connection.close(); process.exit(0); }
})();
