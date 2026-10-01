const mongoose = require("mongoose");
const getFilteredMongoDB = require("../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../util/log");
const { nextNo } = require("../../../util/counter");
const { escapeRegex } = require("../../../util/helper");
const { serverError, noIDFound } = require("../../../util/master_crud");
const { inTransaction } = require("./stock.engine");
const { isId } = require("./stock.items");

// ---------------- schema ----------------
const allocSchema = new mongoose.Schema(
  { batch_id: { type: mongoose.Schema.Types.ObjectId, ref: "Batch" }, batch_no: String, expiry_date: Date, qty: Number },
  { _id: false },
);

// One line of a stock document (snapshot of product / unit at the time)
const itemFields = {
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  variant_id: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
  sku: String,
  name_kh: String,
  name_en: String,
  track_batch: Boolean,
  unit_id: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true },
  unit_code: String,
  unit_name_kh: String,
  unit_name_en: String,
  factor: { type: Number, default: 1 },
  qty: { type: Number, required: true }, // in the chosen unit
  base_qty: { type: Number, required: true },
  unit_cost: { type: Number, default: null }, // per chosen unit
  base_unit_cost: { type: Number, default: null },
  line_total: { type: Number, default: null },
  batch_no: { type: String, default: null },
  expiry_date: { type: Date, default: null },
  mfg_date: { type: Date, default: null },
  batch_id: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
  batches: { type: [allocSchema], default: [] }, // FEFO allocation when posted / dispatched
  note: { type: String, default: "" },
};

// doc_no, state, items, who / when — plus extra fields for each document type
function docSchema(extra = {}, itemExtra = {}, states = ["draft", "posted", "cancelled"]) {
  const itemSchema = new mongoose.Schema({ ...itemFields, ...itemExtra });
  const schema = new mongoose.Schema(
    {
      doc_no: { type: String, required: true },
      doc_date: { type: Date, required: true },
      warehouse_id: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
      items: { type: [itemSchema], default: [] },
      total_qty: { type: Number, default: 0 },
      total_cost: { type: Number, default: 0 },
      posted_cost: { type: Number, default: null }, // real cost of the stock movements (avg cost for outs)
      state: { type: String, enum: states, default: states[0] },
      note: { type: String, default: "" },
      posted_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      posted_at: { type: Date, default: null },
      cancelled_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      cancelled_at: { type: Date, default: null },
      created_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      ...extra,
    },
    { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
  );
  schema.index({ doc_no: 1 }, { unique: true });
  schema.index({ warehouse_id: 1, state: 1, doc_date: -1 });
  schema.index({ "items.variant_id": 1 });
  return schema;
}

const sumTotals = (items) => ({
  total_qty: items.reduce((t, i) => t + Math.abs(i.base_qty), 0),
  total_cost: Math.round(items.reduce((t, i) => t + (i.line_total || 0), 0) * 10000) / 10000,
});

const BASE_POPULATE = [
  { path: "warehouse_id", select: "code name_kh name_en type" },
  { path: "created_by", select: "firstname lastname email" },
  { path: "posted_by", select: "firstname lastname email" },
];

/**
 * Standard routes for a stock document:
 *   POST /x (draft) · GET /x · GET /x/:id · PUT /x/:id (draft) · PUT /x/cancel/:id · PUT /x/post/:id
 * o: { prop, baseRoute, Model, prefix ("GR"), document (Khmer), logTitle,
 *      viewGuard, editGuard, postGuard, scopeFields (["warehouse_id"]), populate,
 *      build(body, { req, current }) → { error, status } | fields (incl. warehouse_id, items),
 *      canEdit(req, doc) → message | null   (extra check for update / cancel / post)
 *      post(doc, { session, req, userId }) → void (throw StockError to stop)
 *      listFilter(req) → [extra filters]
 *      afterCreate(doc, req) / afterPost(doc, req) → fire-and-forget (Telegram) }
 */
function stockDocRoutes(o) {
  const url = `/${o.prop.main_route}/${o.baseRoute}`;
  const populate = [...BASE_POPULATE, ...(o.populate || [])];
  const noData = `មិនមាន${o.document}នៅក្នុងប្រព័ន្ធ!`;
  const notDraft = `${o.document}នេះមិនមែនជាសេចក្តីព្រាង (draft) ទៀតទេ!`;
  const scope = (req) => {
    if (!req.warehouse_ids) return {};
    const fields = o.scopeFields || ["warehouse_id"];
    return fields.length === 1 ? { [fields[0]]: { $in: req.warehouse_ids } } : { $or: fields.map((f) => ({ [f]: { $in: req.warehouse_ids } })) };
  };
  const findScoped = (req, id, extra = {}) => o.Model.findOne({ _id: id, ...scope(req), ...extra });
  const editable = o.editableStates || ["draft"];

  // ---------- create ----------
  o.prop.app.post(url, ...o.editGuard, async (req, res) => {
    try {
      const { user_id: userId } = req.session;
      const fields = await o.build(req.body || {}, { req, current: null });
      if (fields.error) return res.status(fields.status || 400).json({ success: false, message: fields.error });
      const doc_no = await nextNo(o.prefix, { date: fields.doc_date });
      const doc = await o.Model.create({ ...fields, ...sumTotals(fields.items), doc_no, created_by: userId, updated_by: userId });
      await logActivity({ title: `${o.document} ${doc_no} ត្រូវបានបង្កើត`, description: `គណនី: ${req.user.email} · ${fields.items.length} ជួរ`, categoryTitle: o.logTitle, createdBy: userId, req });
      if (o.afterCreate) o.afterCreate(doc, req);
      res.status(201).json({ success: true, data: await o.Model.findById(doc._id).populate(populate), message: `${o.document} ${doc_no} ត្រូវបានរក្សាទុក!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ---------- list: ?state=&warehouse_id=&from=&to=&q= (doc no / SKU) ----------
  o.prop.app.get(url, ...o.viewGuard, async (req, res) => {
    try {
      const { state, warehouse_id, from, to, q, ...rest } = req.query;
      const extra = [];
      const sc = scope(req);
      if (Object.keys(sc).length) extra.push(sc);
      if (state) extra.push({ state: { $in: String(state).split(",") } });
      if (isId(warehouse_id)) {
        const fields = o.scopeFields || ["warehouse_id"];
        const w = new mongoose.Types.ObjectId(warehouse_id);
        extra.push(fields.length === 1 ? { [fields[0]]: w } : { $or: fields.map((f) => ({ [f]: w })) });
      }
      if (from) extra.push({ doc_date: { $gte: new Date(from) } });
      if (to) extra.push({ doc_date: { $lte: new Date(to) } });
      const text = typeof q === "string" ? q.trim() : "";
      if (text) {
        const rx = { $regex: escapeRegex(text), $options: "i" };
        extra.push({ $or: [{ doc_no: rx }, { "items.sku": rx }, { "items.name_kh": rx }, { "items.name_en": rx }, { note: rx }] });
      }
      if (o.listFilter) extra.push(...o.listFilter(req));
      if (!rest.sort) rest.sort = "created_date";
      rest.includeDeleted = "true"; // documents have no soft delete (cancelled state instead)
      const result = await getFilteredMongoDB(rest, o.Model, populate, extra);
      res.status(200).json({ success: true, data: result.data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ---------- get ----------
  o.prop.app.get(`${url}/:id`, ...o.viewGuard, async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, message: noIDFound });
      const doc = await findScoped(req, req.params.id).populate(populate);
      if (!doc) return res.status(404).json({ success: false, message: noData });
      res.status(200).json({ success: true, data: doc });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ---------- update (draft) ----------
  o.prop.app.put(`${url}/:id`, ...o.editGuard, async (req, res) => {
    try {
      const { user_id: userId } = req.session;
      if (!isId(req.params.id)) return res.status(400).json({ success: false, message: noIDFound });
      const current = await findScoped(req, req.params.id);
      if (!current) return res.status(404).json({ success: false, message: noData });
      if (!editable.includes(current.state)) return res.status(400).json({ success: false, message: notDraft });
      const denied = o.canEdit && o.canEdit(req, current);
      if (denied) return res.status(403).json({ success: false, message: denied });
      const fields = await o.build({ ...current.toObject(), ...req.body }, { req, current });
      if (fields.error) return res.status(fields.status || 400).json({ success: false, message: fields.error });
      await o.Model.updateOne({ _id: current._id }, { ...fields, ...sumTotals(fields.items), updated_by: userId });
      await logActivity({ title: `${o.document} ${current.doc_no} ត្រូវបានកែប្រែ`, description: `គណនី: ${req.user.email}`, categoryTitle: o.logTitle, createdBy: userId, req });
      res.status(200).json({ success: true, data: await o.Model.findById(current._id).populate(populate), message: `${o.document} ${current.doc_no} ត្រូវបានកែប្រែ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ---------- cancel (draft) ----------
  o.prop.app.put(`${url}/cancel/:id`, ...o.editGuard, async (req, res) => {
    try {
      const { user_id: userId } = req.session;
      if (!isId(req.params.id)) return res.status(400).json({ success: false, message: noIDFound });
      const current = await findScoped(req, req.params.id);
      if (!current) return res.status(404).json({ success: false, message: noData });
      if (!editable.includes(current.state)) return res.status(400).json({ success: false, message: notDraft });
      const denied = o.canEdit && o.canEdit(req, current);
      if (denied) return res.status(403).json({ success: false, message: denied });
      current.state = "cancelled";
      current.cancelled_by = userId;
      current.cancelled_at = new Date();
      current.updated_by = userId;
      await current.save();
      await logActivity({ title: `${o.document} ${current.doc_no} ត្រូវបានបោះបង់`, description: `គណនី: ${req.user.email}`, categoryTitle: o.logTitle, createdBy: userId, req });
      res.status(200).json({ success: true, data: await o.Model.findById(current._id).populate(populate), message: `${o.document} ${current.doc_no} ត្រូវបានបោះបង់!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ---------- post → stock ----------
  if (o.post) {
    o.prop.app.put(`${url}/post/:id`, ...o.postGuard, async (req, res) => {
      try {
        const { user_id: userId } = req.session;
        if (!isId(req.params.id)) return res.status(400).json({ success: false, message: noIDFound });
        const current = await findScoped(req, req.params.id);
        if (!current) return res.status(404).json({ success: false, message: noData });
        if (current.state !== "draft") return res.status(400).json({ success: false, message: notDraft });
        const result = await inTransaction(async (session) => {
          const doc = await o.Model.findOne({ _id: current._id, state: "draft" }).session(session);
          if (!doc) return null;
          const moves = (await o.post(doc, { session, req, userId })) || [];
          doc.posted_cost = Math.round(moves.reduce((t, m) => t + Math.abs(m.total_cost || 0), 0) * 10000) / 10000;
          doc.state = "posted";
          doc.posted_by = userId;
          doc.posted_at = new Date();
          doc.updated_by = userId;
          await doc.save({ session });
          return doc;
        });
        if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });
        if (!result.result) return res.status(409).json({ success: false, message: notDraft });
        await logActivity({ title: `${o.document} ${current.doc_no} ត្រូវបាន Post ចូលស្តុក`, description: `គណនី: ${req.user.email}`, categoryTitle: o.logTitle, createdBy: userId, req });
        if (o.afterPost) o.afterPost(result.result, req);
        res.status(200).json({ success: true, data: await o.Model.findById(current._id).populate(populate), message: `${o.document} ${current.doc_no} ត្រូវបាន Post ចូលស្តុក!` });
      } catch (err) {
        res.status(500).json({ success: false, message: serverError, error: err.message });
      }
    });
  }
  return { url, populate, findScoped };
}

module.exports = { docSchema, stockDocRoutes, sumTotals, itemFields, allocSchema, BASE_POPULATE };
