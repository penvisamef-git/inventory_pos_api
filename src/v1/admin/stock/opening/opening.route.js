const StockOpeningModel = require("./opening.model");
const WarehouseModel = require("../../setup/warehouse/warehouse.model");
const { stockDocRoutes } = require("../stock.doc");
const { normalizeItems, isId, toDate } = require("../stock.items");
const { postMovements, getBatch } = require("../stock.engine");
const { can_manage_stock, can_view_master } = require("../../../../util/permission");
const { warehouse_scope } = require("../../../../util/warehouse_scope");

// /api/admin/stock/opening — admin, central manager (any warehouse)
// items: [{ variant_id | sku, unit_id | unit, qty, unit_cost (per unit), batch_no, expiry_date, mfg_date }]
const route = (prop) => {
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_stock, warehouse_scope];
  stockDocRoutes({
    prop,
    baseRoute: "stock/opening",
    Model: StockOpeningModel,
    prefix: "OB",
    document: "ស្តុកដើមគ្រា",
    logTitle: "stock_opening",
    viewGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope],
    editGuard: guard,
    postGuard: guard,
    build: async (b) => {
      if (!isId(b.warehouse_id) || !(await WarehouseModel.exists({ _id: b.warehouse_id, deleted: false })))
        return { error: "សូមជ្រើសរើសឃ្លាំង!" };
      const date = b.doc_date ? toDate(b.doc_date) : new Date();
      if (!date) return { error: "កាលបរិច្ឆេទមិនត្រឹមត្រូវ!" };
      const r = await normalizeItems(b.items, { cost: "required", batch: "in" });
      if (r.error) return r;
      return { warehouse_id: b.warehouse_id, doc_date: date, note: b.note || "", items: r.items };
    },
    post: async (doc, { session, userId }) => {
      const lines = [];
      for (const it of doc.items) {
        let batchId = null;
        if (it.track_batch) {
          const batch = await getBatch({ ...it.toObject(), cost: it.base_unit_cost, source: { type: "opening", id: doc._id, no: doc.doc_no }, session, userId });
          batchId = batch._id;
          it.batch_id = batchId;
        }
        lines.push({ warehouse_id: doc.warehouse_id, product_id: it.product_id, variant_id: it.variant_id, batch_id: batchId, type: "opening", qty: it.base_qty, unit_cost: it.base_unit_cost, label: it.sku });
      }
      return postMovements(lines, { session, userId, date: new Date(), ref_type: "opening", ref_id: doc._id, ref_no: doc.doc_no });
    },
  });
};

module.exports = route;
