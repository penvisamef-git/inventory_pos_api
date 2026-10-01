const BrandModel = require("./brand.model");
const { masterCrud } = require("../../../../util/master_crud");
const { can_manage_product, can_view_master } = require("../../../../util/permission");

const inUse = "មិនអាចលុបបានទេ ព្រោះមានទំនិញកំពុងប្រើម៉ាកនេះ!";

// /api/admin/product/brand — view: all web roles · edit: admin, central manager
const route = (prop) => {
  masterCrud({
    prop,
    baseRoute: "product/brand",
    Model: BrandModel,
    document: "ម៉ាក",
    logTitle: "brand",
    viewGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master],
    editGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_product],
    required: [
      { key: "code", label: "កូដ" },
      { key: "name_kh", label: "ឈ្មោះ (ខ្មែរ)" },
    ],
    codePattern: /^[a-z0-9_]{2,30}$/,
    codeHint: "កូដត្រូវជាអក្សរអង់គ្លេសតូច លេខ ឬ _ (2–30 តួ) ឧ. pampers",
    normalize: async (f) => {
      if (f.sort_order !== undefined) f.sort_order = Number(f.sort_order) || 0;
      return f;
    },
    beforeDelete: async (doc) => {
      const ProductModel = require("../item/product.model");
      return (await ProductModel.exists({ brand_id: doc._id, deleted: false })) ? inUse : null;
    },
  });
};

module.exports = route;
