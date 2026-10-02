// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test");
process.env.TELEGRAM_WORKER = "off";
const mongoose = require(API + "/node_modules/mongoose"); const app = require(API + "/index.js");
const M = (p) => require(API + "/src/v1/admin/" + p);
const R = []; const check = (n, c, i = "") => { R.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const Product = M("product/item/product.model"), Variant = M("product/item/variant.model"), Price = M("product/price/price.model"), Log = M("activity_log/activity_log.model");
  const s = app.listen(0); const b = `http://127.0.0.1:${s.address().port}/api/admin`; const K = process.env.API_AUTH_KEY;
  const call = async (m, p, t, x) => { const r = await fetch(b + p, { method: m, headers: { "x-api-key": K, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: x ? JSON.stringify(x) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const login = async (e) => (await call("POST", "/auth/login", null, { email: e, password: "Sample@2026" })).json.data.access_token;
  const central = await login("central@inventorypos.test"), shop = await login("manager.pp01@inventorypos.test");
  const logsBefore = new Date();
  try {
    let r = await call("GET", "/product/import/lists", central);
    check("lists: categories, units, options", r.status === 200 && r.json.data.categories.length && r.json.data.units.length && r.json.data.options.some((o) => o.code.startsWith("size=")), r.status);
    const lists = r.json.data;
    r = await call("GET", "/product/import/export", central);
    const exp = r.json.data.rows;
    check("export: one row per SKU", r.status === 200 && exp.length === (await Variant.countDocuments({ deleted: false })), exp.length);
    r = await call("POST", "/product/import", central, { rows: exp, apply: false });
    check("re-import the export (preview) → all update, 0 errors, 0 price changes", r.status === 200 && r.json.data.summary.error === 0 && r.json.data.summary.create === 0 && r.json.data.summary.prices === 0, JSON.stringify(r.json.data.summary) + JSON.stringify(r.json.data.results.filter((x) => x.action === "error").slice(0, 2)));
    r = await call("POST", "/product/import", shop, { rows: exp.slice(0, 2), apply: false });
    check("shop manager → 403", r.status === 403, r.status);

    const cat = lists.categories[0].code, unit = lists.units.find((u) => u.code === "pcs")?.code || lists.units[0].code;
    const box = lists.units.find((u) => u.code !== unit).code;
    const sizes = lists.options.filter((o) => o.code.startsWith("size=")).slice(0, 2).map((o) => o.code);
    const rows = [
      { product_code: "ZZIMP01", name_kh: "តេស្ត នាំចូល", name_en: "Import test", category: cat, base_unit: unit, sku: "", barcode: "ZZ990001", price: 2.5, unit_2: box, unit_2_factor: 10, unit_2_barcode: "ZZ990002", unit_2_price: 24 },
      { product_code: "ZZIMP02", name_kh: "តេស្ត ទំហំ", category: cat, base_unit: unit, option_1: sizes[0], barcode: "ZZ990003", price: 5 },
      { product_code: "ZZIMP02", option_1: sizes[1], sku: "ZZIMP02-B", price: 5.5 },
      { product_code: "ZZIMP03", name_kh: "ខុស", category: "no_such_cat", base_unit: unit },
      { product_code: "ZZIMP04", name_kh: "ស្ទួន", category: cat, base_unit: unit, barcode: "ZZ990001" },
    ];
    r = await call("POST", "/product/import", central, { rows, apply: false });
    const res = (code) => r.json.data.results.find((x) => x.product_code === code);
    check("preview: duplicate barcode stops both products, bad category reported, 1 create", r.json.data.summary.create === 1 && res("ZZIMP03").action === "error" && /no_such_cat/.test(res("ZZIMP03").message) && res("ZZIMP04").action === "error" && res("ZZIMP01").action === "error", JSON.stringify(r.json.data.results.map((x) => [x.product_code, x.action, x.message])));
    check("preview saved nothing", !(await Product.exists({ code: /^ZZIMP/ })));
    const good = rows.filter((x) => ["ZZIMP01", "ZZIMP02"].includes(x.product_code)).map((x) => (x.product_code === "ZZIMP01" ? x : x));
    good[0] = { ...good[0] }; // keep
    r = await call("POST", "/product/import", central, { rows: [good[0], ...rows.slice(1, 3)], apply: true });
    check("apply: 2 products created", r.status === 200 && r.json.data.summary.create === 2 && r.json.data.summary.error === 0, JSON.stringify(r.json.data.results));
    const p1 = await Product.findOne({ code: "ZZIMP01", deleted: false }).lean();
    const v1 = await Variant.findOne({ product_id: p1._id }).lean();
    check("simple product: SKU = code, barcodes, box unit ×10", v1.code === "ZZIMP01" && v1.barcode === "ZZ990001" && v1.unit_barcodes[0]?.barcode === "ZZ990002" && p1.units[0].factor === 10);
    const pr1 = await Price.find({ variant_id: v1._id, deleted: false }).lean();
    check("prices: base 2.5 + box 24", pr1.length === 2 && pr1.some((x) => x.price === 2.5) && pr1.some((x) => x.price === 24), JSON.stringify(pr1.map((x) => x.price)));
    const p2 = await Product.findOne({ code: "ZZIMP02", deleted: false }).lean();
    const v2 = await Variant.find({ product_id: p2._id, deleted: false }).sort({ sort_order: 1 }).lean();
    check("variant product: 2 sizes, given SKU kept", v2.length === 2 && v2[1].code === "ZZIMP02-B" && v2[0].options[0].value_code, JSON.stringify(v2.map((v) => v.code)));

    r = await call("POST", "/product/import", central, { rows: [{ product_code: "ZZIMP01", name_en: "Import test v2", price: 2.5 }, { product_code: "ZZIMP02", option_1: sizes[1], price: 6 }], apply: true });
    check("update: name changed, same price not added again, changed price added", r.json.data.summary.update === 2 && r.json.data.results[0].prices === 0 && r.json.data.results[1].prices === 1, JSON.stringify(r.json.data.results));
    check("update kept the other size (import never deletes)", (await Variant.countDocuments({ product_id: p2._id, deleted: false })) === 2 && (await Product.findById(p1._id).lean()).name_en === "Import test v2");
    const now = await Price.findOne({ variant_id: v2[1]._id, warehouse_id: null, deleted: false, effective_to: null }).lean();
    check("new price is today's price (history kept)", now?.price === 6 && (await Price.countDocuments({ variant_id: v2[1]._id, deleted: false })) === 2);
    r = await call("POST", "/product/import", central, { rows: [
      { product_code: "ZZIMP05", name_kh: "គ្មានឯកតាទី២", category: cat, base_unit: unit, unit_2_price: 9, _row: 2 },
      { product_code: "ZZIMP06", name_kh: "គ្មានឯកតាទី២ បាកូដ", category: cat, base_unit: unit, unit_2_barcode: "ZZ990009", _row: 3 },
      { product_code: "ZZIMP07", name_kh: "ល្អ", category: cat, base_unit: unit, _row: 4 },
    ], apply: false });
    check("unit_2_price / unit_2_barcode without unit_2 → that product is an error, the rest still checked", r.status === 200 && r.json.data.results.length === 3 && r.json.data.results[0].action === "error" && r.json.data.results[1].action === "error" && r.json.data.results[2].action === "create", r.status + JSON.stringify(r.json));
  } catch (e) { console.log("ERR", e); } finally {
    const ps = await Product.find({ code: /^ZZIMP/ }).select("_id").lean(); const ids = ps.map((p) => p._id);
    await Price.deleteMany({ product_id: { $in: ids } }); await Variant.deleteMany({ product_id: { $in: ids } }); await Product.deleteMany({ _id: { $in: ids } });
    await Log.deleteMany({ created_date: { $gte: logsBefore }, title: /នាំចូលទំនិញពី Excel/ });
    await call("POST", "/auth/logout", central); await call("POST", "/auth/logout", shop);
    console.log(`\n${R.filter(Boolean).length}/${R.length} passed · test rows left: ${await Product.countDocuments({ code: /^ZZIMP/ })}`);
    s.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
