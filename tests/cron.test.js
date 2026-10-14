// Integration test against the test database (UAT) — run all with: npm test
// /api/cron/tick (Vercel scheduler): key check, schedules looking back 15 min, once per slot
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
process.env.CRON_SECRET = "zz-test-cron-secret";
const mongoose = require(API + "/node_modules/mongoose"); const app = require(API + "/index.js");
const { TelegramScheduleModel: Sched } = require(API + "/src/v1/admin/telegram/telegram.model");
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const hhmm = (d) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(/^24/, "00");
(async () => { while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}`;
  const c = async (h = {}, q = "") => { const r = await fetch(b + "/api/cron/tick" + q, { headers: h }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const uid = new mongoose.Types.ObjectId();
  try {
    let r = await c();
    check("no key → 401", r.status === 401, r.status);
    r = await c({ "x-cron-key": "wrong-key-wrong-key-x" });
    check("wrong key → 401", r.status === 401, r.status);
    // a schedule 6 minutes ago (the pinger was late) → runs once
    const t6 = hhmm(new Date(Date.now() - 6 * 60000));
    const sc = await Sched.create({ name: "ZZ cron test", chat_ids: [], report_codes: [], times: [t6], days: [0, 1, 2, 3, 4, 5, 6], created_by: uid, updated_by: uid });
    r = await c({ "x-cron-key": "zz-test-cron-secret" });
    const after = await Sched.findById(sc._id).lean();
    check("right key → 200 + the 6-min-old schedule ran", r.status === 200 && after.last_run_key.endsWith(t6) && r.json.data.schedules.due >= 1, JSON.stringify(r.json).slice(0, 300));
    r = await c({}, "?key=zz-test-cron-secret");
    const again = await Sched.findById(sc._id).lean();
    check("next tick (?key=) → not again", r.status === 200 && again.last_run_at.getTime() === after.last_run_at.getTime(), JSON.stringify(r.json).slice(0, 200));
    // 20 minutes ago → outside the window, skipped
    await Sched.updateOne({ _id: sc._id }, { times: [hhmm(new Date(Date.now() - 20 * 60000))], last_run_key: "" });
    await c({ "x-cron-key": "zz-test-cron-secret" });
    check("older than 15 min → skipped", (await Sched.findById(sc._id).lean()).last_run_key === "");
  } finally {
    await Sched.deleteMany({ name: /^ZZ cron/ });
    console.log(`${R.filter(Boolean).length}/${R.length} passed · left: ${await Sched.countDocuments({ name: /^ZZ cron/ })}`);
    s.close(); await mongoose.connection.close(); process.exit(0); }
})();
