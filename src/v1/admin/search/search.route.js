const ProductModel = require("../product/item/product.model");
const VariantModel = require("../product/item/variant.model");
const CategoryModel = require("../product/category/category.model");
const BrandModel = require("../product/brand/brand.model");
const WarehouseModel = require("../setup/warehouse/warehouse.model");
const SupplierModel = require("../purchase/supplier/supplier.model");
const UserModel = require("../user/user.model");
const OpeningModel = require("../stock/opening/opening.model");
const ReceiveModel = require("../stock/receive/receive.model");
const AdjustmentModel = require("../stock/adjustment/adjustment.model");
const TransferModel = require("../stock/transfer/transfer.model");
const { escapeRegex } = require("../../../util/helper");
const { serverError } = require("../../../util/master_crud");
const { can_view_master, ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_ACCOUNTANT } = require("../../../util/permission");
const { warehouse_scope, scopeFilter } = require("../../../util/warehouse_scope");

// GET /search?q=&limit=5 → global search box (top bar / Ctrl+K)
//   { products, skus, warehouses, documents, suppliers, categories, brands, users }
// Every group follows the same rules as its own list: shop managers only see their shops' documents,
// goods receive only for central roles, users only for admins. All groups run in parallel.
const route = (prop) => {
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope];

  prop.app.get(`/${prop.main_route}/search`, ...guard, async (req, res) => {
    try {
      const text = String(req.query.q || "").trim().slice(0, 60);
      const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 10);
      const empty = { products: [], skus: [], warehouses: [], documents: [], suppliers: [], categories: [], brands: [], users: [] };
      if (text.length < 2) return res.status(200).json({ success: true, data: empty });

      const rx = { $regex: escapeRegex(text), $options: "i" };
      const upper = text.toUpperCase();
      const u = req.user;
      const isAdmin = u.is_super_admin || u.role === ROLE_ADMIN;
      const central = isAdmin || [ROLE_CENTRAL_MANAGER, ROLE_ACCOUNTANT].includes(u.role);
      const own = (fields) => scopeFilter(req, fields);
      const docs = (Model, type, extra = {}) =>
        Model.find({ doc_no: rx, ...extra })
          .select("doc_no state doc_date warehouse_id to_warehouse_id")
          .populate([{ path: "warehouse_id", select: "code" }, ...(type === "transfer" ? [{ path: "to_warehouse_id", select: "code" }] : [])])
          .sort({ doc_date: -1 })
          .limit(limit)
          .lean()
          .then((rows) => rows.map((d) => ({ type, _id: d._id, doc_no: d.doc_no, state: d.state, doc_date: d.doc_date, from: d.warehouse_id?.code, to: d.to_warehouse_id?.code })));

      const [products, skus, warehouses, opening, receive, adjustment, transfer, suppliers, categories, brands, users] = await Promise.all([
        ProductModel.find({ deleted: false, $or: [{ code: rx }, { name_kh: rx }, { name_en: rx }] })
          .select("code name_kh name_en image variant_count status")
          .sort({ sort_order: 1 })
          .limit(limit)
          .lean(),
        VariantModel.find({ deleted: false, $or: [{ code: rx }, { barcode: text }, { "unit_barcodes.barcode": text }, { name_kh: rx }, { name_en: rx }] })
          .select("code name_kh name_en barcode product_id status")
          .limit(limit)
          .lean(),
        WarehouseModel.find({ deleted: false, ...own("_id"), $or: [{ code: rx }, { name_kh: rx }, { name_en: rx }, { phone: rx }] })
          .select("code name_kh name_en type status")
          .limit(limit)
          .lean(),
        docs(OpeningModel, "opening", own("warehouse_id")),
        central ? docs(ReceiveModel, "receive") : [],
        docs(AdjustmentModel, "adjustment", own("warehouse_id")),
        docs(TransferModel, "transfer", own(["warehouse_id", "to_warehouse_id"])),
        SupplierModel.find({ deleted: false, $or: [{ code: rx }, { name: rx }, { contact_name: rx }, { phone: rx }] })
          .select("code name phone status")
          .limit(limit)
          .lean(),
        CategoryModel.find({ deleted: false, $or: [{ code: rx }, { name_kh: rx }, { name_en: rx }] }).select("code name_kh name_en").limit(limit).lean(),
        BrandModel.find({ deleted: false, $or: [{ code: rx }, { name_kh: rx }, { name_en: rx }] }).select("code name_kh name_en").limit(limit).lean(),
        isAdmin
          ? UserModel.find({ deleted: { $ne: true }, $or: [{ email: rx }, { firstname: rx }, { lastname: rx }, { contact: rx }] })
              .select("firstname lastname email role status")
              .limit(limit)
              .lean()
          : [],
      ]);

      // exact SKU / barcode first (a scanned barcode should be the first hit)
      skus.sort((a, b) => (b.code === upper || b.barcode === text) - (a.code === upper || a.barcode === text));
      const documents = [...transfer, ...adjustment, ...receive, ...opening].sort((a, b) => new Date(b.doc_date) - new Date(a.doc_date)).slice(0, limit * 2);

      res.status(200).json({ success: true, data: { products, skus, warehouses, documents, suppliers, categories, brands, users } });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
