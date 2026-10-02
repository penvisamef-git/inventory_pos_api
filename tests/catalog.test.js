// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test"); process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const M = (p) => require(API + "/src/v1/admin/" + p);
const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model");
const Unit = M("product/unit/unit.model"), Category = M("product/category/category.model"), Attribute = M("product/attribute/attribute.model");
const Product = M("product/item/product.model"), Variant = M("product/item/variant.model"), Price = M("product/price/price.model");
const Warehouse = M("setup/warehouse/warehouse.model"), Movement = M("stock/movement.model"), Opening = M("stock/opening/opening.model");
const { StockBalanceModel: Bal } = M("stock/balance.model"); const Counter = M("counter/counter.model");
const Link = M("catalog/catalog.model"); const { clearCatalogCache } = M("catalog/catalog.route");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const counters = await Counter.find({}).lean();
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b, key = KEY) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": key, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), text: "" }; };
  const pub = async (token, qs = "") => { clearCatalogCache(); const r = await call("GET", `/catalog/public/${token}${qs}`); return r; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "U", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return (await call("POST", "/auth/login", null, { email, password: PASS })).json.data.access_token; };
  try {
    const admin = await mk("zz.q.admin@local.test", { is_super_admin: true });
    const central = await mk("zz.q.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    let r = await call("POST", "/setup/warehouse", admin, { code: "ZZQ1", name_kh: "តេស្តហាង QR", name_en: "QR test shop", type: "shop" }); const S1 = r.json.data._id;
    const shop = await mk("zz.q.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [S1] });
    const pcs = (await Unit.findOne({ code: "pcs" }))._id; const color = await Attribute.findOne({ code: "color" });
    const tops = await Category.findOne({ code: "clothing_tops" });
    r = await call("POST", "/product/item", central, { code: "ZZ-QTEE", name_kh: "អាវ QR", name_en: "QR tee", category_id: tops._id, base_unit_id: pcs, attribute_ids: [color._id],
      variants: color.values.slice(0, 2).map((v) => ({ options: [{ attribute_id: color._id, value_id: v._id }] })) });
    const [TA, TB] = r.json.data.variants.map((v) => v._id);
    r = await call("POST", "/product/item", central, { code: "ZZ-QZERO", name_kh: "គ្មានស្តុក", category_id: tops._id, base_unit_id: pcs });
    r = await call("POST", "/stock/opening", central, { warehouse_id: S1, items: [{ variant_id: TA, qty: 10, unit_cost: 2 }, { variant_id: TB, qty: 3, unit_cost: 2 }] });
    await call("PUT", "/stock/opening/post/" + r.json.data._id, central);
    await Variant.updateOne({ _id: TB }, { min_stock: 5 });
    await call("POST", "/product/price", central, { variant_id: TA, price: 3 });
    await call("POST", "/product/price", central, { variant_id: TB, price: 3 });
    await call("POST", "/product/price", central, { variant_id: TA, warehouse_id: S1, price: 2.5 });

    // ---------- links ----------
    r = await call("POST", "/catalog", shop, { name: "x", warehouse_id: S1 });
    check("shop manager cannot make QR links (403)", r.status === 403, r.status);
    r = await call("POST", "/catalog", central, { name: "", warehouse_id: S1 });
    check("name required → 400", r.status === 400, r.status);
    r = await call("POST", "/catalog", central, { name: "ZZ QR shop", warehouse_id: S1 });
    const LID = r.json.data?._id; let token = r.json.data?.token;
    check("central creates a link → 201, random 12-char token", r.status === 201 && /^[A-Za-z0-9_-]{12}$/.test(token) && r.json.data.warehouse_id.code === "ZZQ1", JSON.stringify(r.json).slice(0, 200));
    r = await call("GET", "/catalog?q=ZZ QR", central);
    check("list finds it", r.status === 200 && r.json.data.some((x) => x._id === LID));

    // ---------- public page ----------
    r = await pub(token, "?limit=60&q=zz-q");
    const it = (code) => (r.json.data?.items || []).find((i) => i.code === code);
    check("public (no login) → store, company, items", r.status === 200 && r.json.data.store.code === "ZZQ1" && r.json.data.company && Array.isArray(r.json.data.categories), r.status + JSON.stringify(r.json).slice(0, 200));
    const raw = JSON.stringify(r.json);
    check("no qty / cost / barcode in the public data", !/"(qty|avg_cost|unit_cost|total_value|barcode|min_stock)"/.test(raw), raw.match(/"(qty|avg_cost|unit_cost|total_value|barcode|min_stock)"/)?.[0]);
    const tee = it("ZZ-QTEE");
    check("variant status: 10 → in, 3 with min 5 → low · product = in", tee?.variants.find((v) => String(v._id) === String(TA))?.status === "in" && tee.variants.find((v) => String(v._id) === String(TB))?.status === "low" && tee.status === "in", JSON.stringify(tee?.variants));
    check("price: shop price 2.5 for TA, default 3 for TB, range 2.5–3", tee.variants.find((v) => String(v._id) === String(TA)).price === 2.5 && tee.variants.find((v) => String(v._id) === String(TB)).price === 3 && tee.price_min === 2.5 && tee.price_max === 3);
    check("all active items: product with no stock shown as out, after the in-stock ones", it("ZZ-QZERO")?.status === "out" && r.json.data.items.indexOf(it("ZZ-QZERO")) > r.json.data.items.indexOf(tee));
    check("search: 2 test products", r.json.data.pagination.total === 2, r.json.data.pagination.total);
    r = await pub(token, "?q=zz-q&only=in_stock");
    check("only=in_stock hides out of stock", r.json.data.pagination.total === 1 && r.json.data.items[0].code === "ZZ-QTEE");
    r = await pub(token, "?limit=5");
    const grp = r.json.data.categories.find((c) => c.count > 0);
    const r2 = await pub(token, `?category_id=${grp._id}&limit=60`);
    check("category filter (top category groups its sub-categories)", r2.json.data.pagination.total === grp.count, `${r2.json.data.pagination.total} vs ${grp.count}`);
    check("visits counted", (await Link.findById(LID)).views >= 1);

    // scoped link (one category)
    r = await call("POST", "/catalog", central, { name: "ZZ QR tops", warehouse_id: S1, category_id: tops._id });
    const r3 = await pub(r.json.data.token, "?limit=60");
    check("link for one category → only that category", r3.status === 200 && r3.json.data.items.length > 0 && r3.json.data.items.every((i) => String(i.category._id) === String(tops._id)) && r3.json.data.link.category, JSON.stringify(r3.json.data.link));

    // ---------- turn off / new token / delete ----------
    r = await call("PUT", "/catalog/" + LID, central, { status: false });
    check("turned off → public 404", r.status === 200 && (await pub(token)).status === 404);
    await call("PUT", "/catalog/" + LID, central, { status: true });
    r = await call("PUT", "/catalog/new-token/" + LID, central);
    const old = token; token = r.json.data.token;
    check("new token → old link 404, new link 200", r.status === 200 && token !== old && (await pub(old)).status === 404 && (await pub(token)).status === 200);
    r = await call("DELETE", "/catalog/" + LID, central);
    check("deleted → public 404", r.status === 200 && (await pub(token)).status === 404);
    check("unknown token → 404", (await pub("nope12345678")).status === 404);
  } catch (e) { console.log("ERR", e); } finally {
    const ws = await Warehouse.find({ code: /^ZZQ/ }).select("_id"); const w = ws.map((x) => x._id);
    const ps = await Product.find({ code: /^ZZ-Q/ }).select("_id"); const p = ps.map((x) => x._id);
    await Link.deleteMany({ created_by: { $in: ids } });
    await Price.deleteMany({ product_id: { $in: p } });
    await Movement.deleteMany({ warehouse_id: { $in: w } }); await Bal.deleteMany({ warehouse_id: { $in: w } }); await Opening.deleteMany({ warehouse_id: { $in: w } });
    await Variant.deleteMany({ product_id: { $in: p } }); await Product.deleteMany({ _id: { $in: p } }); await Warehouse.deleteMany({ _id: { $in: w } });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    await Counter.deleteMany({ key: { $nin: counters.map((c) => c.key) } });
    for (const c of counters) await Counter.updateOne({ _id: c._id }, { seq: c.seq });
    const left = (await Warehouse.countDocuments({ code: /^ZZQ/ })) + (await Product.countDocuments({ code: /^ZZ-Q/ })) + (await Link.countDocuments({ name: /^ZZ QR/ })) + (await User.countDocuments({ email: /^zz\.q\./ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
