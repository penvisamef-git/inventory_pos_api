// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const app = require(API + "/index.js");
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => { while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}/api/admin`; const K = process.env.API_AUTH_KEY;
  const c = async (m, p, t, x) => { const r = await fetch(b + p, { method: m, headers: { "x-api-key": K, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: x ? JSON.stringify(x) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), timing: r.headers.get("server-timing") }; };
  const login = async (e) => (await c("POST", "/auth/login", null, { email: e, password: "Sample@2026" })).json.data.access_token;
  const central = await login("central@inventorypos.test"), shop = await login("manager.pp01@inventorypos.test");
  const V = require(API + "/src/v1/admin/product/item/variant.model"); const v = await V.findOne({ deleted: false, barcode: { $ne: null } }).lean();
  try {
    let r = await c("GET", "/search?q=pampers", central); const d = r.json.data;
    check("pampers → products + skus + brand", d.products.length && d.skus.length && d.brands.length, JSON.stringify({ p: d.products.length, s: d.skus.length, b: d.brands.length }));
    console.log("   timing", r.timing);
    r = await c("GET", "/search?q=" + encodeURIComponent(v.barcode), central);
    check("scan barcode → that SKU first", r.json.data.skus[0]?.code === v.code, JSON.stringify(r.json.data.skus.map((x) => x.code)));
    r = await c("GET", "/search?q=TR-", central); const ctr = r.json.data.documents.length;
    check("central: transfers by number", ctr > 0 && r.json.data.documents.every((x) => x.type === "transfer"), ctr);
    r = await c("GET", "/search?q=GR-", central); check("central sees goods receive", r.json.data.documents.some((x) => x.type === "receive"));
    r = await c("GET", "/search?q=GR-", shop); check("shop manager: no goods receive", r.json.data.documents.length === 0, JSON.stringify(r.json.data.documents));
    r = await c("GET", "/search?q=TR-", shop); check("shop manager: only transfers touching PP01", r.json.data.documents.every((x) => x.from === "PP01" || x.to === "PP01"), JSON.stringify(r.json.data.documents.map((x) => x.from + ">" + x.to)));
    r = await c("GET", "/search?q=PP0", shop); check("shop manager: warehouses = own only", r.json.data.warehouses.length === 1 && r.json.data.warehouses[0].code === "PP01", JSON.stringify(r.json.data.warehouses.map((w) => w.code)));
    r = await c("GET", "/search?q=inventorypos", central); check("central: no users group", r.json.data.users.length === 0);
    r = await c("GET", "/search?q=a", central); check("1 letter → empty", r.json.data.products.length === 0);
    r = await c("GET", "/search?q=(.*", central); check("regex characters are safe", r.status === 200, r.status);
  } finally { await c("POST", "/auth/logout", central); await c("POST", "/auth/logout", shop);
    console.log(`${R.filter(Boolean).length}/${R.length} passed`); s.close(); await mongoose.connection.close(); process.exit(0); }
})();
