const mongoose = require("mongoose");
const CategoryModel = require("./category.model");
const { masterCrud, serverError } = require("../../../../util/master_crud");
const { can_manage_product, can_view_master } = require("../../../../util/permission");

const parentInvalid = "ប្រភេទមេមិនត្រឹមត្រូវ ឬមិនមាននៅក្នុងប្រព័ន្ធ!";
const parentLoop = "មិនអាចដាក់ប្រភេទនេះនៅក្រោមខ្លួនឯង ឬប្រភេទកូនរបស់វាបានទេ!";
const hasChildren = "មិនអាចលុបបានទេ ព្រោះនៅមានប្រភេទកូននៅខាងក្រោម!";

// /api/admin/product/category — tree of product categories
const route = (prop) => {
  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master];

  // true when `candidate` is `id` itself or one of its children (would make a loop)
  async function wouldLoop(id, candidate) {
    let cursor = candidate ? String(candidate) : null;
    for (let i = 0; cursor && i < 20; i++) {
      if (cursor === String(id)) return true;
      const p = await CategoryModel.findById(cursor).select("parent_id").lean();
      cursor = p?.parent_id ? String(p.parent_id) : null;
    }
    return false;
  }

  // ===================================== TREE (registered before /:id) ================================================
  // → [{ ...category, children: [...] }] active rows only, sorted by sort_order
  prop.app.get(`/${prop.main_route}/product/category-tree`, ...viewGuard, async (req, res) => {
    try {
      const rows = await CategoryModel.find({ deleted: false, status: true }).sort({ sort_order: 1, code: 1 }).lean();
      const byId = new Map(rows.map((r) => [String(r._id), { ...r, children: [] }]));
      const roots = [];
      byId.forEach((node) => {
        const parent = node.parent_id && byId.get(String(node.parent_id));
        (parent ? parent.children : roots).push(node);
      });
      res.status(200).json({ success: true, data: roots });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  masterCrud({
    prop,
    baseRoute: "product/category",
    Model: CategoryModel,
    document: "ប្រភេទទំនិញ",
    logTitle: "category",
    viewGuard,
    editGuard: [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_product],
    required: [
      { key: "code", label: "កូដ" },
      { key: "name_kh", label: "ឈ្មោះ (ខ្មែរ)" },
    ],
    codePattern: /^[a-z0-9_]{2,40}$/,
    codeHint: "កូដត្រូវជាអក្សរអង់គ្លេសតូច លេខ ឬ _ (2–40 តួ) ឧ. clothing_tops",
    populate: [{ path: "parent_id", select: "code name_kh name_en" }],
    // ?parent_id=<id> (children) · ?parent_id=root (top level)
    listFilter: (req) => {
      const p = req.query.parent_id;
      if (p === "root") return [{ parent_id: null }];
      if (mongoose.Types.ObjectId.isValid(p)) return [{ parent_id: new mongoose.Types.ObjectId(p) }];
      return [];
    },
    // child_count + product_count on every row
    afterList: async (rows) => {
      const ids = rows.map((r) => r._id);
      const counts = await CategoryModel.aggregate([
        { $match: { parent_id: { $in: ids }, deleted: false } },
        { $group: { _id: "$parent_id", n: { $sum: 1 } } },
      ]);
      const map = new Map(counts.map((c) => [String(c._id), c.n]));
      const ProductModel = require("../item/product.model");
      const pCounts = await ProductModel.aggregate([
        { $match: { category_id: { $in: ids }, deleted: false } },
        { $group: { _id: "$category_id", n: { $sum: 1 } } },
      ]);
      const pMap = new Map(pCounts.map((c) => [String(c._id), c.n]));
      return rows.map((r) => ({ ...r.toJSON(), child_count: map.get(String(r._id)) || 0, product_count: pMap.get(String(r._id)) || 0 }));
    },
    normalize: async (f, { isCreate, current }) => {
      if (f.parent_id === "" || f.parent_id === undefined) {
        if (isCreate) f.parent_id = null;
        else if (f.parent_id === "") f.parent_id = null;
      }
      if (f.parent_id) {
        if (!mongoose.Types.ObjectId.isValid(f.parent_id)) return { error: parentInvalid };
        if (!(await CategoryModel.exists({ _id: f.parent_id, deleted: false }))) return { error: parentInvalid };
        if (current && (await wouldLoop(current._id, f.parent_id))) return { error: parentLoop };
      }
      if (f.sort_order !== undefined) f.sort_order = Number(f.sort_order) || 0;
      return f;
    },
    beforeDelete: async (doc) => {
      if (await CategoryModel.exists({ parent_id: doc._id, deleted: false })) return hasChildren;
      const ProductModel = require("../item/product.model");
      if (await ProductModel.exists({ category_id: doc._id, deleted: false })) return "មិនអាចលុបបានទេ ព្រោះមានទំនិញនៅក្នុងប្រភេទនេះ!";
      return null;
    },
  });
};

module.exports = route;
