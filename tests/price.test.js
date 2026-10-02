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
const Product = require(API + "/src/v1/admin/product/item/product.model");
const Variant = require(API + "/src/v1/admin/product/item/variant.model");
const Price = require(API + "/src/v1/admin/product/price/price.model");
const Warehouse = require(API + "/src/v1/admin/setup/warehouse/warehouse.model");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "U", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return (await call("POST", "/auth/login", null, { email, password: PASS })).json.data.access_token; };
  let productId;
  try {
    const central = await mk("zz.pr.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    const pp01 = (await Warehouse.findOne({ code: "PP01" }))._id; const pp02 = (await Warehouse.findOne({ code: "PP02" }))._id; const wh01 = (await Warehouse.findOne({ code: "WH01" }))._id;
    const shop1 = await mk("zz.pr.shop1@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [pp01] });
    const pack = (await Unit.findOne({ code: "pack" }))._id; const box = (await Unit.findOne({ code: "box" }))._id; const set = (await Unit.findOne({ code: "set" }))._id;
    const cat = await Category.findOne({ code: "diapers_pants" }); const ds = await Attribute.findOne({ code: "diaper_size" });
    let r = await call("POST", "/product/item", central, { code: "ZZ-PRICE", name_kh: "តេស្តតម្លៃ", category_id: cat._id, base_unit_id: pack, units: [{ unit_id: box, factor: 4 }, { unit_id: set, factor: 2, is_sale_unit: false }], attribute_ids: [ds._id],
      variants: ds.values.slice(0, 2).map((v) => ({ options: [{ attribute_id: ds._id, value_id: v._id }] })) });
    productId = r.json.data._id; const [vM, vL] = r.json.data.variants.map((v) => v._id);

    // ---------- create ----------
    r = await call("POST", "/product/price", central, { variant_id: vM, price: 12.5 });
    check("default price, base unit by default, starts now → 201", r.status === 201 && r.json.data.unit_id.code === "pack" && r.json.data.warehouse_id === null && r.json.data.effective_to === null, JSON.stringify(r.json).slice(0, 200));
    const p1 = r.json.data._id;
    r = await call("POST", "/product/price", central, { variant_id: vM, unit_id: set, price: 20 });
    check("non-sale unit → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/price", central, { variant_id: vM, unit_id: (await Unit.findOne({ code: "can" }))._id, price: 20 });
    check("unit not on product → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/price", central, { variant_id: vM, price: -1 });
    check("negative price → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/price", central, { variant_id: vM, price: null });
    check("default price null → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/price", central, { variant_id: vM, warehouse_id: wh01, price: 10 });
    check("override for central warehouse → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/price", shop1, { variant_id: vM, price: 10 });
    check("shop manager set price → 403", r.status === 403, r.status);

    // ---------- history chain ----------
    r = await call("POST", "/product/price", central, { variant_id: vM, price: 13, effective_from: days(10) });
    const p3 = r.json.data?._id;
    check("upcoming price (+10d) → 201 open-ended", r.status === 201 && r.json.data.effective_to === null, JSON.stringify(r.json).slice(0, 200));
    let p1doc = await Price.findById(p1);
    check("current row closed at +10d", p1doc.effective_to && Math.abs(new Date(p1doc.effective_to) - new Date(days(10))) < 5000, String(p1doc.effective_to));
    r = await call("POST", "/product/price", central, { variant_id: vM, price: 12.75, effective_from: days(5) });
    const p2 = r.json.data?._id;
    check("insert between (+5d) → ends at +10d", r.status === 201 && Math.abs(new Date(r.json.data.effective_to) - new Date(days(10))) < 5000, JSON.stringify(r.json.data?.effective_to));
    p1doc = await Price.findById(p1);
    check("current row now closed at +5d", Math.abs(new Date(p1doc.effective_to) - new Date(days(5))) < 5000, String(p1doc.effective_to));
    r = await call("POST", "/product/price", central, { variant_id: vM, price: 99, effective_from: (await Price.findById(p2)).effective_from });
    check("same start time → 409", r.status === 409, r.status);
    r = await call("DELETE", "/product/price/" + p1, central);
    check("delete started price → 400", r.status === 400, r.json.message);
    r = await call("DELETE", "/product/price/" + p2, central);
    p1doc = await Price.findById(p1);
    check("delete upcoming (+5d) → previous row extends to +10d", r.status === 200 && Math.abs(new Date(p1doc.effective_to) - new Date(days(10))) < 5000, String(p1doc.effective_to));
    r = await call("GET", `/product/price?variant_id=${vM}&warehouse_id=default&sort=effective_from&order=asc`, central);
    check("history → 2 rows (current + upcoming) with state", r.json.data?.length === 2 && r.json.data[0].state === "current" && r.json.data[1].state === "upcoming", JSON.stringify(r.json.data?.map((x) => x.state)));
    const p3id = p3;

    // ---------- bulk ----------
    r = await call("POST", "/product/price/bulk", central, { items: [{ variant_id: vL, price: 13.5 }, { variant_id: vL, unit_id: box, price: 52 }, { variant_id: vM, unit_id: box, price: 48 }, { variant_id: vL, price: 1 }] });
    check("bulk with duplicate chain → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/price/bulk", central, { items: [{ variant_id: vL, price: 13.5 }, { variant_id: vL, unit_id: box, price: "x" }] });
    check("bulk with bad row → 400 and nothing saved", r.status === 400 && !(await Price.exists({ variant_id: vL })), r.json.message);
    r = await call("POST", "/product/price/bulk", central, { items: [{ variant_id: vL, price: 13.5 }, { variant_id: vL, unit_id: box, price: 52 }, { variant_id: vM, unit_id: box, price: 48 }] });
    check("bulk 3 → 201", r.status === 201 && r.json.data.count === 3, r.json.message);

    // ---------- shop override ----------
    r = await call("POST", "/product/price/bulk", central, { items: [{ variant_id: vM, warehouse_id: pp01, price: 12 }, { variant_id: vM, warehouse_id: pp02, price: 12.9 }] });
    check("overrides for PP01 + PP02 → 201", r.status === 201, r.json.message);
    r = await call("GET", `/product/price/current?product_id=${productId}&warehouse_id=${pp01}`, central);
    let gM = r.json.data?.find((v) => v.variant_id === vM); let gL = r.json.data?.find((v) => v.variant_id === vL);
    let uPack = gM?.units.find((u) => u.is_base); let uBox = gM?.units.find((u) => !u.is_base);
    check("current PP01: M pack = 12 (shop), box = 48 (default)", uPack?.price === 12 && uPack.source === "shop" && uBox?.price === 48 && uBox.source === "default", JSON.stringify(gM?.units).slice(0, 300));
    check("grid: default 12.5, upcoming default 13, 2 shops, set unit hidden", uPack.default.price === 12.5 && uPack.default_next?.price === 13 && uPack.shops.length === 2 && gM.units.length === 2, JSON.stringify(uPack).slice(0, 300));
    check("current PP01: L pack = 13.5 default", gL.units.find((u) => u.is_base).price === 13.5 && gL.units.find((u) => u.is_base).source === "default", JSON.stringify(gL.units));
    r = await call("GET", `/product/price/current?product_id=${productId}`, shop1);
    uPack = r.json.data?.find((v) => v.variant_id === vM)?.units.find((u) => u.is_base);
    check("shop manager grid shows only own shop override", uPack?.shops.length === 1 && uPack.shops[0].warehouse_id === String(pp01), JSON.stringify(uPack?.shops));
    r = await call("GET", `/product/price/current?product_id=${productId}&warehouse_id=${pp02}`, shop1);
    check("shop manager other shop → 403", r.status === 403, r.status);
    r = await call("GET", `/product/price?product_id=${productId}&limit=50`, shop1);
    check("shop manager history hides PP02 rows", r.status === 200 && !r.json.data.some((x) => x.warehouse_id?.code === "PP02") && r.json.data.some((x) => x.warehouse_id?.code === "PP01"), JSON.stringify(r.json.data?.map((x) => x.warehouse_id?.code)));

    // remove PP01 override (price null) → back to default
    r = await call("POST", "/product/price", central, { variant_id: vM, warehouse_id: pp01, price: null });
    check("override price null (back to default) → 201", r.status === 201 && r.json.data.price === null, r.json.message);
    r = await call("GET", `/product/price/current?product_id=${productId}&warehouse_id=${pp01}`, central);
    uPack = r.json.data?.find((v) => v.variant_id === vM)?.units.find((u) => u.is_base);
    check("PP01 M pack back to default 12.5", uPack?.price === 12.5 && uPack.source === "default", JSON.stringify(uPack));

    // product list price range
    r = await call("GET", "/product/item?q=ZZ-PRICE", central);
    const pr = r.json.data?.[0]?.price_range;
    check("product list price_range min 12.5 max 13.5 count 2", pr && pr.min === 12.5 && pr.max === 13.5 && pr.count === 2, JSON.stringify(pr));
    r = await call("DELETE", "/product/price/" + p3id, central);
    check("delete upcoming default 13 → current open again", r.status === 200 && (await Price.findById(p1)).effective_to === null, r.json.message);
  } catch (e) { console.error("ERROR", e); results.push(false); }
  finally {
    const ps = await Product.find({ code: /^ZZ/ }).select("_id");
    await Price.deleteMany({ product_id: { $in: ps.map((p) => p._id) } }); await Variant.deleteMany({ product_id: { $in: ps.map((p) => p._id) } }); await Product.deleteMany({ code: /^ZZ/ });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    const left = (await Product.countDocuments({ code: /^ZZ/ })) + (await Price.countDocuments({ product_id: productId })) + (await User.countDocuments({ email: /@local\.test$/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
