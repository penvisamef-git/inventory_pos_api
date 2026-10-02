// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test");
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const User = require(API + "/src/v1/admin/user/user.model"); const Session = require(API + "/src/v1/admin/session/session.model");
const ActivityLog = require(API + "/src/v1/admin/activity_log/activity_log.model");
const Setting = require(API + "/src/v1/admin/setup/setting/setting.model");
const Rate = require(API + "/src/v1/admin/setup/exchange_rate/exchange_rate.model");
const PM = require(API + "/src/v1/admin/setup/payment_method/payment_method.model");
const Warehouse = require(API + "/src/v1/admin/setup/warehouse/warehouse.model");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "U", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return (await call("POST", "/auth/login", null, { email, password: PASS })).json.data.access_token; };
  const settingBefore = (await Setting.findOne({ key: "main" }).lean());
  const rateIds = []; const pmCodes = [];
  try {
    const admin = await mk("zz.s.admin@local.test", { is_super_admin: true });
    const pp01 = (await Warehouse.findOne({ code: "PP01" }))._id;
    const shop = await mk("zz.s.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [pp01] });

    // ---------- Setting ----------
    let r = await call("GET", "/setup/setting", shop);
    check("setting GET (shop manager can view)", r.status === 200 && r.json.data.key === "main", r.status);
    r = await call("PUT", "/setup/setting", shop, { phone: "1" });
    check("setting PUT shop manager → 403", r.status === 403, r.status);
    r = await call("PUT", "/setup/setting", admin, { tax_mode: "both" });
    check("setting bad tax_mode → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/setup/setting", admin, { tax_rate: 120 });
    check("setting tax_rate 120 → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/setup/setting", admin, { khr_rounding: -1 });
    check("setting negative number → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/setup/setting", admin, { tax_mode: "exclusive", tax_rate: "10", company_name_en: "ZZ Test Co", key: "hack", _id: "x" });
    check("setting update → 200, numbers converted, key protected", r.status === 200 && r.json.data.tax_rate === 10 && r.json.data.key === "main" && r.json.data.company_name_en === "ZZ Test Co", JSON.stringify(r.json).slice(0, 200));
    r = await call("PUT", "/setup/setting", admin, {});
    check("setting empty update → 400", r.status === 400, r.status);

    // ---------- Exchange rate ----------
    r = await call("GET", "/setup/exchange-rate/current", shop);
    check("rate current (seeded 4100) → 200", r.status === 200 && r.json.data.rate > 0, JSON.stringify(r.json).slice(0, 120));
    const seeded = r.json.data;
    r = await call("POST", "/setup/exchange-rate", admin, { rate: 0, effective_from: new Date().toISOString() });
    check("rate 0 → 400", r.status === 400, r.json.message);
    r = await call("POST", "/setup/exchange-rate", admin, { rate: 4100, effective_from: "not a date" });
    check("bad date → 400", r.status === 400, r.json.message);
    const future = new Date(Date.now() + 86400000 * 3).toISOString();
    r = await call("POST", "/setup/exchange-rate", admin, { rate: 4120, effective_from: future, note: "zz test" });
    check("future rate → 201", r.status === 201, r.json.message); const fut = r.json.data?._id; rateIds.push(fut);
    r = await call("POST", "/setup/exchange-rate", admin, { rate: 4130, effective_from: future });
    check("same start time → 409", r.status === 409, r.status);
    r = await call("GET", "/setup/exchange-rate/current", admin);
    check("current still the seeded rate (future not active yet)", r.json.data?._id === seeded._id, r.json.data?.rate);
    r = await call("GET", "/setup/exchange-rate?limit=50", admin);
    const states = Object.fromEntries((r.json.data || []).map((x) => [x._id, x.state]));
    check("list has states current + upcoming", states[seeded._id] === "current" && states[fut] === "upcoming", JSON.stringify(states));
    r = await call("PUT", "/setup/exchange-rate/" + fut, admin, { rate: 4125 });
    check("edit upcoming → 200", r.status === 200 && r.json.data.rate === 4125, r.json.message);
    r = await call("PUT", "/setup/exchange-rate/" + seeded._id, admin, { rate: 1 });
    check("edit current/past → 400 locked", r.status === 400, r.json.message);
    r = await call("DELETE", "/setup/exchange-rate/" + seeded._id, admin);
    check("delete current/past → 400 locked", r.status === 400, r.status);
    r = await call("DELETE", "/setup/exchange-rate/" + fut, admin);
    check("delete upcoming → 200", r.status === 200, r.json.message);
    r = await call("POST", "/setup/exchange-rate", shop, { rate: 4100, effective_from: future });
    check("shop manager create rate → 403", r.status === 403, r.status);

    // ---------- Payment method ----------
    r = await call("GET", "/setup/payment-method-all", shop);
    check("payment methods (seeded 4) visible", r.status === 200 && ["cash_usd", "cash_khr", "khqr", "aba"].every((c) => r.json.data.some((p) => p.code === c)), JSON.stringify(r.json.data?.map((p) => p.code)));
    r = await call("POST", "/setup/payment-method", admin, { code: "ZZ Card!", name_kh: "x", type: "card" });
    check("bad code → 400", r.status === 400, r.json.message);
    r = await call("POST", "/setup/payment-method", admin, { code: "zz_card", name_kh: "x", type: "coin" });
    check("bad type → 400", r.status === 400, r.json.message);
    r = await call("POST", "/setup/payment-method", admin, { code: "ZZ_CARD", name_kh: "កាត", type: "card", currency: "USD" });
    check("create card → 201 (code lowercased)", r.status === 201 && r.json.data.code === "zz_card", r.json.message); pmCodes.push("zz_card"); const pm = r.json.data?._id;
    r = await call("POST", "/setup/payment-method", admin, { code: "khqr", name_kh: "x", type: "qr" });
    check("duplicate code → 409", r.status === 409, r.status);
    r = await call("PUT", "/setup/payment-method/" + pm, admin, { currency: "EUR" });
    check("bad currency → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/setup/payment-method/" + pm, admin, { requires_reference: true, status: false });
    check("update → 200", r.status === 200 && r.json.data.requires_reference === true && r.json.data.status === false, r.json.message);
    r = await call("GET", "/setup/payment-method-all", admin);
    check("inactive method hidden from -all", !r.json.data.some((p) => p.code === "zz_card"), "");
    r = await call("DELETE", "/setup/payment-method/" + pm, admin);
    check("delete → 200", r.status === 200, r.status);
    r = await call("PUT", "/setup/payment-method/restore/" + pm, admin);
    check("restore → 200", r.status === 200, r.status);
    r = await call("PUT", "/setup/payment-method/" + pm, shop, { name_kh: "y" });
    check("shop manager edit → 403", r.status === 403, r.status);
  } catch (e) { console.error("ERROR", e); results.push(false); }
  finally {
    if (settingBefore) { const { _id, __v, created_date, updated_date, ...rest } = settingBefore; await Setting.updateOne({ key: "main" }, { $set: rest }); }
    await Rate.deleteMany({ _id: { $in: rateIds.filter(Boolean) } });
    await PM.deleteMany({ code: { $in: pmCodes } });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    const s = await Setting.findOne({ key: "main" }).lean();
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · setting restored: tax_mode=${s.tax_mode}, company_en="${s.company_name_en}" · test rows left: ${(await PM.countDocuments({ code: "zz_card" })) + (await User.countDocuments({ email: /@local\.test$/ }))}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
