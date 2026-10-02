// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const app = require(API + "/index.js");
const S = require(API + "/src/v1/admin/setup/setting/setting.model");
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => { while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}/api/admin`; const K = process.env.API_AUTH_KEY;
  const c = async (m, p, t, x, key = K) => { const r = await fetch(b + p, { method: m, headers: { "x-api-key": key, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: x ? JSON.stringify(x) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const before = (await S.getMain()).ui_theme;
  try {
    let r = await c("GET", "/setup/theme"); check("theme without login → " + r.json.data?.ui_theme, r.status === 200 && r.json.data.ui_theme);
    const central = (await c("POST", "/auth/login", null, { email: "central@inventorypos.test", password: "Sample@2026" })).json.data.access_token;
    r = await c("PUT", "/setup/setting", central, { ui_theme: "ocean" }); check("central cannot change theme (403)", r.status === 403, r.status);
    await S.updateOne({ key: "main" }, { ui_theme: "candy" });
    r = await c("GET", "/setup/theme"); check("theme follows setting", r.json.data.ui_theme === "candy", JSON.stringify(r.json));
    r = await c("GET", "/setup/setting", central); check("setting returns ui_theme", r.json.data.ui_theme === "candy");
    await c("POST", "/auth/logout", central);
  } finally {
    await S.updateOne({ key: "main" }, { ui_theme: before || "forest" });
    console.log(`${R.filter(Boolean).length}/${R.length} passed · theme restored: ${(await S.getMain()).ui_theme}`);
    s.close(); await mongoose.connection.close(); process.exit(0); }
})();
