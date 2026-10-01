const UnitModel = require("./unit.model");
const { masterCrud } = require("../../../../util/master_crud");
const { can_manage_product, can_view_master } = require("../../../../util/permission");

// /api/admin/product/unit — view: all web roles · edit: admin, central manager
const route = (prop) => {
  masterCrud({
    prop,
    baseRoute: "product/unit",
    Model: UnitModel,
    document: "ឯកតា",
    logTitle: "unit",
    viewGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master],
    editGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_product],
    required: [
      { key: "code", label: "កូដ" },
      { key: "name_kh", label: "ឈ្មោះ (ខ្មែរ)" },
    ],
    codePattern: /^[a-z0-9_]{1,20}$/,
    codeHint: "កូដត្រូវជាអក្សរអង់គ្លេសតូច លេខ ឬ _ (1–20 តួ) ឧ. pcs, box",
    beforeDelete: async (doc) => {
      const ProductModel = require("../item/product.model");
      const used = await ProductModel.exists({ deleted: false, $or: [{ base_unit_id: doc._id }, { "units.unit_id": doc._id }] });
      return used ? "មិនអាចលុបបានទេ ព្រោះមានទំនិញកំពុងប្រើឯកតានេះ!" : null;
    },
  });
};

module.exports = route;
