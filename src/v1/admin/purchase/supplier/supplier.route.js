const SupplierModel = require("./supplier.model");
const { masterCrud } = require("../../../../util/master_crud");
const { can_manage_stock, can_view_master } = require("../../../../util/permission");

// /api/admin/purchase/supplier — view: all web roles · edit: admin, central manager
const route = (prop) => {
  masterCrud({
    prop,
    baseRoute: "purchase/supplier",
    Model: SupplierModel,
    document: "អ្នកផ្គត់ផ្គង់",
    logTitle: "supplier",
    viewGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master],
    editGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_stock],
    required: [
      { key: "code", label: "កូដ" },
      { key: "name", label: "ឈ្មោះ" },
    ],
    codePattern: /^[a-z0-9_]{2,30}$/,
    codeHint: "កូដត្រូវជាអក្សរអង់គ្លេសតូច លេខ ឬ _ (2–30 តួ)",
    nameOf: (d) => `${d.name} (${d.code})`,
    normalize: async (f) => {
      if (f.payment_term_days !== undefined) f.payment_term_days = Math.max(0, parseInt(f.payment_term_days, 10) || 0);
      if (f.sort_order !== undefined) f.sort_order = Number(f.sort_order) || 0;
      return f;
    },
    beforeDelete: async (doc) => {
      const GoodsReceiveModel = require("../../stock/receive/receive.model");
      return (await GoodsReceiveModel.exists({ supplier_id: doc._id, state: { $ne: "cancelled" } })) ? "មិនអាចលុបបានទេ ព្រោះមានការទទួលទំនិញពីអ្នកផ្គត់ផ្គង់នេះ!" : null;
    },
    allSort: { sort_order: 1, name: 1 },
  });
};

module.exports = route;
