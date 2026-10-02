// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off"; process.env.CORS_ORIGINS = "https://extra.example.com/";
const mongoose = require(API + "/node_modules/mongoose"); const app = require(API + "/index.js");
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => { while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}`;
  const pre = async (origin) => { const r = await fetch(b + "/api/admin/auth/login", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-api-key" } }); return r.headers.get("access-control-allow-origin"); };
  check("admin web (web.app) allowed", (await pre("https://inventory-pos-kh.web.app")) === "https://inventory-pos-kh.web.app");
  check("localhost:3000 allowed", (await pre("http://localhost:3000")) === "http://localhost:3000");
  check("CORS_ORIGINS extra site allowed", (await pre("https://extra.example.com")) === "https://extra.example.com");
  check("other website refused", (await pre("https://evil.example.org")) === null);
  const r = await fetch(b + "/health"); check("no Origin (Postman / uptime) still works", r.status === 200);
  console.log(`${R.filter(Boolean).length}/${R.length} passed`); s.close(); await mongoose.connection.close(); process.exit(0); })();
