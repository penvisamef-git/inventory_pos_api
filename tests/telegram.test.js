// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test");
const http = require("http");
// ---------- fake Telegram ----------
const sent = []; let flaky = 0;
const GOOD = "123456789:AAEzzTestTokenForFakeTelegramServer0001";
const fake = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)/); const token = m?.[1]; const method = m?.[2]; const p = body ? JSON.parse(body) : {};
    const send = (code, j) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (token !== GOOD) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
    if (method === "getMe") return send(200, { ok: true, result: { id: 777000, is_bot: true, first_name: "ZZ Test", username: "zz_test_bot", can_join_groups: true } });
    if (method === "getUpdates") return send(200, { ok: true, result: [
      { update_id: 1, message: { chat: { id: -100111, title: "ZZ Central", type: "supergroup" }, text: "hi" } },
      { update_id: 2, message: { chat: { id: -100222, title: "ZZ Shop 1", type: "group" }, text: "hi" } },
      { update_id: 3, message: { chat: { id: -100222, title: "ZZ Shop 1", type: "group" }, text: "again" } } ] });
    if (method === "sendMessage") {
      if (p.chat_id === "-100999") return send(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
      if (p.chat_id === "-100333" && flaky++ === 0) return send(502, { ok: false, error_code: 502, description: "Bad Gateway" });
      sent.push(p); return send(200, { ok: true, result: { message_id: sent.length } });
    }
    send(404, { ok: false, description: "no method" });
  });
});
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const M = (p) => require(API + "/src/v1/admin/" + p);
const results = []; const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  const app = require(API + "/index.js");
  const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model");
  const W = M("setup/warehouse/warehouse.model"), Variant = M("product/item/variant.model");
  const Movement = M("stock/movement.model"); const { StockBalanceModel: Bal, StockBatchBalanceModel: BBal } = M("stock/balance.model");
  const Opening = M("stock/opening/opening.model"), Adj = M("stock/adjustment/adjustment.model"), Tr = M("stock/transfer/transfer.model"), Counter = M("counter/counter.model");
  const T = M("telegram/telegram.model"); const svc = M("telegram/telegram.service");
  const { ROLES } = require(API + "/src/util/user_roles");
  while (mongoose.connection.readyState !== 1) await wait(300);
  const counters = await Counter.find({}).lean();
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "U", email, password: await bcrypt.hash("TestPass#2026", 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return (await call("POST", "/auth/login", null, { email, password: "TestPass#2026" })).json.data.access_token; };
  const botIds = [];
  try {
    const admin = await mk("zz.tg.admin@local.test", { is_super_admin: true });
    let r = await call("POST", "/setup/warehouse", admin, { code: "ZZC", name_kh: "តេស្តកណ្តាល", type: "central" }); const C = r.json.data._id;
    r = await call("POST", "/setup/warehouse", admin, { code: "ZZS1", name_kh: "តេស្តហាង១", type: "shop" }); const S1 = r.json.data._id;
    const shop = await mk("zz.tg.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [S1] });
    const central = await mk("zz.tg.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });

    // ---------- bots ----------
    r = await call("POST", "/telegram/bot", admin, { name: "x", token: "abc" });
    check("bot bad token format → 400", r.status === 400, r.json.message);
    r = await call("POST", "/telegram/bot", admin, { name: "x", token: "123456789:AAEzzTestTokenRejectedByTelegram999999" });
    check("token rejected by Telegram → 400", r.status === 400 && /Unauthorized/.test(r.json.message), r.json.message);
    r = await call("POST", "/telegram/bot", central, { name: "x", token: GOOD });
    check("central manager → 403 (admin only)", r.status === 403, r.status);
    r = await call("POST", "/telegram/bot", admin, { name: "ZZ Bot", token: GOOD });
    const BOT = r.json.data?._id; if (BOT) botIds.push(BOT);
    check("bot created: @username from getMe, token hidden", r.status === 201 && r.json.data.username === "zz_test_bot" && !r.json.data.token_enc && r.json.data.token_hint.includes("••••"), JSON.stringify(r.json).slice(0, 250));
    const stored = await T.TelegramBotModel.findById(BOT).select("+token_enc").lean();
    check("token stored encrypted", stored.token_enc.startsWith("v1:") && !stored.token_enc.includes("AAEzz"), stored.token_enc.slice(0, 20));
    r = await call("POST", "/telegram/bot", admin, { name: "dup", token: GOOD });
    check("same bot again → 409", r.status === 409, r.status);
    r = await call("POST", "/telegram/bot/test/" + BOT, admin);
    check("test bot → ok", r.status === 200 && r.json.data.username === "zz_test_bot", r.json.message);
    r = await call("GET", "/telegram/bot/chats/" + BOT, admin);
    check("find chats → 2 unique chats", r.status === 200 && r.json.data.length === 2 && r.json.data[0].chat_id === "-100111", JSON.stringify(r.json.data));

    // ---------- chats ----------
    const stockEvents = ["transfer_requested", "transfer_dispatched", "transfer_received", "transfer_shortage", "adjustment_waiting", "adjustment_posted", "goods_received", "staff_changed", "price_changed"];
    r = await call("POST", "/telegram/chat", admin, { bot_id: BOT, chat_id: "abc", title: "x" });
    check("bad chat id → 400", r.status === 400, r.json.message);
    r = await call("POST", "/telegram/chat", admin, { bot_id: BOT, chat_id: "-100111", title: "ZZ Central", type: "supergroup", language: "both", event_codes: stockEvents, warehouse_ids: [] });
    const CH1 = r.json.data?._id;
    check("central chat (all warehouses, both languages) → 201", r.status === 201 && r.json.data.event_codes.length === stockEvents.length, r.json.message);
    r = await call("POST", "/telegram/chat", admin, { bot_id: BOT, chat_id: "-100222", title: "ZZ Shop 1", language: "kh", event_codes: ["transfer_dispatched", "transfer_shortage", "adjustment_posted", "bogus"], warehouse_ids: [S1] });
    const CH2 = r.json.data?._id;
    check("shop chat (ZZS1 only, Khmer, unknown event dropped) → 201", r.status === 201 && r.json.data.event_codes.length === 3 && r.json.data.warehouse_ids[0].code === "ZZS1", JSON.stringify(r.json.data?.event_codes));
    r = await call("POST", "/telegram/chat", admin, { bot_id: BOT, chat_id: "-100222", title: "dup" });
    check("same chat + bot again → 409", r.status === 409, r.status);
    r = await call("POST", "/telegram/chat", admin, { bot_id: BOT, chat_id: "-100999", title: "ZZ Gone", event_codes: ["transfer_dispatched"] });
    const CH3 = r.json.data?._id;
    r = await call("POST", "/telegram/chat", admin, { bot_id: BOT, chat_id: "-100333", title: "ZZ Flaky", event_codes: ["transfer_dispatched"], language: "en" });
    r = await call("POST", "/telegram/chat/test/" + CH1, admin);
    check("test message → sent", r.status === 200 && sent.length === 1 && /Test message/.test(sent[0].text) && /សារសាកល្បង/.test(sent[0].text), JSON.stringify(sent[0]).slice(0, 120));

    // ---------- events from real stock actions ----------
    const v = await Variant.findOne({ code: "ROMPER01-NB-WHITE" });
    r = await call("POST", "/stock/opening", admin, { warehouse_id: C, items: [{ variant_id: v._id, qty: 20, unit_cost: 3 }] });
    await call("PUT", "/stock/opening/post/" + r.json.data._id, admin);
    r = await call("POST", "/stock/transfer", shop, { warehouse_id: C, to_warehouse_id: S1, items: [{ variant_id: v._id, qty: 5 }] });
    const TR = r.json.data._id;
    await call("PUT", "/stock/transfer/dispatch/" + TR, admin);
    const line = (await Tr.findById(TR)).items[0]._id;
    await call("PUT", "/stock/transfer/receive/" + TR, shop, { items: [{ _id: line, received_qty: 4 }], note: "1 missing" });
    r = await call("POST", "/stock/adjustment", shop, { warehouse_id: S1, reason: "damaged", items: [{ variant_id: v._id, qty: 1 }] });
    await call("PUT", "/stock/adjustment/post/" + r.json.data._id, admin);
    await wait(1500);
    const q = await T.TelegramMessageModel.find({ bot_id: BOT, kind: "event" }).lean();
    const codes = (chat) => q.filter((m) => String(m.chat_ref) === String(chat)).map((m) => m.code).sort();
    check("central chat got request, dispatch, receive, shortage, waiting, posted", JSON.stringify(codes(CH1)) === JSON.stringify(["adjustment_posted", "adjustment_waiting", "transfer_dispatched", "transfer_received", "transfer_requested", "transfer_shortage"]), JSON.stringify(codes(CH1)));
    check("shop chat got only its 3 ticked events", JSON.stringify(codes(CH2)) === JSON.stringify(["adjustment_posted", "transfer_dispatched", "transfer_shortage"]), JSON.stringify(codes(CH2)));
    const short1 = q.find((m) => String(m.chat_ref) === String(CH1) && m.code === "transfer_shortage");
    check("shortage text: both languages + item line + loss", /ខ្វះស្តុក/.test(short1.text) && /Shortage/.test(short1.text) && /ROMPER01-NB-WHITE × 1/.test(short1.text) && /\$3\.00/.test(short1.text), short1.text);
    const shopMsg = q.find((m) => String(m.chat_ref) === String(CH2) && m.code === "transfer_dispatched");
    check("shop chat text is Khmer only", /កំពុងដឹក/.test(shopMsg.text) && !/on the way/.test(shopMsg.text), shopMsg.text);

    // ---------- sending ----------
    let s = await svc.sendPending(50);
    const failed = await T.TelegramMessageModel.findOne({ chat_id: "-100999" });
    const flakyMsg = await T.TelegramMessageModel.findOne({ chat_id: "-100333" });
    check("worker sent the good ones", s.sent >= 9 && (await T.TelegramMessageModel.countDocuments({ bot_id: BOT, state: "sent" })) >= 10, JSON.stringify(s));
    check("chat not found → failed at once (no retry)", failed.state === "failed" && failed.attempts === 1 && /chat not found/.test(failed.last_error), JSON.stringify(failed));
    check("Telegram 502 → retry later", flakyMsg.state === "pending" && flakyMsg.attempts === 1 && flakyMsg.next_try_at > new Date(), JSON.stringify(flakyMsg));
    await T.TelegramMessageModel.updateOne({ _id: flakyMsg._id }, { next_try_at: new Date(Date.now() - 1000) });
    await svc.sendPending(10);
    check("retry succeeds", (await T.TelegramMessageModel.findById(flakyMsg._id)).state === "sent", "");
    check("HTML parse mode used", sent.every((x) => x.parse_mode === "HTML"), "");

    // ---------- templates ----------
    r = await call("GET", "/telegram/template", admin);
    check("templates list with defaults + placeholders", r.json.data?.length >= 13 && r.json.data.find((t) => t.code === "transfer_dispatched").placeholders.includes("doc_no"), r.json.data?.length);
    r = await call("PUT", "/telegram/template/transfer_dispatched", admin, { template_kh: "ផ្ទេរ {doc_no} <b>ហើយ</b>", template_en: "Sent {doc_no}" });
    await svc.notify("transfer_dispatched", { warehouse_ids: [S1], data: { doc_no: "TR-<x>" } });
    const custom = await T.TelegramMessageModel.findOne({ chat_ref: CH2, code: "transfer_dispatched" }).sort({ created_date: -1 });
    check("custom template used + values escaped", custom.text === "ផ្ទេរ TR-&lt;x&gt; <b>ហើយ</b>", custom.text);
    r = await call("DELETE", "/telegram/template/transfer_dispatched", admin);
    check("reset template → default", /កំពុងដឹក/.test(r.json.data.kh), JSON.stringify(r.json.data));
    r = await call("POST", "/telegram/template/preview", admin, { template_kh: "{doc_no} {items}", template_en: "{unknown}" });
    check("preview fills sample data", r.json.data.kh.startsWith("TR-2610-0001 • DIAPANT01-M") && r.json.data.en === "-", JSON.stringify(r.json.data));

    // ---------- reports ----------
    r = await call("GET", `/telegram/report/preview?code=stock_summary&warehouse_ids=${C},${S1}`, admin);
    check("stock summary preview lists ZZC + ZZS1", /ZZC/.test(r.json.data?.text) && /ZZS1/.test(r.json.data.text) && /Stock summary/.test(r.json.data.text), r.json.data?.text);
    r = await call("GET", `/telegram/report/preview?code=pending_work&warehouse_ids=${S1}`, admin);
    check("pending work preview", /In transit: 0/.test(r.json.data?.text), r.json.data?.text);
    const nowParts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const hhmm = `${nowParts.hour}:${nowParts.minute}`; const today = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(nowParts.weekday);
    r = await call("POST", "/telegram/schedule", admin, { name: "ZZ morning", chat_ids: [CH2], report_codes: ["low_stock", "near_expiry"], times: ["25:00"] });
    check("bad time → 400", r.status === 400, r.json.message);
    r = await call("POST", "/telegram/schedule", admin, { name: "ZZ now", chat_ids: [CH2], report_codes: ["stock_summary", "pending_work"], times: [hhmm, "23:59"], days: [today] });
    const SCH = r.json.data?._id;
    check("schedule created", r.status === 201 && r.json.data.times.includes(hhmm), r.json.message);
    let run1 = await svc.runSchedules(new Date());
    let run2 = await svc.runSchedules(new Date());
    check("schedule fires once this minute (2 reports → shop chat)", run1.queued >= 2 && run2.queued === 0, JSON.stringify([run1, run2]));
    const rep = await T.TelegramMessageModel.findOne({ chat_ref: CH2, kind: "report", code: "stock_summary" }).sort({ created_date: -1 });
    check("report uses the chat's warehouse (ZZS1) and Khmer", /ZZS1/.test(rep.text) && !/ZZC/.test(rep.text) && /សង្ខេបស្តុក/.test(rep.text) && !/Stock summary/.test(rep.text), rep.text);
    r = await call("POST", "/telegram/schedule/send/" + SCH, admin);
    check("Send now → queued + sent", r.status === 200 && r.json.data.queued === 2 && r.json.data.sent >= 2, JSON.stringify(r.json));

    // ---------- log / retry / delete ----------
    r = await call("GET", "/telegram/message?state=failed", admin);
    check("message log filter failed + counts", r.json.data?.length >= 1 && r.json.counts.failed >= 1 && r.json.data[0].chat_ref?.title, JSON.stringify(r.json.counts));
    r = await call("PUT", "/telegram/message/retry/" + failed._id, admin);
    check("retry failed → tried again (still chat not found)", r.status === 200 && r.json.data.state === "failed", r.json.data?.state);
    r = await call("DELETE", "/telegram/bot/" + BOT, admin);
    check("delete bot with chats → 400", r.status === 400, r.json.message);
    r = await call("DELETE", "/telegram/chat/" + CH3, admin);
    check("delete chat → 200", r.status === 200, r.json.message);
  } catch (e) { console.error("ERROR", e); results.push(false); }
  finally {
    const ws = (await W.find({ code: /^ZZ/ }).select("_id")).map((x) => x._id);
    await Movement.deleteMany({ warehouse_id: { $in: ws } }); await Bal.deleteMany({ warehouse_id: { $in: ws } }); await BBal.deleteMany({ warehouse_id: { $in: ws } });
    for (const Mdl of [Opening, Adj]) await Mdl.deleteMany({ warehouse_id: { $in: ws } });
    await Tr.deleteMany({ $or: [{ warehouse_id: { $in: ws } }, { to_warehouse_id: { $in: ws } }] }); await W.deleteMany({ _id: { $in: ws } });
    await T.TelegramMessageModel.deleteMany({ bot_id: { $in: botIds } }); await T.TelegramChatModel.deleteMany({ bot_id: { $in: botIds } });
    await T.TelegramScheduleModel.deleteMany({ name: /^ZZ/ }); await T.TelegramBotModel.deleteMany({ _id: { $in: botIds } }); await T.TelegramTemplateModel.deleteMany({ updated_by: { $in: ids } });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    await Counter.deleteMany({ key: { $nin: counters.map((c) => c.key) } }); for (const c of counters) await Counter.updateOne({ _id: c._id }, { seq: c.seq });
    const left = (await T.TelegramBotModel.countDocuments({ username: "zz_test_bot" })) + (await W.countDocuments({ code: /^ZZ/ })) + (await User.countDocuments({ email: /@local\.test$/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); fake.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
