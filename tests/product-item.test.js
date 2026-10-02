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
const Brand = require(API + "/src/v1/admin/product/brand/brand.model");
const Product = require(API + "/src/v1/admin/product/item/product.model");
const Variant = require(API + "/src/v1/admin/product/item/variant.model");
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
    const central = await mk("zz.i.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    const pp01 = (await Warehouse.findOne({ code: "PP01" }))._id;
    const shop = await mk("zz.i.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [pp01] });
    const pcs = (await Unit.findOne({ code: "pcs", deleted: false }))._id;
    const pack = (await Unit.findOne({ code: "pack", deleted: false }))._id;
    const box = (await Unit.findOne({ code: "box", deleted: false }))._id;
    const clothing = await Category.findOne({ code: "clothing" }); const bodysuit = await Category.findOne({ code: "clothing_bodysuit" }) || await Category.findOne({ parent_id: clothing._id });
    const size = await Attribute.findOne({ code: "size" }); const color = await Attribute.findOne({ code: "color" });
    const sv = size.values.slice(0, 2); const cv = color.values.slice(0, 2);

    // ---------- Brand ----------
    let r = await call("POST", "/product/brand", central, { code: "zz_brand", name_kh: "ម៉ាកតេស្ត", name_en: "Test brand" });
    check("brand create → 201", r.status === 201, r.json.message); const brand = r.json.data?._id;
    r = await call("POST", "/product/brand", shop, { code: "zz_brand2", name_kh: "x" });
    check("brand create by shop manager → 403", r.status === 403, r.status);

    // ---------- Simple product ----------
    r = await call("POST", "/product/item", central, { code: "zz-sh01", name_kh: "សាប៊ូតេស្ត", category_id: bodysuit._id, base_unit_id: pcs });
    check("simple product without barcode → 201, code UPPER, 1 default variant", r.status === 201 && r.json.data.code === "ZZ-SH01" && r.json.data.variants.length === 1 && r.json.data.variants[0].is_default && r.json.data.variants[0].code === "ZZ-SH01", JSON.stringify(r.json).slice(0, 300));
    const simple = r.json.data?._id; const defVar = r.json.data?.variants?.[0]?._id;
    r = await call("POST", "/product/item", central, { code: "ZZ-SH01", name_kh: "x", category_id: bodysuit._id, base_unit_id: pcs });
    check("duplicate product code → 409", r.status === 409, r.json.message);
    r = await call("POST", "/product/item", central, { code: "ZZ-X1", name_kh: "x", category_id: bodysuit._id });
    check("missing base unit → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/item", central, { code: "ZZ-X1", name_kh: "x", category_id: bodysuit._id, base_unit_id: pcs, units: [{ unit_id: pcs, factor: 12 }] });
    check("other unit = base unit → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/item", central, { code: "ZZ-X1", name_kh: "x", category_id: bodysuit._id, base_unit_id: pcs, units: [{ unit_id: box, factor: 0 }] });
    check("factor 0 → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/item", shop, { code: "ZZ-X1", name_kh: "x", category_id: bodysuit._id, base_unit_id: pcs });
    check("create by shop manager → 403", r.status === 403, r.status);

    r = await call("PUT", "/product/item/" + simple, central, { brand_id: brand, track_batch: true, min_stock: 5, units: [{ unit_id: box, factor: 24 }], variants: [{ barcode: "ZZ8850001", unit_barcodes: [{ unit_id: box, barcode: "ZZ8850024" }] }] });
    check("simple update: barcode + box barcode, default variant keeps _id", r.status === 200 && r.json.data.variants[0]._id === defVar && r.json.data.variants[0].unit_barcodes[0].barcode === "ZZ8850024" && r.json.data.track_batch === true, JSON.stringify(r.json).slice(0, 300));
    r = await call("PUT", "/product/item/" + simple, central, { code: "ZZ-SH02", name_kh: "សាប៊ូតេស្ត ២" });
    check("rename product code → default SKU follows, barcode kept", r.status === 200 && r.json.data.variants[0].code === "ZZ-SH02" && r.json.data.variants[0].name_kh === "សាប៊ូតេស្ត ២" && r.json.data.variants[0].barcode === "ZZ8850001", JSON.stringify(r.json.data?.variants?.[0]).slice(0, 300));

    // ---------- Barcode lookup ----------
    r = await call("GET", "/product/item/barcode/ZZ8850001", shop);
    check("lookup base barcode → factor 1, is_base", r.status === 200 && r.json.data.unit.is_base && r.json.data.unit.factor === 1 && r.json.data.variant._id === defVar, JSON.stringify(r.json).slice(0, 200));
    r = await call("GET", "/product/item/barcode/ZZ8850024", shop);
    check("lookup box barcode → box, factor 24", r.status === 200 && r.json.data.unit.code === "box" && r.json.data.unit.factor === 24, JSON.stringify(r.json.data?.unit));
    r = await call("GET", "/product/item/barcode/zz-sh02", shop);
    check("lookup by SKU (fallback) → found", r.status === 200 && r.json.data.variant.code === "ZZ-SH02", r.status);
    r = await call("GET", "/product/item/barcode/NOPE000", shop);
    check("lookup unknown → 404", r.status === 404, r.status);

    // ---------- Variant product ----------
    const variants = [];
    for (const s of sv) for (const c of cv) variants.push({ options: [{ attribute_id: size._id, value_id: s._id }, { attribute_id: color._id, value_id: c._id }] });
    variants[0].barcode = "ZZ8850001";
    r = await call("POST", "/product/item", central, { code: "ZZ-ROMP", name_kh: "អាវតេស្ត", name_en: "Test romper", category_id: bodysuit._id, base_unit_id: pcs, attribute_ids: [size._id, color._id], variants });
    check("variant barcode used by another product → 409", r.status === 409, r.json.message);
    variants[0].barcode = "ZZ7770001";
    r = await call("POST", "/product/item", central, { code: "ZZ-ROMP", name_kh: "អាវតេស្ត", name_en: "Test romper", category_id: bodysuit._id, base_unit_id: pcs, attribute_ids: [size._id, color._id], variants: [...variants, variants[1]] });
    check("duplicate option combination → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/item", central, { code: "ZZ-ROMP", name_kh: "អាវតេស្ត", name_en: "Test romper", category_id: bodysuit._id, base_unit_id: pcs, attribute_ids: [size._id, color._id], variants: [{ options: [{ attribute_id: size._id, value_id: sv[0]._id }] }] });
    check("variant missing color → 400", r.status === 400, r.json.message);
    r = await call("POST", "/product/item", central, { code: "ZZ-ROMP", name_kh: "អាវតេស្ត", name_en: "Test romper", category_id: bodysuit._id, base_unit_id: pcs, attribute_ids: [size._id, color._id], variants });
    const v0 = r.json.data?.variants?.[0];
    const expectSku = ("ZZ-ROMP-" + sv[0].code + "-" + cv[0].code).toUpperCase();
    check("2×2 variants → 201, auto SKU + name + color snapshot", r.status === 201 && r.json.data.variants.length === 4 && r.json.data.variant_count === 4 && v0.code === expectSku && v0.name_en === `Test romper (${sv[0].name_en} / ${cv[0].name_en})` && v0.options[1].color_hex === cv[0].color_hex, JSON.stringify(r.json).slice(0, 400));
    const romp = r.json.data?._id; const all = r.json.data?.variants || [];

    // update: keep 3 (one with new barcode), drop 1, add 1 new size
    const sv3 = size.values[2];
    const upd = all.slice(0, 3).map((v) => ({ _id: v._id, options: v.options, barcode: v.barcode }));
    upd[1].barcode = "ZZ7770002"; upd[2].status = false;
    upd.push({ options: [{ attribute_id: size._id, value_id: sv3._id }, { attribute_id: color._id, value_id: cv[0]._id }], code: "zz-romp-custom" });
    r = await call("PUT", "/product/item/" + romp, central, { variants: upd });
    const after = r.json.data?.variants || [];
    check("variants sync: 3 kept (ids same), 1 removed, 1 added", r.status === 200 && after.length === 4 && after[0]._id === all[0]._id && after[1].barcode === "ZZ7770002" && after[2].status === false && after[3].code === "ZZ-ROMP-CUSTOM" && !after.some((v) => v._id === all[3]._id), JSON.stringify(after.map((v) => v.code)));
    check("removed variant is soft deleted", (await Variant.findById(all[3]._id))?.deleted === true, "");

    // attribute value used → cannot remove; attribute used → cannot delete
    r = await call("PUT", "/product/attribute/" + size._id, central, { values: size.values.filter((v) => String(v._id) !== String(sv[0]._id)).map((v) => ({ _id: v._id, code: v.code, name_kh: v.name_kh, name_en: v.name_en })) });
    check("remove attribute value used by a variant → 400", r.status === 400, r.json.message);
    check("attribute unchanged", (await Attribute.findById(size._id)).values.length === size.values.length, "");
    r = await call("DELETE", "/product/attribute/" + color._id, central);
    check("delete attribute used by product → 400", r.status === 400, r.json.message);
    r = await call("DELETE", "/product/unit/" + box, central);
    check("delete unit used by product → 400", r.status === 400, r.json.message);
    r = await call("DELETE", "/product/brand/" + brand, central);
    check("delete brand used by product → 400", r.status === 400, r.json.message);
    r = await call("DELETE", "/product/category/" + bodysuit._id, central);
    check("delete category with products → 400", r.status === 400, r.json.message);

    // ---------- lists ----------
    r = await call("GET", "/product/item?q=ZZ7770002", shop);
    check("list search by variant barcode → romper", r.status === 200 && r.json.data.length === 1 && r.json.data[0].code === "ZZ-ROMP", JSON.stringify(r.json.data?.map((p) => p.code)));
    r = await call("GET", "/product/item?q=zz-&category_id=" + clothing._id + "&limit=50", shop);
    check("list ?category_id=parent includes sub-category products", r.json.data?.length === 2, JSON.stringify(r.json.data?.map((p) => p.code)));
    r = await call("GET", "/product/item?track_batch=true&q=zz-", shop);
    check("list ?track_batch=true → shampoo only", r.json.data?.length === 1 && r.json.data[0].code === "ZZ-SH02", JSON.stringify(r.json.data?.map((p) => p.code)));
    r = await call("GET", "/product/variant?product_id=" + romp, shop);
    check("variant list ?product_id → 4 rows with product populated", r.json.data?.length === 4 && r.json.data[0].product_id?.code === "ZZ-ROMP", r.json.data?.length);
    r = await call("GET", "/product/item/check-code?value=ZZ7770002", shop);
    check("check-code → barcode used, product code free", r.json.data?.barcode.free === false && r.json.data.product_code.free === true, JSON.stringify(r.json.data));
    r = await call("GET", "/product/category?q=" + bodysuit.code + "&q_key=[\"code\"]", shop);
    check("category list has product_count", r.json.data?.[0]?.product_count >= 2, JSON.stringify(r.json.data?.[0]?.product_count));

    // ---------- delete / restore ----------
    r = await call("DELETE", "/product/item/" + romp, central);
    check("delete product → 200, variants hidden", r.status === 200 && (await Variant.countDocuments({ product_id: romp, deleted: false })) === 0, r.json.message);
    r = await call("GET", "/product/item/barcode/ZZ7770002", shop);
    check("deleted product barcode not found", r.status === 404, r.status);
    r = await call("PUT", "/product/item/restore/" + romp, central);
    check("restore → 200 with the same 4 variants (not the one removed earlier)", r.status === 200 && r.json.data.variants.length === 4 && !r.json.data.variants.some((v) => v._id === all[3]._id), JSON.stringify(r.json).slice(0, 200));
  } catch (e) { console.error("ERROR", e); results.push(false); }
  finally {
    const ps = await Product.find({ code: /^ZZ/ }).select("_id");
    await Variant.deleteMany({ product_id: { $in: ps.map((p) => p._id) } }); await Product.deleteMany({ code: /^ZZ/ }); await Brand.deleteMany({ code: /^zz_/ });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    const left = (await Product.countDocuments({ code: /^ZZ/ })) + (await Variant.countDocuments({ code: /^ZZ/ })) + (await Brand.countDocuments({ code: /^zz_/ })) + (await User.countDocuments({ email: /@local\.test$/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
