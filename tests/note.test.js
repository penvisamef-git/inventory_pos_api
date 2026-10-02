// Integration test against the test database (UAT) — run all with: npm test
// Notes: own notes only; super admin sees / edits / deletes all; nothing in the activity log.
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const M = (p) => require(API + "/src/v1/admin/" + p);
const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model"), Note = M("note/note.model");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "U", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return { id, t: (await call("POST", "/auth/login", null, { email, password: PASS })).json.data.access_token }; };
  try {
    const sup = await mk("zz.n.super@local.test", { is_super_admin: true });
    const adm = await mk("zz.n.admin@local.test", { role: ROLES.ADMIN.value });
    const shop = await mk("zz.n.shop@local.test", { role: ROLES.SHOP_MANAGER.value });
    const logsBefore = await ActivityLog.countDocuments({ create_by_id: { $in: ids } });

    let r = await call("POST", "/note", shop.t, { title: "", body: "   " });
    check("empty note → 400", r.status === 400, r.status);
    r = await call("POST", "/note", shop.t, { title: "ZZ shopping", body: "milk\ndiapers", color: "yellow" });
    const N1 = r.json.data?._id;
    check("shop manager creates a note → 201, own", r.status === 201 && String(r.json.data.user_id._id) === String(shop.id) && r.json.data.color === "yellow", r.status + JSON.stringify(r.json).slice(0, 200));
    r = await call("POST", "/note", shop.t, { title: "ZZ older", body: "x" });
    const N2 = r.json.data?._id;
    r = await call("POST", "/note", adm.t, { title: "ZZ admin secret", body: "only mine" });
    const N3 = r.json.data?._id;
    r = await call("POST", "/note", shop.t, { title: "ZZ bad", color: "rainbow" });
    check("bad colour → 400", r.status === 400, r.status);

    r = await call("PUT", "/note/" + N1, shop.t, { pinned: true });
    r = await call("GET", "/note", shop.t);
    check("list: only own notes, pinned first", r.status === 200 && r.json.scope === "own" && r.json.data.length === 2 && r.json.data[0]._id === N1 && r.json.data.every((n) => String(n.user_id._id) === String(shop.id)), JSON.stringify(r.json.data?.map((n) => n.title)));
    r = await call("GET", "/note?q=diapers", shop.t);
    check("search in the text", r.json.data.length === 1 && r.json.data[0]._id === N1);

    r = await call("GET", "/note", adm.t);
    check("admin (not super) sees only own notes", r.json.scope === "own" && r.json.data.length === 1 && r.json.data[0]._id === N3);
    r = await call("GET", "/note/" + N1, adm.t);
    check("admin cannot open someone else's note (404)", r.status === 404, r.status);
    r = await call("PUT", "/note/" + N1, adm.t, { title: "hacked" });
    check("…nor edit it (404)", r.status === 404 && (await Note.findById(N1)).title === "ZZ shopping", r.status);
    r = await call("DELETE", "/note/" + N1, adm.t);
    check("…nor delete it (404)", r.status === 404, r.status);

    r = await call("GET", "/note?limit=200", sup.t);
    const mine = (r.json.data || []).filter((n) => [N1, N2, N3].includes(n._id));
    check("super admin sees everyone's notes with the owner", r.json.scope === "all" && mine.length === 3 && mine.every((n) => n.user_id?.email), mine.length);
    r = await call("GET", `/note?user_id=${shop.id}`, sup.t);
    check("super admin: filter by owner", r.json.data.length === 2);
    r = await call("GET", "/note/owners", sup.t);
    check("super admin: owners list with counts", r.status === 200 && r.json.data.some((u) => u.email === "zz.n.shop@local.test" && u.count === 2));
    r = await call("GET", "/note/owners", adm.t);
    check("owners list is super admin only (403)", r.status === 403, r.status);
    r = await call("PUT", "/note/" + N1, sup.t, { body: "milk\ndiapers\nwipes" });
    check("super admin edits a shop manager's note (owner kept)", r.status === 200 && r.json.data.body.includes("wipes") && String(r.json.data.user_id._id) === String(shop.id));
    r = await call("DELETE", "/note/" + N2, sup.t);
    check("super admin deletes it", r.status === 200 && (await call("GET", "/note/" + N2, shop.t)).status === 404);

    r = await call("DELETE", "/note/" + N3, adm.t);
    check("owner deletes own note", r.status === 200 && (await call("GET", "/note", adm.t)).json.data.length === 0);
    check("notes are private: no activity log rows", (await ActivityLog.countDocuments({ create_by_id: { $in: ids }, title: /កំណត់ចំណាំ|note/i })) === 0 && (await ActivityLog.countDocuments({ create_by_id: { $in: ids } })) - logsBefore === 0);
  } catch (e) { console.log("ERR", e); } finally {
    await Note.deleteMany({ user_id: { $in: ids } });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    const left = (await User.countDocuments({ email: /^zz\.n\./ })) + (await Note.countDocuments({ title: /^ZZ/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
