// Integration test against the test database (UAT) — run all with: npm test
const API = process.env.API_DIR || require("path").resolve(__dirname, ".."); process.chdir(API);
require(API + "/node_modules/dotenv").config({ path: API + "/.env" }); require(API + "/scripts/lib/test_db_guard").assertTestDb("Test");
const mongoose = require(API + "/node_modules/mongoose"); const bcrypt = require(API + "/node_modules/bcrypt");
const app = require(API + "/index.js");
const M = (p) => require(API + "/src/v1/admin/" + p);
const User = M("user/user.model"), Session = M("session/session.model"), ActivityLog = M("activity_log/activity_log.model");
const Unit = M("product/unit/unit.model"), Category = M("product/category/category.model"), Attribute = M("product/attribute/attribute.model");
const Product = M("product/item/product.model"), Variant = M("product/item/variant.model");
const Warehouse = M("setup/warehouse/warehouse.model"), Supplier = M("purchase/supplier/supplier.model");
const Movement = M("stock/movement.model"), Batch = M("stock/batch.model"); const { StockBalanceModel: Bal, StockBatchBalanceModel: BBal } = M("stock/balance.model");
const Count = M("stock/count/count.model"), Opening = M("stock/opening/opening.model"), GR = M("stock/receive/receive.model"), Adj = M("stock/adjustment/adjustment.model"), Tr = M("stock/transfer/transfer.model");
const Counter = M("counter/counter.model");
const { ROLES } = require(API + "/src/util/user_roles");
const PASS = "TestPass#2026"; const results = [];
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const near = (a, b) => Math.abs(a - b) < 0.0001;
(async () => {
  while (mongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  const counters = await Counter.find({}).lean();
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api/admin`; const KEY = process.env.API_AUTH_KEY;
  const call = async (m, p, t, b) => { const r = await fetch(base + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const mk = async (email, extra) => { const id = new mongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: "T", lastname: "U", email, password: await bcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return (await call("POST", "/auth/login", null, { email, password: PASS })).json.data.access_token; };
  const whIds = [];
  try {
    const admin = await mk("zz.c.admin@local.test", { is_super_admin: true });
    const central = await mk("zz.c.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    let r = await call("POST", "/setup/warehouse", admin, { code: "ZZS1", name_kh: "តេស្តហាង១", type: "shop" }); const S1 = r.json.data._id; whIds.push(S1);
    r = await call("POST", "/setup/warehouse", admin, { code: "ZZS2", name_kh: "តេស្តហាង២", type: "shop" }); const S2 = r.json.data._id; whIds.push(S2);
    const shop = await mk("zz.c.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [S1] });
    const can = (await Unit.findOne({ code: "can" }))._id; const pcs = (await Unit.findOne({ code: "pcs" }))._id;
    const color = await Attribute.findOne({ code: "color" });
    const catMilk = (await Category.findOne({ code: "feeding_formula" }))._id;
    r = await call("POST", "/product/item", central, { code: "ZZ-MILK", name_kh: "ទឹកដោះតេស្ត", category_id: catMilk, base_unit_id: can, track_batch: true });
    const MILK = r.json.data.variants[0]._id;
    r = await call("POST", "/product/item", central, { code: "ZZ-TEE", name_kh: "អាវតេស្ត", category_id: (await Category.findOne({ code: "clothing_tops" }))._id, base_unit_id: pcs, attribute_ids: [color._id],
      variants: color.values.slice(0, 2).map((v) => ({ options: [{ attribute_id: color._id, value_id: v._id }] })) });
    const [TA, TB] = r.json.data.variants.map((v) => v._id);
    r = await call("POST", "/stock/opening", central, { warehouse_id: S1, items: [
      { variant_id: TA, qty: 10, unit_cost: 2 }, { variant_id: TB, qty: 5, unit_cost: 2 }, { variant_id: MILK, qty: 6, unit_cost: 20, batch_no: "B1", expiry_date: days(200) } ] });
    await call("PUT", "/stock/opening/post/" + r.json.data._id, central);

    // ---------- start ----------
    r = await call("POST", "/stock/count", shop, { warehouse_id: S2 });
    check("shop manager: other shop → 403", r.status === 403, r.status);
    r = await call("POST", "/stock/count", shop, { warehouse_id: S1, note: "month end" });
    const SC = r.json.data?._id; const lines = r.json.data?.lines || [];
    const L = (v, batch) => lines.find((l) => String(l.variant_id) === String(v) && (batch === undefined || l.batch_no === batch));
    check("shop manager starts a count → 201 SC-…, every active SKU listed", r.status === 201 && /^SC-\d{4}-\d{4}$/.test(r.json.data.doc_no) && r.json.data.state === "counting" && L(TA) && L(TB) && L(MILK, "B1") && lines.length > 50, JSON.stringify(r.json).slice(0, 200));
    check("blind: no system qty while counting", lines.every((l) => l.expected_qty === null && l.diff_qty === null));
    r = await call("POST", "/stock/count", central, { warehouse_id: S1 });
    check("second open count for the same shop → 409", r.status === 409, r.status);

    // ---------- count ----------
    r = await call("PUT", "/stock/count/" + SC, shop, { counts: [{ _id: L(TA)._id, counted_qty: 8 }, { _id: L(TB)._id, counted_qty: 5 }, { _id: L(MILK, "B1")._id, counted_qty: 7 }],
      add: [{ variant_id: MILK, batch_no: "b9", expiry_date: days(300), counted_qty: 2 }] });
    check("save counts + add a new batch found on the shelf", r.status === 200 && r.json.data.counted_lines === 4 && r.json.data.lines.some((l) => l.added && l.batch_no === "B9"), JSON.stringify(r.json).slice(0, 300));
    r = await call("PUT", "/stock/count/" + SC, shop, { add: [{ variant_id: TB, counted_qty: 1 }] });
    check("add an SKU that is already listed → 400", r.status === 400, r.status);
    r = await call("PUT", "/stock/count/" + SC, shop, { counts: [{ _id: L(TA)._id, counted_qty: -1 }] });
    check("negative count → 400", r.status === 400, r.status);
    r = await call("PUT", "/stock/count/post/" + SC, central);
    check("post before submit → 400", r.status === 400, r.status);

    // ---------- submit ----------
    r = await call("PUT", "/stock/count/submit/" + SC, shop, { uncounted: "skip" });
    const d = r.json.data; const D = (v, b) => d.lines.find((l) => String(l.variant_id) === String(v) && (b === undefined || l.batch_no === b));
    check("submit → differences: TA −2, TB 0, B1 +1, new B9 +2; uncounted skipped", r.status === 200 && d.state === "submitted" && D(TA).diff_qty === -2 && D(TB).diff_qty === 0 && D(MILK, "B1").diff_qty === 1 && D(MILK, "B9").diff_qty === 2 && d.diff_lines === 3 && d.lines.filter((l) => l.diff_qty === null).length === d.total_lines - 4, JSON.stringify(d).slice(0, 300));
    check("shop manager never sees cost", d.diff_cost === undefined && d.lines.every((l) => l.unit_cost === undefined));
    r = await call("PUT", "/stock/count/" + SC, shop, { counts: [{ _id: L(TA)._id, counted_qty: 9 }] });
    check("edit after submit → 400", r.status === 400, r.status);
    r = await call("PUT", "/stock/count/post/" + SC, shop);
    check("shop manager cannot post → 403", r.status === 403, r.status);
    r = await call("PUT", "/stock/count/reopen/" + SC, central);
    check("central reopens → counting, system qty hidden again", r.status === 200 && r.json.data.state === "counting" && r.json.data.lines.every((l) => l.expected_qty === null), r.status);
    r = await call("PUT", "/stock/count/submit/" + SC, shop, {});
    r = await call("PUT", "/stock/count/post/" + SC, central);
    const pd = r.json.data;
    check("central posts → posted + stock adjustment ADJ-…", r.status === 200 && pd.state === "posted" && pd.adjustment_id?.doc_no?.startsWith("ADJ-"), JSON.stringify(r.json).slice(0, 300));
    check("central sees the value of the differences (−2×$2 +3×$20 = $56)", near(pd.diff_cost, 56), pd.diff_cost);
    const bal = async (v) => (await Bal.findOne({ warehouse_id: S1, variant_id: v }).lean())?.qty;
    check("stock now = counted: TA 8, TB 5, MILK 9", (await bal(TA)) === 8 && (await bal(TB)) === 5 && (await bal(MILK)) === 9, [await bal(TA), await bal(TB), await bal(MILK)].join());
    const b9 = await Batch.findOne({ variant_id: MILK, batch_no: "B9" }).lean();
    check("new batch B9 created with its expiry", b9 && b9.expiry_date && (await BBal.findOne({ warehouse_id: S1, batch_id: b9._id }).lean())?.qty === 2);
    const adj = await Adj.findById(pd.adjustment_id._id).lean();
    check("adjustment: reason stock_count, linked, posted", adj.reason === "stock_count" && String(adj.count_id) === String(SC) && adj.state === "posted" && adj.items.length === 3);
    r = await call("PUT", "/stock/adjustment/cancel/" + adj._id, central);
    check("that adjustment cannot be edited / cancelled", r.status >= 400, r.status);
    r = await call("PUT", "/stock/count/cancel/" + SC, central);
    check("cancel a posted count → 400", r.status === 400, r.status);
    r = await call("GET", "/stock/count?warehouse_id=" + S1, shop);
    check("list: no lines in the list", r.status === 200 && r.json.data.length === 1 && r.json.data[0].lines === undefined, JSON.stringify(r.json).slice(0, 200));
    r = await call("POST", "/stock/count", shop, { warehouse_id: S1, category_id: catMilk });
    check("new count by category (after the last one is posted) → only that category", r.status === 201 && r.json.data.lines.every((l) => /ZZ-MILK|FORMULA/i.test(l.sku)), JSON.stringify(r.json.data?.lines?.map((l) => l.sku)));
    r = await call("PUT", "/stock/count/cancel/" + r.json.data._id, shop);
    check("shop manager cancels an open count", r.status === 200 && r.json.data.state === "cancelled", r.status);
  } catch (e) { console.error("ERROR", e); results.push(false); }
  finally {
    const ws = await Warehouse.find({ code: /^ZZ/ }).select("_id"); const w = ws.map((x) => x._id);
    const ps = await Product.find({ code: /^ZZ/ }).select("_id"); const p = ps.map((x) => x._id);
    await Movement.deleteMany({ warehouse_id: { $in: w } }); await Bal.deleteMany({ warehouse_id: { $in: w } }); await BBal.deleteMany({ warehouse_id: { $in: w } }); await Batch.deleteMany({ product_id: { $in: p } });
    for (const Mdl of [Opening, Adj, Count]) await Mdl.deleteMany({ warehouse_id: { $in: w } });
    await Variant.deleteMany({ product_id: { $in: p } }); await Product.deleteMany({ _id: { $in: p } }); await Warehouse.deleteMany({ _id: { $in: w } });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    await Counter.deleteMany({ key: { $nin: counters.map((c) => c.key) } });
    for (const c of counters) await Counter.updateOne({ _id: c._id }, { seq: c.seq });
    const left = (await Warehouse.countDocuments({ code: /^ZZ/ })) + (await Product.countDocuments({ code: /^ZZ/ })) + (await Count.countDocuments({ warehouse_id: { $in: w } })) + (await User.countDocuments({ email: /@local\.test$/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
