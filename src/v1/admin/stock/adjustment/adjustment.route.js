const StockAdjustmentModel = require("./adjustment.model");
const WarehouseModel = require("../../setup/warehouse/warehouse.model");
const { stockDocRoutes } = require("../stock.doc");
const { normalizeItems, isId, toDate } = require("../stock.items");
const { postAdjustment } = require("./adjustment.post");
const { can_manage_stock, can_work_stock, can_view_master } = require("../../../../util/permission");
const { warehouse_scope, canAccessWarehouse } = require("../../../../util/warehouse_scope");

const telegram = require("../../telegram/telegram.hooks");
const OUT = ["damaged", "expired", "lost"];
const MANUAL = ["damaged", "expired", "lost", "found", "other"];

// /api/admin/stock/adjustment — shop manager drafts for own shop, admin / central manager post (agreed)
// body: { warehouse_id, reason, doc_date, note, items: [{ variant_id, unit_id, qty, unit_cost?, batch_no?, expiry_date?, batch_id? }] }
//   damaged / expired / lost → qty taken as OUT · found → IN · other → + in / − out
const route = (prop) => {
  stockDocRoutes({
    prop,
    baseRoute: "stock/adjustment",
    Model: StockAdjustmentModel,
    prefix: "ADJ",
    document: "ការកែតម្រូវស្តុក",
    logTitle: "stock_adjustment",
    viewGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope],
    editGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_work_stock, warehouse_scope],
    postGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_stock, warehouse_scope],
    populate: [{ path: "transfer_id", select: "doc_no" }, { path: "count_id", select: "doc_no" }],
    listFilter: (req) => (StockAdjustmentModel.REASONS.includes(req.query.reason) ? [{ reason: req.query.reason }] : []),
    canEdit: (req, doc) => (["transfer_shortage", "stock_count"].includes(doc.reason) ? "ការកែតម្រូវនេះបង្កើតដោយប្រព័ន្ធ មិនអាចកែបានទេ!" : null),
    build: async (b, { req }) => {
      const whId = b.warehouse_id?._id || b.warehouse_id;
      if (!isId(whId) || !(await WarehouseModel.exists({ _id: whId, deleted: false }))) return { error: "សូមជ្រើសរើសឃ្លាំង!" };
      if (!canAccessWarehouse(req, whId)) return { error: "អ្នកមិនមានសិទ្ធិលើឃ្លាំងនេះទេ!", status: 403 };
      if (!MANUAL.includes(b.reason)) return { error: `មូលហេតុមិនត្រឹមត្រូវ! (${MANUAL.join(" | ")})` };
      const date = b.doc_date ? toDate(b.doc_date) : new Date();
      if (!date) return { error: "កាលបរិច្ឆេទមិនត្រឹមត្រូវ!" };
      const raw = (Array.isArray(b.items) ? b.items : []).map((it) => {
        const q = Number(it?.qty);
        if (OUT.includes(b.reason)) return { ...it, qty: -Math.abs(q) };
        if (b.reason === "found") return { ...it, qty: Math.abs(q) };
        return it;
      });
      const r = await normalizeItems(raw, { cost: "optional", batch: "in", signed: true });
      if (r.error) return r;
      return { warehouse_id: whId, reason: b.reason, doc_date: date, note: b.note || "", items: r.items };
    },
    post: postAdjustment,
    afterCreate: (doc, req) => telegram.adjustmentCreated(doc, req),
    afterPost: (doc, req) => telegram.adjustmentPosted(doc, req),
  });
};

module.exports = route;
