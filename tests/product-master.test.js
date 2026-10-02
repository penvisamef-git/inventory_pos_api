// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test");
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const User = require(API + "/src/v1/admin/user/user.model"); const Session = require(API + "/src/v1/admin/session/session.model");
const ActivityLog = require(API + "/src/v1/admin/activity_log/activity_log.model");
const Unit = require(API + "/src/v1/admin/product/unit/unit.model");
const Category = require(API + "/src/v1/admin/product/category/category.model");
const Attribute = require(API + "/src/v1/admin/product/attribute/attribute.model");
const Warehouse = require(API + "/src/v1/admin/setup/warehouse/warehouse.model");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "U", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return (await call("POST", "/auth/login", null, { email, password: PASS })).json.data.access_token; };
  try {
    const admin = await mk("zz.p.admin@local.test", { is_super_admin: true });
    const central = await mk("zz.p.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    const pp01 = (await Warehouse.findOne({ code: "PP01" }))._id;
    const shop = await mk("zz.p.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [pp01] });

    // ---------- Unit ----------
    let r = await call("POST", "/product/unit", central, { code: "ZZ Box!", name_kh: "x" });
    check("unit bad code → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/unit", central, { code: "ZZBOX", name_kh: "ប្រអប់តេស្ត", name_en: "Test box" });
    check("unit create by central manager → 201 lowercased", r.status === 201 && r.json.data.code === "zzbox", r.json.message); const u1 = r.json.data?._id;
    r = await call("POST", "/product/unit", central, { code: "zzbox", name_kh: "x" });
    check("unit duplicate → 409", r.status === 409, r.status);
    r = await call("POST", "/product/unit", central, { code: "zzbox2" });
    check("unit missing name → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/unit", shop, { code: "zzbox3", name_kh: "x" });
    check("unit create by shop manager → 403", r.status === 403, r.status);
    r = await call("GET", "/product/unit-all", shop);
    check("unit -all visible to shop manager (sample pcs there)", r.status === 200 && r.json.data.some((u) => u.code === "pcs"), r.status);
    r = await call("PUT", "/product/unit/" + u1, central, { name_en: "Test Box 2", _id: "x", created_by: "x" });
    check("unit update → 200 (protected fields ignored)", r.status === 200 && r.json.data.name_en === "Test Box 2", r.json.message);
    r = await call("PUT", "/product/unit/" + u1, central, { code: "pcs" });
    check("unit update to existing code → 409", r.status === 409, r.status);
    r = await call("DELETE", "/product/unit/" + u1, central);
    check("unit delete → 200", r.status === 200, r.json.message);
    r = await call("PUT", "/product/unit/restore/" + u1, central);
    check("unit restore → 200", r.status === 200, r.json.message);

    // ---------- Category ----------
    r = await call("POST", "/product/category", admin, { code: "zz_parent", name_kh: "មេតេស្ត" });
    check("category root → 201 parent null", r.status === 201 && r.json.data.parent_id === null, r.json.message); const c1 = r.json.data?._id;
    r = await call("POST", "/product/category", admin, { code: "zz_child", name_kh: "កូនតេស្ត", parent_id: c1 });
    check("category child → 201", r.status === 201, r.json.message); const c2 = r.json.data?._id;
    r = await call("POST", "/product/category", admin, { code: "zz_grand", name_kh: "ចៅតេស្ត", parent_id: c2 });
    const c3 = r.json.data?._id;
    r = await call("POST", "/product/category", admin, { code: "zz_bad", name_kh: "x", parent_id: "65f000000000000000000099" });
    check("category unknown parent → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/product/category/" + c1, admin, { parent_id: c3 });
    check("category loop (root under grandchild) → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/product/category/" + c1, admin, { parent_id: c1 });
    check("category under itself → 400", r.status === 400, r.json.message);
    r = await call("GET", "/product/category?parent_id=" + c1, admin);
    check("list ?parent_id → child with child_count 1", r.json.data?.length === 1 && r.json.data[0].child_count === 1 && r.json.data[0].parent_id?.code === "zz_parent", JSON.stringify(r.json.data?.[0]).slice(0, 160));
    r = await call("GET", "/product/category-tree", shop);
    const zz = (r.json.data || []).find((n) => n.code === "zz_parent");
    check("tree → nested 3 levels", zz && zz.children[0]?.code === "zz_child" && zz.children[0].children[0]?.code === "zz_grand", JSON.stringify(zz).slice(0, 150));
    check("tree has sample categories", (r.json.data || []).some((n) => n.code === "clothing" && n.children.length === 5), "");
    r = await call("DELETE", "/product/category/" + c2, admin);
    check("delete category with children → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/product/category/" + c3, admin, { parent_id: null });
    check("move grandchild to root (null) → 200", r.status === 200 && r.json.data.parent_id === null, JSON.stringify(r.json.data?.parent_id));
    r = await call("DELETE", "/product/category/" + c2, admin);
    check("delete now-empty child → 200", r.status === 200, r.json.message);

    // ---------- Attribute ----------
    r = await call("POST", "/product/attribute", central, { code: "zz_size", name_kh: "ទំហំតេស្ត", type: "weight" });
    check("attribute bad type → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/attribute", central, { code: "zz_size", name_kh: "ទំហំតេស្ត", type: "size", values: [{ code: "S", name_kh: "S" }, { code: "s", name_kh: "x" }] });
    check("attribute duplicate value codes → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/attribute", central, { code: "zz_color", name_kh: "ពណ៌តេស្ត", type: "color", values: [{ code: "red", name_kh: "ក្រហម", color_hex: "red" }] });
    check("attribute bad hex → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/attribute", central, { code: "zz_size", name_kh: "ទំហំតេស្ត", type: "size", values: [{ code: "6-12M", name_kh: "6-12 ខែ", name_en: "6-12M" }, { code: "s", name_kh: "S" }] });
    check("attribute create → 201, value codes lowercased + _id", r.status === 201 && r.json.data.values[0].code === "6-12m" && r.json.data.values[0]._id, JSON.stringify(r.json).slice(0, 200));
    const a1 = r.json.data?._id; const keepId = r.json.data?.values?.[0]?._id;
    r = await call("PUT", "/product/attribute/" + a1, central, { values: [{ _id: keepId, code: "6-12m", name_kh: "6-12 ខែ", name_en: "6–12 months" }, { code: "m", name_kh: "M" }] });
    check("attribute update keeps value _id", r.status === 200 && r.json.data.values[0]._id === keepId && r.json.data.values.length === 2 && r.json.data.values[0].name_en === "6–12 months", JSON.stringify(r.json).slice(0, 200));
    r = await call("GET", "/product/attribute-all?type=color", shop);
    check("attribute -all ?type=color → sample color with 6 values", r.json.data?.length >= 1 && r.json.data.find((a) => a.code === "color")?.values.length === 6, JSON.stringify(r.json.data?.map((a) => a.code)));
  } catch (e) { console.error("ERROR", e); results.push(false); }
  finally {
    await Unit.deleteMany({ code: /^zz/ }); await Category.deleteMany({ code: /^zz_/ }); await Attribute.deleteMany({ code: /^zz_/ });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    const left = (await Unit.countDocuments({ code: /^zz/ })) + (await Category.countDocuments({ code: /^zz_/ })) + (await Attribute.countDocuments({ code: /^zz_/ })) + (await User.countDocuments({ email: /@local\.test$/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
