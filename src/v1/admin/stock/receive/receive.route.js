const GoodsReceiveModel = require("./receive.model");
const WarehouseModel = require("../../setup/warehouse/warehouse.model");
const SupplierModel = require("../../purchase/supplier/supplier.model");
const { stockDocRoutes } = require("../stock.doc");
const { normalizeItems, isId, toDate, str } = require("../stock.items");
const { postMovements, getBatch } = require("../stock.engine");
const { can_manage_stock, can_view_all } = require("../../../../util/permission");

const telegram = require("../../telegram/telegram.hooks");

// /api/admin/stock/receive — goods from a supplier into the CENTRAL warehouse only (agreed)
// view: central roles (admin, central manager, accountant) · edit / post: admin, central manager
const route = (prop) => {
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_stock];
  stockDocRoutes({
    prop,
    baseRoute: "stock/receive",
    Model: GoodsReceiveModel,
    prefix: "GR",
    document: "ការទទួលទំនិញ",
    logTitle: "goods_receive",
    viewGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_all],
    editGuard: guard,
    postGuard: guard,
    populate: [{ path: "supplier_id", select: "code name phone" }],
    listFilter: (req) => (isId(req.query.supplier_id) ? [{ supplier_id: req.query.supplier_id }] : []),
    afterPost: (doc, req) => telegram.goodsReceived(doc, req),
    build: async (b) => {
      const wh = isId(b.warehouse_id) ? await WarehouseModel.findOne({ _id: b.warehouse_id, deleted: false }).lean() : null;
      if (!wh) return { error: "សូមជ្រើសរើសឃ្លាំង!" };
      if (wh.type !== "central") return { error: "ទទួលទំនិញពីអ្នកផ្គត់ផ្គង់បានតែនៅឃ្លាំងកណ្តាលប៉ុណ្ណោះ!" };
      const supplierId = b.supplier_id?._id || b.supplier_id;
      if (!isId(supplierId) || !(await SupplierModel.exists({ _id: supplierId, deleted: false }))) return { error: "សូមជ្រើសរើសអ្នកផ្គត់ផ្គង់!" };
      const date = b.doc_date ? toDate(b.doc_date) : new Date();
      if (!date) return { error: "កាលបរិច្ឆេទមិនត្រឹមត្រូវ!" };
      const r = await normalizeItems(b.items, { cost: "required", batch: "in" });
      if (r.error) return r;
      return { warehouse_id: wh._id, supplier_id: supplierId, supplier_invoice_no: str(b.supplier_invoice_no), doc_date: date, note: b.note || "", items: r.items };
    },
    post: async (doc, { session, userId }) => {
      const lines = [];
      for (const it of doc.items) {
        let batchId = null;
        if (it.track_batch) {
          const batch = await getBatch({ ...it.toObject(), cost: it.base_unit_cost, source: { type: "goods_receive", id: doc._id, no: doc.doc_no }, session, userId });
          batchId = batch._id;
          it.batch_id = batchId;
        }
        lines.push({ warehouse_id: doc.warehouse_id, product_id: it.product_id, variant_id: it.variant_id, batch_id: batchId, type: "purchase_in", qty: it.base_qty, unit_cost: it.base_unit_cost, label: it.sku });
      }
      return postMovements(lines, { session, userId, date: new Date(), ref_type: "goods_receive", ref_id: doc._id, ref_no: doc.doc_no });
    },
  });
};

module.exports = route;
