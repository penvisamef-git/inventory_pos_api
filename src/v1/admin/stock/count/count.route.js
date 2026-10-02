const mongoose = require("mongoose");
const StockCountModel = require("./count.model");
const StockAdjustmentModel = require("../adjustment/adjustment.model");
const { postAdjustment } = require("../adjustment/adjustment.post");
const { StockBalanceModel, StockBatchBalanceModel } = require("../balance.model");
const BatchModel = require("../batch.model");
const ProductModel = require("../../product/item/product.model");
const VariantModel = require("../../product/item/variant.model");
const UnitModel = require("../../product/unit/unit.model");
const WarehouseModel = require("../../setup/warehouse/warehouse.model");
const { categoryWithChildren } = require("../../product/item/product.service");
const { inTransaction } = require("../stock.engine");
const { isId, toDate } = require("../stock.items");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { nextNo } = require("../../../../util/counter");
const { escapeRegex, round } = require("../../../../util/helper");
const { serverError, noIDFound } = require("../../../../util/master_crud");
const { can_manage_stock, can_work_stock, can_view_master } = require("../../../../util/permission");
const { warehouse_scope, canAccessWarehouse } = require("../../../../util/warehouse_scope");
const telegram = require("../../telegram/telegram.hooks");

const DOC = "ការរាប់ស្តុក";
const MAX_LINES = 5000;
const POPULATE = [
  { path: "warehouse_id", select: "code name_kh name_en type" },
  { path: "category_id", select: "code name_kh name_en" },
  { path: "created_by", select: "firstname lastname email" },
  { path: "submitted_by", select: "firstname lastname email" },
  { path: "posted_by", select: "firstname lastname email" },
  { path: "adjustment_id", select: "doc_no" },
];
const r4 = (v) => round(v, 4);

// shop managers never see cost; while counting nobody sees the system qty (blind count — it isn't even taken yet)
function shape(doc, req) {
  const d = doc.toJSON ? doc.toJSON() : doc;
  if (req.warehouse_scope === "own") {
    delete d.diff_cost;
    (d.lines || []).forEach((l) => {
      delete l.unit_cost;
      delete l.diff_cost;
    });
  }
  return d;
}

function totals(doc) {
  const lines = doc.lines;
  doc.total_lines = lines.length;
  doc.counted_lines = lines.filter((l) => l.counted_qty !== null && l.counted_qty !== undefined).length;
  const diffs = lines.filter((l) => l.diff_qty);
  doc.diff_lines = diffs.length;
  doc.diff_in_qty = r4(diffs.filter((l) => l.diff_qty > 0).reduce((t, l) => t + l.diff_qty, 0));
  doc.diff_out_qty = r4(diffs.filter((l) => l.diff_qty < 0).reduce((t, l) => t - l.diff_qty, 0));
}

// /api/admin/stock/count — blind stock count (agreed): shop manager or central counts, central / admin posts
//   POST   /stock/count { warehouse_id, category_id?, note }      → list of every active SKU (batch SKUs: one line per batch in stock)
//   GET    /stock/count  ?state=&warehouse_id=&q=                  · GET /stock/count/:id
//   PUT    /stock/count/:id { counts: [{ _id, counted_qty|null, batch_no?, expiry_date?, note? }], add: [{ sku|barcode|variant_id, counted_qty, batch_no?, expiry_date? }], note? }
//   PUT    /stock/count/submit/:id { uncounted: "skip" | "zero" }  → takes the system qty now, differences shown
//   PUT    /stock/count/reopen/:id                                 → back to counting (central)
//   PUT    /stock/count/post/:id                                   → one stock adjustment (reason stock_count) with the differences (central)
//   PUT    /stock/count/cancel/:id
const route = (prop) => {
  const url = `/${prop.main_route}/stock/count`;
  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope];
  const workGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_work_stock, warehouse_scope];
  const postGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_stock, warehouse_scope];
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  };
  const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
  const scoped = (req, id) => StockCountModel.findOne({ _id: id, ...(req.warehouse_ids ? { warehouse_id: { $in: req.warehouse_ids } } : {}) });
  const log = (req, title) => logActivity({ title, description: `គណនី: ${req.user.email}`, categoryTitle: "stock_adjustment", createdBy: req.session.user_id, req });
  const send = async (res, id, req, message, status = 200) =>
    res.status(status).json({ success: true, data: shape(await StockCountModel.findById(id).populate(POPULATE), req), message });

  const unitsCache = async () => new Map((await UnitModel.find({ deleted: false }).lean()).map((u) => [String(u._id), u]));
  const lineOf = (v, p, unit, extra = {}) => ({
    product_id: p._id,
    variant_id: v._id,
    sku: v.code,
    name_kh: v.name_kh,
    name_en: v.name_en || v.name_kh,
    barcode: v.barcode || null,
    unit_id: p.base_unit_id,
    unit_code: unit?.code,
    unit_name_kh: unit?.name_kh,
    unit_name_en: unit?.name_en || unit?.name_kh,
    track_batch: !!p.track_batch,
    ...extra,
  });

  // ---------------- create ----------------
  prop.app.post(url, ...workGuard, wrap(async (req, res) => {
    const b = req.body || {};
    const whId = b.warehouse_id?._id || b.warehouse_id;
    if (!isId(whId) || !(await WarehouseModel.exists({ _id: whId, deleted: false }))) return bad(res, "សូមជ្រើសរើសឃ្លាំង!");
    if (!canAccessWarehouse(req, whId)) return bad(res, "អ្នកមិនមានសិទ្ធិលើឃ្លាំងនេះទេ!", 403);
    if (await StockCountModel.exists({ warehouse_id: whId, state: { $in: ["counting", "submitted"] } }))
      return bad(res, "ឃ្លាំងនេះមានការរាប់ស្តុកមិនទាន់បញ្ចប់រួចហើយ — បញ្ចប់ ឬបោះបង់វាជាមុនសិន", 409);
    const pf = { deleted: false, status: true, track_stock: { $ne: false } };
    let categoryId = null;
    if (b.category_id) {
      if (!isId(b.category_id)) return bad(res, "ប្រភេទទំនិញមិនត្រឹមត្រូវ!");
      categoryId = b.category_id;
      pf.category_id = { $in: await categoryWithChildren(b.category_id) };
    }
    const products = await ProductModel.find(pf).sort({ sort_order: 1, code: 1 }).lean();
    const variants = await VariantModel.find({ deleted: false, status: true, product_id: { $in: products.map((p) => p._id) } }).sort({ sort_order: 1 }).lean();
    const units = await unitsCache();
    const byProduct = new Map(products.map((p) => [String(p._id), p]));
    const batchRows = await StockBatchBalanceModel.find({ warehouse_id: whId, qty: { $ne: 0 }, variant_id: { $in: variants.map((v) => v._id) } }).lean();
    const batches = new Map((await BatchModel.find({ _id: { $in: batchRows.map((x) => x.batch_id) } }).lean()).map((x) => [String(x._id), x]));
    const lines = [];
    const order = new Map(products.map((p, i) => [String(p._id), i]));
    variants.sort((a, b2) => order.get(String(a.product_id)) - order.get(String(b2.product_id)) || a.sort_order - b2.sort_order);
    for (const v of variants) {
      const p = byProduct.get(String(v.product_id));
      const unit = units.get(String(p.base_unit_id));
      const vb = p.track_batch ? batchRows.filter((x) => String(x.variant_id) === String(v._id)) : [];
      if (vb.length) {
        vb.sort((a, b2) => (a.expiry_date || 0) - (b2.expiry_date || 0)).forEach((x) => {
          const bt = batches.get(String(x.batch_id));
          lines.push(lineOf(v, p, unit, { batch_id: x.batch_id, batch_no: bt?.batch_no || null, expiry_date: bt?.expiry_date || null }));
        });
      } else lines.push(lineOf(v, p, unit));
    }
    if (!lines.length) return bad(res, "គ្មានទំនិញសម្រាប់រាប់ (ពិនិត្យប្រភេទទំនិញ)");
    if (lines.length > MAX_LINES) return bad(res, `ទំនិញច្រើនពេក (${lines.length}) — សូមរាប់តាមប្រភេទ`);
    const date = b.doc_date ? toDate(b.doc_date) : new Date();
    const userId = req.session.user_id;
    const doc = await StockCountModel.create({
      doc_no: await nextNo("SC", { date }),
      doc_date: date || new Date(),
      warehouse_id: whId,
      category_id: categoryId,
      note: String(b.note || "").slice(0, 500),
      lines,
      total_lines: lines.length,
      created_by: userId,
      updated_by: userId,
    });
    await log(req, `${DOC} ${doc.doc_no} ត្រូវបានបង្កើត (${lines.length} ជួរ)`);
    send(res, doc._id, req, `${DOC} ${doc.doc_no} ត្រូវបានបង្កើត — ចាប់ផ្តើមរាប់បាន!`, 201);
  }));

  // ---------------- list (no lines) ----------------
  prop.app.get(url, ...viewGuard, wrap(async (req, res) => {
    const { state, warehouse_id, q, ...rest } = req.query;
    const extra = [];
    if (req.warehouse_ids) extra.push({ warehouse_id: { $in: req.warehouse_ids } });
    if (state) extra.push({ state: { $in: String(state).split(",") } });
    if (isId(warehouse_id)) extra.push({ warehouse_id: new mongoose.Types.ObjectId(warehouse_id) });
    const text = typeof q === "string" ? q.trim() : "";
    if (text) extra.push({ $or: [{ doc_no: { $regex: escapeRegex(text), $options: "i" } }, { note: { $regex: escapeRegex(text), $options: "i" } }] });
    if (!rest.sort) rest.sort = "created_date";
    rest.includeDeleted = "true";
    const r = await getFilteredMongoDB(rest, StockCountModel, POPULATE, extra, "-lines");
    res.status(200).json({ success: true, data: r.data.map((d) => shape(d, req)), pagination: r.pagination });
  }));

  prop.app.get(`${url}/:id`, ...viewGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await scoped(req, req.params.id).populate(POPULATE);
    if (!doc) return bad(res, `មិនមាន${DOC}`, 404);
    res.status(200).json({ success: true, data: shape(doc, req) });
  }));

  // ---------------- save counts (while counting) ----------------
  prop.app.put(`${url}/:id`, ...workGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await scoped(req, req.params.id);
    if (!doc) return bad(res, `មិនមាន${DOC}`, 404);
    if (doc.state !== "counting") return bad(res, `${DOC}នេះបានបញ្ជូនរួចហើយ (មិនអាចកែបានទេ)`);
    const b = req.body || {};
    const now = new Date();
    const byId = new Map(doc.lines.map((l) => [String(l._id), l]));
    for (const c of Array.isArray(b.counts) ? b.counts : []) {
      const l = byId.get(String(c._id));
      if (!l) continue;
      if (c.counted_qty !== undefined) {
        if (c.counted_qty === null || c.counted_qty === "") l.counted_qty = null;
        else {
          const n = Number(c.counted_qty);
          if (!Number.isFinite(n) || n < 0) return bad(res, `ចំនួនមិនត្រឹមត្រូវ (${l.sku})`);
          l.counted_qty = r4(n);
          l.counted_at = now;
        }
      }
      if (l.track_batch && !l.batch_id) {
        if (c.batch_no !== undefined) l.batch_no = String(c.batch_no || "").trim().toUpperCase() || null;
        if (c.expiry_date !== undefined) l.expiry_date = c.expiry_date ? toDate(c.expiry_date) : null;
      }
      if (c.note !== undefined) l.note = String(c.note || "").slice(0, 200);
    }
    // items found on the shelf that are not in the list (scan / SKU)
    const units = await unitsCache();
    for (const a of Array.isArray(b.add) ? b.add : []) {
      const key = String(a.sku || a.barcode || "").trim();
      const v = isId(a.variant_id)
        ? await VariantModel.findOne({ _id: a.variant_id, deleted: false }).lean()
        : key
          ? await VariantModel.findOne({ deleted: false, $or: [{ code: key.toUpperCase() }, { barcode: key }, { "unit_barcodes.barcode": key }] }).lean()
          : null;
      if (!v) return bad(res, `រកមិនឃើញទំនិញ ${key || a.variant_id || ""}`);
      const p = await ProductModel.findOne({ _id: v.product_id, deleted: false }).lean();
      if (!p || p.track_stock === false) return bad(res, `${v.code} មិនតាមដានស្តុកទេ`);
      const batchNo = p.track_batch ? String(a.batch_no || "").trim().toUpperCase() || null : null;
      if (doc.lines.some((l) => String(l.variant_id) === String(v._id) && (l.batch_no || null) === batchNo)) return bad(res, `${v.code}${batchNo ? ` [${batchNo}]` : ""} មានក្នុងបញ្ជីរួចហើយ`);
      let batchId = null;
      let expiry = a.expiry_date ? toDate(a.expiry_date) : null;
      if (batchNo) {
        const bt = await BatchModel.findOne({ variant_id: v._id, batch_no: batchNo }).lean();
        if (bt) {
          batchId = bt._id;
          expiry = bt.expiry_date;
        }
      }
      const n = a.counted_qty === undefined || a.counted_qty === null || a.counted_qty === "" ? null : Number(a.counted_qty);
      if (n !== null && (!Number.isFinite(n) || n < 0)) return bad(res, `ចំនួនមិនត្រឹមត្រូវ (${v.code})`);
      doc.lines.push(lineOf(v, p, units.get(String(p.base_unit_id)), { batch_id: batchId, batch_no: batchNo, expiry_date: expiry, counted_qty: n === null ? null : r4(n), counted_at: n === null ? null : now, added: true }));
    }
    if (doc.lines.length > MAX_LINES) return bad(res, "ជួរច្រើនពេក");
    if (b.note !== undefined) doc.note = String(b.note || "").slice(0, 500);
    totals(doc);
    doc.updated_by = req.session.user_id;
    await doc.save();
    send(res, doc._id, req, "បានរក្សាទុក");
  }));

  // ---------------- submit: take the system qty now, show differences ----------------
  prop.app.put(`${url}/submit/:id`, ...workGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await scoped(req, req.params.id);
    if (!doc) return bad(res, `មិនមាន${DOC}`, 404);
    if (doc.state !== "counting") return bad(res, `${DOC}នេះបានបញ្ជូនរួចហើយ`);
    const uncounted = req.body?.uncounted === "zero" ? "zero" : "skip";
    if (!doc.lines.some((l) => l.counted_qty !== null && l.counted_qty !== undefined) && uncounted === "skip") return bad(res, "មិនទាន់រាប់ទំនិញណាមួយទេ!");
    const noBatch = doc.lines.find((l) => l.track_batch && !l.batch_id && !l.batch_no && l.counted_qty > 0);
    if (noBatch) return bad(res, `${noBatch.sku}: សូមបញ្ចូលលេខ Batch និងថ្ងៃផុតកំណត់`);
    const vIds = [...new Set(doc.lines.map((l) => String(l.variant_id)))];
    const [bals, bbals] = await Promise.all([
      StockBalanceModel.find({ warehouse_id: doc.warehouse_id, variant_id: { $in: vIds } }).lean(),
      StockBatchBalanceModel.find({ warehouse_id: doc.warehouse_id, variant_id: { $in: vIds } }).lean(),
    ]);
    const bal = new Map(bals.map((x) => [String(x.variant_id), x.qty]));
    const bbal = new Map(bbals.map((x) => [`${x.variant_id}|${x.batch_id}`, x.qty]));
    for (const l of doc.lines) {
      // batch line → that batch; batch SKU without a batch (new batch) → 0; other SKU → its balance
      l.expected_qty = r4(l.track_batch ? (l.batch_id ? bbal.get(`${l.variant_id}|${l.batch_id}`) || 0 : 0) : bal.get(String(l.variant_id)) || 0);
      if ((l.counted_qty === null || l.counted_qty === undefined) && uncounted === "zero") l.counted_qty = 0;
      l.diff_qty = l.counted_qty === null || l.counted_qty === undefined ? null : r4(l.counted_qty - l.expected_qty);
    }
    doc.uncounted = uncounted;
    doc.state = "submitted";
    doc.submitted_by = req.session.user_id;
    doc.submitted_at = new Date();
    doc.updated_by = req.session.user_id;
    totals(doc);
    await doc.save();
    await log(req, `${DOC} ${doc.doc_no} ត្រូវបានបញ្ជូន (${doc.diff_lines} ខុសគ្នា)`);
    send(res, doc._id, req, `${DOC} ${doc.doc_no} ត្រូវបានបញ្ជូន — ${doc.diff_lines} ជួរខុសពីប្រព័ន្ធ`);
  }));

  // ---------------- reopen (central): back to counting ----------------
  prop.app.put(`${url}/reopen/:id`, ...postGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await scoped(req, req.params.id);
    if (!doc) return bad(res, `មិនមាន${DOC}`, 404);
    if (doc.state !== "submitted") return bad(res, "បើកឡើងវិញបានតែការរាប់ដែលបានបញ្ជូន");
    doc.lines.forEach((l) => {
      l.expected_qty = null;
      l.diff_qty = null;
      if (doc.uncounted === "zero" && !l.counted_at) l.counted_qty = null;
    });
    doc.state = "counting";
    doc.submitted_by = null;
    doc.submitted_at = null;
    doc.updated_by = req.session.user_id;
    totals(doc);
    await doc.save();
    await log(req, `${DOC} ${doc.doc_no} ត្រូវបានបើកឡើងវិញ`);
    send(res, doc._id, req, `${DOC} ${doc.doc_no} អាចរាប់បន្តបាន`);
  }));

  // ---------------- cancel ----------------
  prop.app.put(`${url}/cancel/:id`, ...workGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await scoped(req, req.params.id);
    if (!doc) return bad(res, `មិនមាន${DOC}`, 404);
    if (!["counting", "submitted"].includes(doc.state)) return bad(res, `${DOC}នេះមិនអាចបោះបង់បានទេ`);
    if (doc.state === "submitted" && req.warehouse_scope === "own") return bad(res, "ការរាប់ដែលបានបញ្ជូន បោះបង់បានតែការិយាល័យកណ្តាល", 403);
    doc.state = "cancelled";
    doc.cancelled_by = req.session.user_id;
    doc.cancelled_at = new Date();
    doc.updated_by = req.session.user_id;
    await doc.save();
    await log(req, `${DOC} ${doc.doc_no} ត្រូវបានបោះបង់`);
    send(res, doc._id, req, `${DOC} ${doc.doc_no} ត្រូវបានបោះបង់`);
  }));

  // ---------------- post (central): differences → one stock adjustment ----------------
  prop.app.put(`${url}/post/:id`, ...postGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const current = await scoped(req, req.params.id);
    if (!current) return bad(res, `មិនមាន${DOC}`, 404);
    if (current.state !== "submitted") return bad(res, "Post បានតែការរាប់ដែលបានបញ្ជូន");
    const userId = req.session.user_id;
    let adjDoc = null;
    const result = await inTransaction(async (session) => {
      const doc = await StockCountModel.findOne({ _id: current._id, state: "submitted" }).session(session);
      if (!doc) return null;
      const diffs = doc.lines.filter((l) => l.diff_qty);
      if (diffs.length) {
        const now = new Date();
        const adjNo = await nextNo("ADJ", { date: now, session });
        const items = diffs.map((l) => ({
          product_id: l.product_id,
          variant_id: l.variant_id,
          sku: l.sku,
          name_kh: l.name_kh,
          name_en: l.name_en,
          track_batch: l.track_batch,
          unit_id: l.unit_id,
          unit_code: l.unit_code,
          unit_name_kh: l.unit_name_kh,
          unit_name_en: l.unit_name_en,
          factor: 1,
          qty: l.diff_qty,
          base_qty: l.diff_qty,
          batch_id: l.batch_id,
          batch_no: l.batch_no,
          expiry_date: l.expiry_date,
          note: `រាប់ស្តុក ${doc.doc_no}`,
        }));
        const [adj] = await StockAdjustmentModel.create(
          [{ doc_no: adjNo, doc_date: now, warehouse_id: doc.warehouse_id, reason: "stock_count", count_id: doc._id, items, state: "draft", note: `ពីការរាប់ស្តុក ${doc.doc_no}`, created_by: userId, updated_by: userId }],
          { session },
        );
        const moves = (await postAdjustment(adj, { session, userId })) || [];
        // value of each difference (average cost of the move)
        const costBy = new Map();
        moves.forEach((m) => {
          const k = `${m.variant_id}|${m.batch_id || ""}`;
          costBy.set(k, (costBy.get(k) || 0) + (m.total_cost || 0));
        });
        let net = 0;
        diffs.forEach((l) => {
          const k = `${l.variant_id}|${l.batch_id || adj.items.find((i) => String(i.variant_id) === String(l.variant_id) && i.batch_no === l.batch_no)?.batch_id || ""}`;
          const c = costBy.get(k);
          if (c !== undefined) {
            l.diff_cost = r4(c);
            l.unit_cost = l.diff_qty ? r4(Math.abs(c / l.diff_qty)) : null;
            net += c;
          }
        });
        adj.total_qty = r4(items.reduce((t, i) => t + Math.abs(i.base_qty), 0));
        adj.posted_cost = r4(moves.reduce((t, m) => t + Math.abs(m.total_cost || 0), 0));
        adj.state = "posted";
        adj.posted_by = userId;
        adj.posted_at = now;
        await adj.save({ session });
        doc.adjustment_id = adj._id;
        doc.diff_cost = r4(net);
        adjDoc = adj;
      } else doc.diff_cost = 0;
      doc.state = "posted";
      doc.posted_by = userId;
      doc.posted_at = new Date();
      doc.updated_by = userId;
      await doc.save({ session });
      return doc;
    });
    if (result.error) return bad(res, result.error, result.status || 400);
    if (!result.result) return bad(res, "Post បានតែការរាប់ដែលបានបញ្ជូន", 409);
    await log(req, `${DOC} ${current.doc_no} ត្រូវបាន Post${adjDoc ? ` → ${adjDoc.doc_no}` : " (គ្មានខុសគ្នា)"}`);
    if (adjDoc) telegram.adjustmentPosted(adjDoc, req);
    send(res, current._id, req, adjDoc ? `បាន Post — កែតម្រូវស្តុក ${adjDoc.doc_no}` : "បាន Post — ស្តុកត្រូវគ្នាទាំងអស់ ✅");
  }));
};

module.exports = route;
