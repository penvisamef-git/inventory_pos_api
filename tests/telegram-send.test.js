// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test");
const http = require("http");
const GOOD = "123456789:AAEzzTestTokenForFakeTelegramServer0001"; const sent = [];
const fake = http.createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
  const m = req.url.match(/^\/bot([^/]+)\/(\w+)/); const p = body ? JSON.parse(body) : {}; const send = (c, j) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
  if (m?.[1] !== GOOD) return send(401, { ok: false, description: "Unauthorized" });
  if (m[2] === "getMe") return send(200, { ok: true, result: { id: 777000, username: "zz_test_bot" } });
  if (m[2] === "sendMessage") { sent.push(p); return send(200, { ok: true, result: { message_id: sent.length } }); }
  send(404, { ok: false }); }); });
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const M = (p) => require(API + "/src/v1/admin/" + p);
const results = []; const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  await new Promise((r) => fake.listen(0, r)); process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${fake.address().port}`; process.env.TELEGRAM_WORKER = "off";
  const app = require(API + "/index.js");
  const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model"), W = M("setup/warehouse/warehouse.model"), Cat = M("product/category/category.model");
  const T = M("telegram/telegram.model"); const svc = M("telegram/telegram.service"); const { ROLES } = require(API + "/src/util/user_roles");
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "Zz", lastname: "Sender", email, password: await bcrypt.hash("TestPass#2026", 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return (await call("POST", "/auth/login", null, { email, password: "TestPass#2026" })).json.data.access_token; };
  const botIds = [];
  try {
    const admin = await mk("zz.s.admin@local.test", { is_super_admin: true });
    const central = await mk("zz.s.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    const pp01 = await W.findOne({ code: "PP01" }).lean(); const wh01 = await W.findOne({ code: "WH01" }).lean();
    const shop = await mk("zz.s.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [pp01._id] });
    const BOT = (await call("POST", "/telegram/bot", admin, { name: "ZZ", token: GOOD })).json.data._id; botIds.push(BOT);
    const C1 = (await call("POST", "/telegram/chat", admin, { bot_id: BOT, chat_id: "-100111", title: "ZZ All", language: "both", event_codes: [] })).json.data._id;
    const C2 = (await call("POST", "/telegram/chat", admin, { bot_id: BOT, chat_id: "-100222", title: "ZZ PP01", language: "kh", event_codes: [], warehouse_ids: [pp01._id] })).json.data._id;
    let r = await call("GET", "/telegram/targets", central);
    check("central: targets list chats + reports", r.status === 200 && r.json.data.chats.length >= 2 && r.json.data.reports.length === 6 && !JSON.stringify(r.json).includes("token"), r.status);
    r = await call("GET", "/telegram/targets", shop);
    check("shop manager: targets → 403", r.status === 403, r.status);
    r = await call("GET", `/telegram/report/preview?code=low_stock&language=en&warehouse_ids=${pp01._id}`, central);
    check("central: preview low stock shows item names + SKU", r.status === 200 && /• .+ <code>[A-Z0-9-]+<\/code>: <b>\d+<\/b> \/ \d+/.test(r.json.data.text), r.json.data?.text?.slice(0, 300));
    console.log(r.json.data.text.split("\n").slice(0, 5).join("\n"));
    const diapers = await Cat.findOne({ name_en: /diaper/i }).lean();
    if (diapers) { r = await call("GET", `/telegram/report/preview?code=low_stock&language=en&warehouse_ids=${pp01._id}&category_id=${diapers._id}`, central);
      check("category filter: only diaper SKUs", r.status === 200 && !/ROMPER|TSHIRT|BOTTLE/.test(r.json.data.text), r.json.data.text.slice(0, 200)); }
    r = await call("POST", "/telegram/send", central, { chat_ids: [], report_codes: ["low_stock"] });
    check("send without chats → 400", r.status === 400, r.json.message);
    r = await call("POST", "/telegram/send", central, { chat_ids: [C1] });
    check("send nothing → 400", r.status === 400, r.json.message);
    sent.length = 0;
    r = await call("POST", "/telegram/send", central, { chat_ids: [C1, C2], report_codes: ["low_stock"], text: "Please check <diapers> & wipes" });
    check("one click: 2 chats × (message + report) sent now", r.status === 200 && r.json.data.sent === r.json.data.queued && r.json.data.queued >= 4 && sent.length === r.json.data.queued, JSON.stringify(r.json));
    const msg = sent.find((s) => s.text.startsWith("✉️"));
    check("own message escaped + sender name", msg && msg.text.includes("&lt;diapers&gt; &amp; wipes") && msg.text.includes("Zz Sender"), msg?.text);
    const kh = sent.filter((s) => s.chat_id === "-100222" && s.text.includes("📊"));
    check("PP01 chat (Khmer, no warehouse given) → only PP01 lines, Khmer only", kh.length && kh.every((s) => s.text.includes("PP01") && !s.text.includes("WH01") && !/Low stock/.test(s.text)), kh[0]?.text.slice(0, 200));
    check("parse_mode HTML", sent.every((s) => s.parse_mode === "HTML"));
    sent.length = 0;
    r = await call("POST", "/telegram/send", central, { chat_ids: [C1], report_codes: ["near_expiry", "pending_work"], warehouse_ids: [wh01._id, pp01._id] });
    check("near expiry + pending work for chosen warehouses", r.status === 200 && r.json.data.sent >= 2, JSON.stringify(r.json));
    const parts = svc.splitText(Array.from({ length: 400 }, (_, i) => `• line ${i} ${"x".repeat(30)}`).join("\n"));
    check("long text split ≤ 3800 per part, no line lost", parts.length > 1 && parts.every((p) => p.length <= 3800) && parts.join("\n").split("\n").length === 400, parts.map((p) => p.length).join(","));
    const logs = await T.TelegramMessageModel.find({ bot_id: BOT, kind: "message" }).countDocuments();
    check("message log has kind=message", logs === 2, logs);
  } catch (e) { console.log("ERR", e); } finally {
    await T.TelegramMessageModel.deleteMany({ bot_id: { $in: botIds } }); await T.TelegramChatModel.deleteMany({ bot_id: { $in: botIds } }); await T.TelegramBotModel.deleteMany({ _id: { $in: botIds } });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    const left = (await T.TelegramBotModel.countDocuments({ username: "zz_test_bot" })) + (await User.countDocuments({ email: /@local\.test$/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); fake.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
