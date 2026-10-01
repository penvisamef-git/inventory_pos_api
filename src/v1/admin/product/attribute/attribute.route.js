const AttributeModel = require("./attribute.model");
const { masterCrud } = require("../../../../util/master_crud");
const { can_manage_product, can_view_master } = require("../../../../util/permission");

const { ATTRIBUTE_TYPES } = AttributeModel;
const VALUE_CODE = /^[a-z0-9_-]{1,30}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

// /api/admin/product/attribute — Size, Color … with their values (variants use them)
const route = (prop) => {
  masterCrud({
    prop,
    baseRoute: "product/attribute",
    Model: AttributeModel,
    document: "លក្ខណៈ",
    logTitle: "attribute",
    viewGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master],
    editGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_product],
    required: [
      { key: "code", label: "កូដ" },
      { key: "name_kh", label: "ឈ្មោះ (ខ្មែរ)" },
    ],
    codePattern: /^[a-z0-9_]{2,30}$/,
    codeHint: "កូដត្រូវជាអក្សរអង់គ្លេសតូច លេខ ឬ _ (2–30 តួ) ឧ. size, color",
    listFilter: (req) => (ATTRIBUTE_TYPES.includes(req.query.type) ? [{ type: req.query.type }] : []),
    // values: [{ _id?, code, name_kh, name_en, color_hex, sort_order, status }]
    normalize: async (f, { current }) => {
      if (f.type !== undefined && !ATTRIBUTE_TYPES.includes(f.type)) {
        return { error: `ប្រភេទមិនត្រឹមត្រូវ! (${ATTRIBUTE_TYPES.join(" | ")})` };
      }
      if (f.values !== undefined) {
        if (!Array.isArray(f.values)) return { error: "values ត្រូវជាបញ្ជី!" };
        const seen = new Set();
        const values = [];
        for (const [i, v] of f.values.entries()) {
          const code = String(v?.code || "").trim().toLowerCase();
          if (!VALUE_CODE.test(code)) return { error: `តម្លៃទី ${i + 1}: កូដត្រូវជាអក្សរតូច លេខ _ ឬ - ឧ. 6-12m, pink` };
          if (!String(v?.name_kh || "").trim()) return { error: `តម្លៃទី ${i + 1}: សូមបញ្ចូលឈ្មោះ (ខ្មែរ)` };
          if (seen.has(code)) return { error: `កូដតម្លៃ "${code}" ស្ទួនគ្នា!` };
          if (v.color_hex && !HEX.test(v.color_hex)) return { error: `តម្លៃទី ${i + 1}: ពណ៌ត្រូវជា #RRGGBB` };
          seen.add(code);
          const row = {
            code,
            name_kh: String(v.name_kh).trim(),
            name_en: v.name_en ? String(v.name_en).trim() : "",
            color_hex: v.color_hex || null,
            sort_order: Number.isFinite(Number(v.sort_order)) ? Number(v.sort_order) : i,
            status: v.status !== false,
          };
          // keep the id → variants keep pointing to it (matched by _id, else by code)
          const old = current && current.values.find((x) => (v._id && String(x._id) === String(v._id)) || x.code === code);
          if (old) row._id = old._id;
          else if (v._id) row._id = v._id;
          values.push(row);
        }
        // a value used by a variant cannot be removed (turn status off instead)
        if (current) {
          const kept = new Set(values.filter((x) => x._id).map((x) => String(x._id)));
          const removed = current.values.filter((x) => !kept.has(String(x._id)));
          if (removed.length) {
            const VariantModel = require("../item/variant.model");
            const used = await VariantModel.findOne({ deleted: false, "options.value_id": { $in: removed.map((x) => x._id) } }).select("code").lean();
            if (used) {
              return { error: `មិនអាចលុបតម្លៃបានទេ ព្រោះប្រភេទរង ${used.code} កំពុងប្រើ (អាចបិទ status ជំនួស)!` };
            }
          }
        }
        f.values = values;
      }
      if (f.sort_order !== undefined) f.sort_order = Number(f.sort_order) || 0;
      return f;
    },
    beforeDelete: async (doc) => {
      const ProductModel = require("../item/product.model");
      return (await ProductModel.exists({ attribute_ids: doc._id, deleted: false })) ? "មិនអាចលុបបានទេ ព្រោះមានទំនិញកំពុងប្រើលក្ខណៈនេះ!" : null;
    },
  });
};

module.exports = route;
