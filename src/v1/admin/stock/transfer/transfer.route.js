const TransferModel = require("./transfer.model");
const StockAdjustmentModel = require("../adjustment/adjustment.model");
const WarehouseModel = require("../../setup/warehouse/warehouse.model");
const { stockDocRoutes } = require("../stock.doc");
const { normalizeItems, isId, toDate } = require("../stock.items");
const { inTransaction, postMovements, allocateFefo, StockError, EPS } = require("../stock.engine");
const { logActivity } = require("../../../../util/log");
const { nextNo } = require("../../../../util/counter");
const { round } = require("../../../../util/helper");
const { serverError, noIDFound } = require("../../../../util/master_crud");
const { can_work_stock, can_view_master } = require("../../../../util/permission");
const { warehouse_scope, canAccessWarehouse } = require("../../../../util/warehouse_scope");

const telegram = require("../../telegram/telegram.hooks");
const document = "ការផ្ទេរស្តុក";

// /api/admin/stock/transfer
//   shop manager: POST → "requested" (from central to own shop) · PUT own request · receive into own shop · dispatch from own shop
//   admin / central manager: POST → "draft" (any → any) · edit requested / draft · dispatch · receive
const route = (prop) => {
  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope];
  const workGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_work_stock, warehouse_scope];
  const isShopUser = (req) => !!req.warehouse_ids;

  const { url, populate, findScoped } = stockDocRoutes({
    prop,
    baseRoute: "stock/transfer",
    Model: TransferModel,
    prefix: "TR",
    document,
    logTitle: "transfer",
    viewGuard,
    editGuard: workGuard,
    scopeFields: ["warehouse_id", "to_warehouse_id"],
    editableStates: ["requested", "draft"],
    afterCreate: (doc, req) => telegram.transferCreated(doc, req),
    populate: [
      { path: "to_warehouse_id", select: "code name_kh name_en type" },
      { path: "dispatched_by", select: "firstname lastname email" },
      { path: "received_by", select: "firstname lastname email" },
      { path: "shortage_adjustment_id", select: "doc_no posted_cost" },
    ],
    listFilter: (req) => {
      const f = [];
      if (isId(req.query.from_warehouse_id)) f.push({ warehouse_id: req.query.from_warehouse_id });
      if (isId(req.query.to_warehouse_id)) f.push({ to_warehouse_id: req.query.to_warehouse_id });
      return f;
    },
    // shop manager may only change their own request
    canEdit: (req, doc) => (isShopUser(req) && doc.state !== "requested" ? "មានតែអ្នកគ្រប់គ្រងឃ្លាំងកណ្តាលទេដែលអាចកែការផ្ទេរនេះ!" : null),
    build: async (b, { req, current }) => {
      let fromId = b.warehouse_id?._id || b.warehouse_id;
      const toId = b.to_warehouse_id?._id || b.to_warehouse_id;
      if (isShopUser(req)) {
        // request: from the central warehouse to one of my shops
        if (!fromId) fromId = (await WarehouseModel.findOne({ type: "central", deleted: false, status: true }).sort({ sort_order: 1 }).lean())?._id;
        const from = isId(fromId) ? await WarehouseModel.findOne({ _id: fromId, deleted: false }).lean() : null;
        if (!from || from.type !== "central") return { error: "ហាងអាចស្នើសុំស្តុកបានតែពីឃ្លាំងកណ្តាលប៉ុណ្ណោះ!" };
        if (!isId(toId) || !canAccessWarehouse(req, toId)) return { error: "សូមជ្រើសរើសហាងរបស់អ្នក!", status: 403 };
      }
      const [from, to] = await Promise.all([
        isId(fromId) ? WarehouseModel.findOne({ _id: fromId, deleted: false }).lean() : null,
        isId(toId) ? WarehouseModel.findOne({ _id: toId, deleted: false }).lean() : null,
      ]);
      if (!from) return { error: "សូមជ្រើសរើសឃ្លាំងចេញ!" };
      if (!to) return { error: "សូមជ្រើសរើសឃ្លាំងចូល!" };
      if (String(from._id) === String(to._id)) return { error: "ឃ្លាំងចេញ និងឃ្លាំងចូលមិនអាចដូចគ្នាបានទេ!" };
      const date = b.doc_date ? toDate(b.doc_date) : new Date();
      if (!date) return { error: "កាលបរិច្ឆេទមិនត្រឹមត្រូវ!" };
      const r = await normalizeItems(b.items, { batch: "out" });
      if (r.error) return r;
      const fields = { warehouse_id: from._id, to_warehouse_id: to._id, doc_date: date, note: b.note || "", items: r.items };
      if (!current) {
        fields.state = isShopUser(req) ? "requested" : "draft";
        if (isShopUser(req)) fields.requested_items = r.items.map((i) => ({ variant_id: i.variant_id, sku: i.sku, unit_code: i.unit_code, qty: i.qty }));
      } else if (current.state === "requested" && isShopUser(req)) {
        fields.requested_items = r.items.map((i) => ({ variant_id: i.variant_id, sku: i.sku, unit_code: i.unit_code, qty: i.qty }));
      }
      return fields;
    },
  });

  // ===================================== DISPATCH → transfer_out ================================================
  // central roles: any FROM · shop manager: FROM must be own shop. Batches: given batch_id or FEFO (no expired).
  prop.app.put(`${url}/dispatch/:id`, ...workGuard, async (req, res) => {
    try {
      const { user_id: userId } = req.session;
      if (!isId(req.params.id)) return res.status(400).json({ success: false, message: noIDFound });
      const current = await findScoped(req, req.params.id);
      if (!current) return res.status(404).json({ success: false, message: `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!` });
      if (!["requested", "draft"].includes(current.state)) return res.status(400).json({ success: false, message: "ការផ្ទេរនេះត្រូវបានបញ្ជូនរួចហើយ ឬបោះបង់!" });
      if (isShopUser(req) && !canAccessWarehouse(req, current.warehouse_id))
        return res.status(403).json({ success: false, message: "មានតែឃ្លាំងចេញទេដែលអាចបញ្ជូនបាន!" });

      const result = await inTransaction(async (session) => {
        const doc = await TransferModel.findOne({ _id: current._id, state: { $in: ["requested", "draft"] } }).session(session);
        if (!doc) throw new StockError("ការផ្ទេរនេះត្រូវបានបញ្ជូនរួចហើយ!", 409);
        const now = new Date();
        const lines = [];
        const plan = []; // per item: allocations
        for (const it of doc.items) {
          const base = { warehouse_id: doc.warehouse_id, product_id: it.product_id, variant_id: it.variant_id, label: it.sku, type: "transfer_out" };
          if (it.track_batch) {
            let allocs;
            if (it.batch_id) {
              if (it.expiry_date && it.expiry_date <= now) throw new StockError(`Batch ${it.batch_no} របស់ ${it.sku} ផុតកំណត់ហើយ មិនអាចផ្ទេរបានទេ!`);
              allocs = [{ batch_id: it.batch_id, batch_no: it.batch_no, expiry_date: it.expiry_date, qty: it.base_qty }];
            } else {
              const f = await allocateFefo(doc.warehouse_id, it.variant_id, it.base_qty, { session, at: now });
              if (f.short > EPS) throw new StockError(`ស្តុក (Batch មិនទាន់ផុតកំណត់) មិនគ្រប់គ្រាន់សម្រាប់ ${it.sku} (ខ្វះ ${f.short})`);
              allocs = f.allocations;
            }
            plan.push(allocs);
            allocs.forEach((a) => lines.push({ ...base, batch_id: a.batch_id, qty: -a.qty }));
          } else {
            plan.push([]);
            lines.push({ ...base, qty: -it.base_qty });
          }
        }
        const moves = await postMovements(lines, { session, userId, date: now, ref_type: "transfer", ref_id: doc._id, ref_no: doc.doc_no });
        // cost per line = average of its out rows
        let k = 0;
        doc.items.forEach((it, i) => {
          const n = Math.max(plan[i].length, 1);
          const rows = moves.slice(k, k + n);
          k += n;
          const cost = rows.reduce((t, m) => t + Math.abs(m.total_cost), 0);
          it.batches = plan[i];
          it.base_unit_cost = it.base_qty ? round(cost / it.base_qty, 6) : 0;
          it.unit_cost = round(it.base_unit_cost * it.factor, 4);
          it.line_total = round(cost, 4);
        });
        doc.total_cost = round(doc.items.reduce((t, i) => t + (i.line_total || 0), 0), 4);
        doc.posted_cost = doc.total_cost;
        doc.state = "dispatched";
        doc.dispatched_by = userId;
        doc.dispatched_at = now;
        doc.updated_by = userId;
        await doc.save({ session });
        return doc;
      });
      if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });
      await logActivity({ title: `${document} ${current.doc_no} ត្រូវបានបញ្ជូន`, description: `គណនី: ${req.user.email}`, categoryTitle: "transfer", createdBy: userId, req });
      telegram.transferDispatched(result.result, req);
      res.status(200).json({ success: true, data: await TransferModel.findById(current._id).populate(populate), message: `${document} ${current.doc_no} ត្រូវបានបញ្ជូន!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== RECEIVE → transfer_in (+ shortage loss) ================================================
  // body: { items: [{ _id (line id), received_qty (line unit) }], note } — a missing line = received in full
  prop.app.put(`${url}/receive/:id`, ...workGuard, async (req, res) => {
    try {
      const { user_id: userId } = req.session;
      if (!isId(req.params.id)) return res.status(400).json({ success: false, message: noIDFound });
      const current = await findScoped(req, req.params.id);
      if (!current) return res.status(404).json({ success: false, message: `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!` });
      if (current.state !== "dispatched") return res.status(400).json({ success: false, message: "អាចទទួលបានតែការផ្ទេរដែលបានបញ្ជូនរួច!" });
      if (isShopUser(req) && !canAccessWarehouse(req, current.to_warehouse_id))
        return res.status(403).json({ success: false, message: "មានតែឃ្លាំងចូលទេដែលអាចទទួលបាន!" });

      const given = new Map((Array.isArray(req.body?.items) ? req.body.items : []).map((x) => [String(x?._id), x]));
      for (const it of current.items) {
        const g = given.get(String(it._id));
        if (!g || g.received_qty === undefined || g.received_qty === null || g.received_qty === "") continue;
        const q = Number(g.received_qty);
        if (!Number.isFinite(q) || q < 0) return res.status(400).json({ success: false, message: `ចំនួនទទួលមិនត្រឹមត្រូវ (${it.sku})` });
        if (q > it.qty + EPS) return res.status(400).json({ success: false, message: `ទទួលលើសចំនួនដែលបានបញ្ជូនមិនបានទេ (${it.sku}: ${it.qty} ${it.unit_code})` });
      }

      const result = await inTransaction(async (session) => {
        const doc = await TransferModel.findOne({ _id: current._id, state: "dispatched" }).session(session);
        if (!doc) throw new StockError("ការផ្ទេរនេះត្រូវបានទទួលរួចហើយ!", 409);
        const now = new Date();
        const inLines = [];
        const lossItems = [];
        for (const it of doc.items) {
          const g = given.get(String(it._id));
          const recQty = g && g.received_qty !== undefined && g.received_qty !== null && g.received_qty !== "" ? round(g.received_qty, 4) : it.qty;
          it.received_qty = recQty;
          it.received_base_qty = round(recQty * it.factor, 4);
          const base = { warehouse_id: doc.to_warehouse_id, product_id: it.product_id, variant_id: it.variant_id, label: it.sku, unit_cost: it.base_unit_cost };
          // everything that left arrives in the books, the missing part is written off right after
          if (it.batches?.length) it.batches.forEach((a) => inLines.push({ ...base, batch_id: a.batch_id, type: "transfer_in", qty: a.qty }));
          else inLines.push({ ...base, type: "transfer_in", qty: it.base_qty });
          let short = round(it.base_qty - it.received_base_qty, 4);
          if (short > EPS) {
            // lost from the last batches first
            if (it.batches?.length) {
              for (const a of [...it.batches].reverse()) {
                if (short <= EPS) break;
                const take = round(Math.min(short, a.qty), 4);
                lossItems.push({ it, qty: take, batch: a });
                short = round(short - take, 4);
              }
            } else lossItems.push({ it, qty: short, batch: null });
          }
        }
        await postMovements(inLines, { session, userId, date: now, ref_type: "transfer", ref_id: doc._id, ref_no: doc.doc_no });

        if (lossItems.length) {
          const adjNo = await nextNo("ADJ", { session });
          const items = lossItems.map(({ it, qty, batch }) => ({
            ...it.toObject(),
            _id: undefined,
            qty: -round(qty / it.factor, 4),
            base_qty: -qty,
            unit_cost: null,
            line_total: null,
            batch_id: batch?.batch_id || null,
            batch_no: batch?.batch_no || null,
            expiry_date: batch?.expiry_date || null,
            batches: batch ? [batch] : [],
            note: `ខ្វះពី ${doc.doc_no}`,
          }));
          const [adj] = await StockAdjustmentModel.create(
            [{ doc_no: adjNo, doc_date: now, warehouse_id: doc.to_warehouse_id, reason: "transfer_shortage", transfer_id: doc._id, items, state: "posted", posted_by: userId, posted_at: now, note: `ខ្វះពេលទទួល ${doc.doc_no}`, created_by: userId, updated_by: userId }],
            { session },
          );
          const moves = await postMovements(
            items.map((i) => ({ warehouse_id: doc.to_warehouse_id, product_id: i.product_id, variant_id: i.variant_id, batch_id: i.batch_id, type: "adjust_out", qty: i.base_qty, label: i.sku, note: i.note })),
            { session, userId, date: now, ref_type: "stock_adjustment", ref_id: adj._id, ref_no: adjNo },
          );
          const lossCost = round(moves.reduce((t, m) => t + Math.abs(m.total_cost), 0), 4);
          adj.total_qty = round(items.reduce((t, i) => t + Math.abs(i.base_qty), 0), 4);
          adj.posted_cost = lossCost;
          await adj.save({ session });
          doc.shortage_qty = adj.total_qty;
          doc.shortage_cost = lossCost;
          doc.shortage_adjustment_id = adj._id;
        }
        doc.state = "received";
        doc.received_by = userId;
        doc.received_at = now;
        doc.receive_note = req.body?.note || "";
        doc.updated_by = userId;
        await doc.save({ session });
        return doc;
      });
      if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });
      const doc = result.result;
      await logActivity({
        title: `${document} ${doc.doc_no} ត្រូវបានទទួល${doc.shortage_qty ? ` (ខ្វះ ${doc.shortage_qty})` : ""}`,
        description: `គណនី: ${req.user.email}`,
        categoryTitle: "transfer",
        createdBy: userId,
        req,
      });
      telegram.transferReceived(doc, req); // + shortage alert
      res.status(200).json({ success: true, data: await TransferModel.findById(doc._id).populate(populate), message: `${document} ${doc.doc_no} ត្រូវបានទទួល!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
