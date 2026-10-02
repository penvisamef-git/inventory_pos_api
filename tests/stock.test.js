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
const Opening = M("stock/opening/opening.model"), GR = M("stock/receive/receive.model"), Adj = M("stock/adjustment/adjustment.model"), Tr = M("stock/transfer/transfer.model");
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
    const admin = await mk("zz.s.admin@local.test", { is_super_admin: true });
    const central = await mk("zz.s.central@local.test", { role: ROLES.CENTRAL_MANAGER.value });
    let r = await call("POST", "/setup/warehouse", admin, { code: "ZZC", name_kh: "តេស្តកណ្តាល", type: "central" }); const C = r.json.data._id; whIds.push(C);
    r = await call("POST", "/setup/warehouse", admin, { code: "ZZS1", name_kh: "តេស្តហាង១", type: "shop" }); const S1 = r.json.data._id; whIds.push(S1);
    r = await call("POST", "/setup/warehouse", admin, { code: "ZZS2", name_kh: "តេស្តហាង២", type: "shop" }); const S2 = r.json.data._id; whIds.push(S2);
    const shop = await mk("zz.s.shop@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [S1] });
    const can = (await Unit.findOne({ code: "can" }))._id; const box = (await Unit.findOne({ code: "box" }))._id; const pcs = (await Unit.findOne({ code: "pcs" }))._id;
    const color = await Attribute.findOne({ code: "color" });
    r = await call("POST", "/product/item", central, { code: "ZZ-MILK", name_kh: "ទឹកដោះតេស្ត", category_id: (await Category.findOne({ code: "feeding_formula" }))._id, base_unit_id: can, units: [{ unit_id: box, factor: 6 }], track_batch: true, min_stock: 50 });
    const milkP = r.json.data._id; const MILK = r.json.data.variants[0]._id;
    r = await call("POST", "/product/item", central, { code: "ZZ-TEE", name_kh: "អាវតេស្ត", category_id: (await Category.findOne({ code: "clothing_tops" }))._id, base_unit_id: pcs, attribute_ids: [color._id], min_stock: 2,
      variants: color.values.slice(0, 2).map((v) => ({ options: [{ attribute_id: color._id, value_id: v._id }] })) });
    const [TA, TB] = r.json.data.variants.map((v) => v._id);

    // ---------- supplier ----------
    r = await call("POST", "/purchase/supplier", central, { code: "zz_sup", name: "Test Distributor", phone: "012" }); const SUP = r.json.data?._id;
    check("supplier create → 201", r.status === 201, r.json.message);
    r = await call("POST", "/purchase/supplier", shop, { code: "zz_sup2", name: "x" });
    check("supplier by shop manager → 403", r.status === 403, r.status);

    // ---------- opening ----------
    r = await call("POST", "/stock/opening", central, { warehouse_id: C, items: [{ variant_id: MILK, qty: 12, unit_cost: 20 }] });
    check("opening batch product without batch → 400", r.status === 400, r.json.message);
    r = await call("POST", "/stock/opening", central, { warehouse_id: C, items: [{ variant_id: TA, qty: 10 }] });
    check("opening without cost → 400", r.status === 400, r.json.message);
    r = await call("POST", "/stock/opening", central, { warehouse_id: C, items: [
      { sku: "ZZ-TEE-" + color.values[0].code.toUpperCase(), qty: 10, unit_cost: 2 },
      { variant_id: MILK, qty: 12, unit_cost: 20, batch_no: "b1", expiry_date: days(200) },
      { variant_id: MILK, qty: 5, unit_cost: 20, batch_no: "B0", expiry_date: days(-1) },
    ] });
    const OB = r.json.data?._id;
    check("opening draft (TEE by SKU, MILK 2 batches) → 201 OB-…", r.status === 201 && /^OB-\d{4}-\d{4}$/.test(r.json.data.doc_no) && r.json.data.state === "draft" && r.json.data.items[1].batch_no === "B1", JSON.stringify(r.json).slice(0, 200));
    check("draft does not touch stock", !(await Bal.exists({ warehouse_id: C })), "");
    r = await call("PUT", "/stock/opening/post/" + OB, central);
    check("post opening → posted", r.status === 200 && r.json.data.state === "posted" && near(r.json.data.posted_cost, 360), JSON.stringify(r.json).slice(0, 200));
    r = await call("PUT", "/stock/opening/post/" + OB, central);
    check("post again → 400", r.status === 400, r.status);
    r = await call("PUT", "/stock/opening/" + OB, central, { note: "x" });
    check("edit posted → 400", r.status === 400, r.status);
    let b = await Bal.findOne({ warehouse_id: C, variant_id: MILK });
    check("MILK at ZZC = 17 @ 20", b.qty === 17 && near(b.avg_cost, 20), JSON.stringify(b));

    // ---------- goods receive ----------
    r = await call("POST", "/stock/receive", central, { warehouse_id: S1, supplier_id: SUP, items: [{ variant_id: TA, qty: 1, unit_cost: 1 }] });
    check("goods receive into a shop → 400 (central only)", r.status === 400, r.json.message);
    r = await call("POST", "/stock/receive", central, { warehouse_id: C, supplier_id: SUP, items: [{ variant_id: MILK, unit_id: box, qty: 1, unit_cost: 132, batch_no: "B1", expiry_date: days(100) }] });
    const badGR = r.json.data?._id;
    r = await call("PUT", "/stock/receive/post/" + badGR, central);
    check("receive existing batch with other expiry → 400 on post (nothing changed)", r.status === 400 && (await Bal.findOne({ warehouse_id: C, variant_id: MILK })).qty === 17, r.json.message);
    await call("PUT", "/stock/receive/cancel/" + badGR, central);
    r = await call("POST", "/stock/receive", central, { warehouse_id: C, supplier_id: SUP, supplier_invoice_no: "INV-9", items: [
      { variant_id: MILK, unit_id: box, qty: 1, unit_cost: 132, batch_no: "B2", expiry_date: days(100) },
      { variant_id: TA, qty: 10, unit_cost: 3 } ] });
    const GRid = r.json.data?._id;
    check("GR box → base_qty 6, base cost 22", r.status === 201 && r.json.data.items[0].base_qty === 6 && near(r.json.data.items[0].base_unit_cost, 22) && near(r.json.data.total_cost, 162), JSON.stringify(r.json.data?.items?.[0]).slice(0, 200));
    r = await call("PUT", "/stock/receive/post/" + GRid, central);
    b = await Bal.findOne({ warehouse_id: C, variant_id: MILK }); const bt = await Bal.findOne({ warehouse_id: C, variant_id: TA });
    check("post GR → MILK 23 avg (17×20+6×22)/23, TEE 20 avg 2.5", r.status === 200 && b.qty === 23 && near(b.avg_cost, (17 * 20 + 6 * 22) / 23) && bt.qty === 20 && near(bt.avg_cost, 2.5), `${b.qty} ${b.avg_cost} ${bt.qty} ${bt.avg_cost}`);
    const avgMilk = b.avg_cost;
    r = await call("GET", `/stock/movement?warehouse_id=${C}&variant_id=${MILK}&sort=movement_date&order=asc&limit=10`, central);
    check("ledger: 3 MILK rows, last balance_after 23", r.json.data?.length === 3 && r.json.data[2].balance_after === 23 && r.json.data[2].type === "purchase_in", JSON.stringify(r.json.data?.map((m) => [m.type, m.qty, m.balance_after])));

    // ---------- transfer: request → dispatch (FEFO) → receive with shortage ----------
    r = await call("POST", "/stock/transfer", shop, { warehouse_id: C, to_warehouse_id: S2, items: [{ variant_id: TA, qty: 1 }] });
    check("shop request to another shop → 403", r.status === 403, r.json.message);
    r = await call("POST", "/stock/transfer", shop, { warehouse_id: C, to_warehouse_id: S1, items: [{ variant_id: MILK, qty: 10 }, { variant_id: TA, qty: 5 }] });
    const TR = r.json.data?._id;
    check("shop manager request → requested", r.status === 201 && r.json.data.state === "requested" && r.json.data.requested_items.length === 2, JSON.stringify(r.json).slice(0, 200));
    r = await call("PUT", "/stock/transfer/dispatch/" + TR, shop);
    check("shop manager dispatch from central → 403", r.status === 403, r.status);
    r = await call("PUT", "/stock/transfer/" + TR, central, { items: [{ variant_id: MILK, qty: 8 }, { variant_id: TA, qty: 5 }] });
    check("central edits request qty → 200, request kept", r.status === 200 && r.json.data.items[0].qty === 8 && r.json.data.requested_items[0].qty === 10, JSON.stringify(r.json).slice(0, 200));
    r = await call("PUT", "/stock/transfer/dispatch/" + TR, central);
    const dItems = r.json.data?.items || [];
    check("dispatch: FEFO B2 6 then B1 2 (expired B0 skipped)", r.status === 200 && r.json.data.state === "dispatched" && dItems[0].batches.length === 2 && dItems[0].batches[0].batch_no === "B2" && dItems[0].batches[0].qty === 6 && dItems[0].batches[1].batch_no === "B1" && dItems[0].batches[1].qty === 2, JSON.stringify(dItems[0]?.batches));
    check("dispatch cost = average", near(dItems[0].base_unit_cost, avgMilk) && near(dItems[1].base_unit_cost, 2.5), `${dItems[0]?.base_unit_cost} ${dItems[1]?.base_unit_cost}`);
    check("ZZC after dispatch: MILK 15, TEE 15, nothing at shop yet", (await Bal.findOne({ warehouse_id: C, variant_id: MILK })).qty === 15 && (await Bal.findOne({ warehouse_id: C, variant_id: TA })).qty === 15 && !(await Bal.exists({ warehouse_id: S1 })), "");
    r = await call("PUT", "/stock/transfer/" + TR, central, { note: "x" });
    check("edit dispatched → 400", r.status === 400, r.status);
    const milkLine = dItems[0]._id; const teeLine = dItems[1]._id;
    r = await call("PUT", "/stock/transfer/receive/" + TR, shop, { items: [{ _id: milkLine, received_qty: 9 }] });
    check("receive more than sent → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/stock/transfer/receive/" + TR, shop, { items: [{ _id: milkLine, received_qty: 7 }, { _id: teeLine, received_qty: 5 }], note: "1 can dented, lost" });
    check("shop receives 7/8 → received, shortage 1 + ADJ", r.status === 200 && r.json.data.state === "received" && r.json.data.shortage_qty === 1 && near(r.json.data.shortage_cost, avgMilk) && r.json.data.shortage_adjustment_id?.doc_no?.startsWith("ADJ-"), JSON.stringify(r.json).slice(0, 300));
    const s1m = await Bal.findOne({ warehouse_id: S1, variant_id: MILK });
    const bS1 = await BBal.find({ warehouse_id: S1, variant_id: MILK }).populate("batch_id").lean();
    const bq = Object.fromEntries(bS1.map((x) => [x.batch_id.batch_no, x.qty]));
    check("ZZS1 MILK 7 at dispatch cost; batches B2 6, B1 1 (loss from last batch)", s1m.qty === 7 && near(s1m.avg_cost, avgMilk) && bq.B2 === 6 && bq.B1 === 1, JSON.stringify(bq));
    const adj = await Adj.findOne({ transfer_id: TR });
    check("shortage adjustment posted, reason transfer_shortage", adj && adj.state === "posted" && adj.reason === "transfer_shortage", JSON.stringify(adj?.state));
    r = await call("PUT", "/stock/transfer/receive/" + TR, shop);
    check("receive again → 400", r.status === 400, r.status);

    // not enough / expired
    r = await call("POST", "/stock/transfer", central, { warehouse_id: C, to_warehouse_id: S2, items: [{ variant_id: MILK, qty: 12 }] });
    const TR2 = r.json.data._id;
    r = await call("PUT", "/stock/transfer/dispatch/" + TR2, central);
    check("dispatch 12 MILK with only 10 unexpired (5 expired) → 400, still draft", r.status === 400 && (await Tr.findById(TR2)).state === "draft", r.json.message);
    r = await call("PUT", "/stock/transfer/" + TR2, central, { items: [{ variant_id: TA, qty: 100 }] });
    r = await call("PUT", "/stock/transfer/dispatch/" + TR2, central);
    check("dispatch more than on hand (central, no negative) → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/stock/transfer/cancel/" + TR2, central);
    check("cancel draft → cancelled", r.status === 200 && r.json.data.state === "cancelled", r.json.message);
    r = await call("PUT", "/stock/transfer/dispatch/" + TR2, central);
    check("dispatch cancelled → 400", r.status === 400, r.status);

    // ---------- adjustments ----------
    r = await call("POST", "/stock/adjustment", shop, { warehouse_id: C, reason: "damaged", items: [{ variant_id: TA, qty: 1 }] });
    check("shop manager adjustment at central → 403", r.status === 403, r.json.message);
    r = await call("POST", "/stock/adjustment", shop, { warehouse_id: S1, reason: "damaged", items: [{ variant_id: MILK, qty: 1 }], note: "box crushed" });
    const A1 = r.json.data?._id;
    check("shop manager drafts damaged → qty stored as −1", r.status === 201 && r.json.data.items[0].qty === -1 && r.json.data.state === "draft", JSON.stringify(r.json).slice(0, 200));
    r = await call("PUT", "/stock/adjustment/post/" + A1, shop);
    check("shop manager post → 403", r.status === 403, r.status);
    r = await call("PUT", "/stock/adjustment/post/" + A1, central);
    check("central posts → FEFO B2, cost = avg", r.status === 200 && r.json.data.items[0].batches[0].batch_no === "B2" && near(r.json.data.posted_cost, avgMilk), JSON.stringify(r.json.data?.items?.[0]?.batches));
    const B0 = (await Batch.findOne({ variant_id: MILK, batch_no: "B0" }))._id;
    r = await call("POST", "/stock/adjustment", central, { warehouse_id: C, reason: "expired", items: [{ variant_id: MILK, qty: 5, batch_id: B0 }] });
    r = await call("PUT", "/stock/adjustment/post/" + r.json.data._id, central);
    check("expired batch B0 written off → batch 0, MILK ZZC 10", r.status === 200 && (await BBal.findOne({ warehouse_id: C, batch_id: B0 })).qty === 0 && (await Bal.findOne({ warehouse_id: C, variant_id: MILK })).qty === 10, r.json.message);
    r = await call("POST", "/stock/adjustment", central, { warehouse_id: S1, reason: "lost", items: [{ variant_id: TA, qty: 1000 }] });
    r = await call("PUT", "/stock/adjustment/post/" + r.json.data._id, central);
    check("adjustment below 0 → 400", r.status === 400, r.json.message);
    r = await call("POST", "/stock/adjustment", central, { warehouse_id: S1, reason: "found", items: [{ variant_id: TB, qty: 3, unit_cost: 4 }] });
    r = await call("PUT", "/stock/adjustment/post/" + r.json.data._id, central);
    const tb = await Bal.findOne({ warehouse_id: S1, variant_id: TB });
    check("found 3 @ 4 → IN, avg 4", r.status === 200 && tb.qty === 3 && near(tb.avg_cost, 4), JSON.stringify(tb));
    r = await call("POST", "/stock/adjustment", central, { warehouse_id: S1, reason: "transfer_shortage", items: [{ variant_id: TB, qty: 1 }] });
    check("manual transfer_shortage → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/stock/adjustment/" + adj._id, central, { note: "x" });
    check("edit system shortage adjustment → 400", r.status === 400, r.status);

    // ---------- views ----------
    r = await call("GET", `/stock/balance?q=ZZ-&limit=50`, central);
    const rowMilk = r.json.data?.find((x) => x.variant_id === MILK);
    check("balance (central): MILK per warehouse ZZC 10 / ZZS1 6, avg_cost shown, summary", rowMilk && rowMilk.warehouses.find((w) => w.code === "ZZC").qty === 10 && rowMilk.warehouses.find((w) => w.code === "ZZS1").qty === 6 && rowMilk.warehouses[0].avg_cost !== undefined && r.json.summary.variants >= 3, JSON.stringify(rowMilk?.warehouses?.filter((w) => w.code.startsWith("ZZ"))));
    r = await call("GET", `/stock/balance?q=ZZ-&limit=50`, shop);
    const sm = r.json.data?.find((x) => x.variant_id === MILK);
    check("balance (shop manager): only ZZS1, no cost", r.json.warehouses?.length === 1 && sm.warehouses[0].qty === 6 && sm.warehouses[0].avg_cost === undefined && sm.total_value === undefined, JSON.stringify(sm?.warehouses));
    check("MILK low at shop (6 ≤ min 50)", sm.low === true, "");
    r = await call("GET", `/stock/balance?q=ZZ-&warehouse_id=${C}`, shop);
    check("shop manager balance of central → 403", r.status === 403, r.status);
    r = await call("GET", `/stock/movement?variant_id=${MILK}&limit=50`, shop);
    check("shop manager ledger only own shop, no cost", r.json.data?.length > 0 && r.json.data.every((m) => m.warehouse_id.code === "ZZS1" && m.unit_cost === undefined), JSON.stringify(r.json.data?.map((m) => m.warehouse_id.code)));
    r = await call("GET", `/stock/expiry?days=150&warehouse_id=${S1}`, shop);
    check("expiry list ZZS1 (150 days) → B2 5 cans, days_left ~100", r.json.data?.length === 1 && r.json.data[0].batch_id.batch_no === "B2" && r.json.data[0].qty === 5 && r.json.data[0].days_left >= 99, JSON.stringify(r.json.data?.map((x) => [x.batch_id.batch_no, x.qty, x.days_left])));
    r = await call("GET", `/stock/availability?warehouse_id=${C}&variant_ids=${MILK},${TA}`, central);
    check("availability ZZC: MILK 10 (B1), TEE 15", r.json.data?.[MILK]?.qty === 10 && r.json.data[MILK].batches[0]?.batch_no === "B1" && r.json.data[TA].qty === 15, JSON.stringify(r.json.data));
    r = await call("GET", `/stock/transfer?q=ZZ-MILK`, shop);
    check("shop manager transfer list → own (1)", r.json.data?.length === 1, r.json.data?.length);
    r = await call("GET", `/stock/receive`, shop);
    check("shop manager goods receive list → 403", r.status === 403, r.status);

    // ---------- locks ----------
    r = await call("PUT", "/product/item/" + milkP, central, { base_unit_id: box, units: [{ unit_id: can, factor: 1 }] });
    check("change base unit after stock → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/product/item/" + milkP, central, { track_batch: false });
    check("change track_batch after stock → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/product/item/" + milkP, central, { units: [{ unit_id: box, factor: 12 }] });
    check("change box factor after stock → 400", r.status === 400, r.json.message);
    r = await call("PUT", "/product/item/" + milkP, central, { name_en: "Test milk" });
    check("rename still allowed → 200", r.status === 200, r.json.message);
    r = await call("DELETE", "/product/item/" + milkP, central);
    check("delete product with stock → 400", r.status === 400, r.json.message);
    r = await call("DELETE", "/setup/warehouse/" + S2, admin);
    check("delete warehouse without stock history → 200", r.status === 200, r.json.message);
    r = await call("PUT", "/setup/warehouse/" + C, admin, { type: "shop" });
    check("change warehouse type after stock → 400", r.status === 400, r.json.message);
  } catch (e) { console.error("ERROR", e); results.push(false); }
  finally {
    const ws = await Warehouse.find({ code: /^ZZ/ }).select("_id"); const w = ws.map((x) => x._id);
    const ps = await Product.find({ code: /^ZZ/ }).select("_id"); const p = ps.map((x) => x._id);
    await Movement.deleteMany({ warehouse_id: { $in: w } }); await Bal.deleteMany({ warehouse_id: { $in: w } }); await BBal.deleteMany({ warehouse_id: { $in: w } }); await Batch.deleteMany({ product_id: { $in: p } });
    for (const Mdl of [Opening, GR, Adj]) await Mdl.deleteMany({ warehouse_id: { $in: w } });
    await Tr.deleteMany({ $or: [{ warehouse_id: { $in: w } }, { to_warehouse_id: { $in: w } }] });
    await Variant.deleteMany({ product_id: { $in: p } }); await Product.deleteMany({ _id: { $in: p } }); await Warehouse.deleteMany({ _id: { $in: w } }); await Supplier.deleteMany({ code: /^zz_/ });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    // give back document numbers used by the test
    await Counter.deleteMany({ key: { $nin: counters.map((c) => c.key) } });
    for (const c of counters) await Counter.updateOne({ _id: c._id }, { seq: c.seq });
    const left = (await Warehouse.countDocuments({ code: /^ZZ/ })) + (await Product.countDocuments({ code: /^ZZ/ })) + (await Movement.countDocuments({ warehouse_id: { $in: w } })) + (await User.countDocuments({ email: /@local\.test$/ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · test rows left: ${left}`);
    server.close(); await mongoose.connection.close(); process.exit(0);
  }
})();
