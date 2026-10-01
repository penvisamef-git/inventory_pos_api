const mongoose = require("mongoose");
const BannerModel = require("./model");
const { BANNER_TYPES } = require("./model");
const CategoryModel = require("../category/model");
const ItemModel = require("../item/model");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { checkValidtion, pick, removeEmpty } = require("../../../../util/helper");
const { saveSortOrder } = require("../../../../util/sort_order");
const { can_manage_menu } = require("../../../../util/permission");
const baseRoute = "menu/banner";

const FIELDS = [
  "type",
  "title",
  "subtitle",
  "image",
  "category_id",
  "menu_item_id",
  "link_url",
  "start_date",
  "end_date",
  "sort_order",
  "note",
  "status",
];

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  // Log
  const logTitle = "banner";
  // Error Content
  const document = "ផ្ទាំងរូបភាព";

  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const noDataFound = `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!`;
  const newSave = `${document} ថ្មីត្រូវបានរក្សារទុក!`;
  const updated = `${document} ត្រូវបានកែប្រែ និងរក្សារទុក!`;
  const deleted = `${document} ត្រូវបានលុបចេញពីប្រព័ន្ធ!`;
  const noIDFound = "មិនមាន ID ត្រឹមត្រូវ!";
  const noDataUpdate = "មិនមានទិន្នន័យដើម្បីកែប្រែ!";
  const typeInvalid = `ប្រភេទមិនត្រឹមត្រូវ! (${BANNER_TYPES.join(" | ")})`;
  const imageInvalid = "សូមបញ្ចូលរូបភាព (image.url)";
  const dateInvalid = "កាលបរិច្ឆេទមិនត្រឹមត្រូវ!";

  const guardRead = [prop.api_auth, prop.jwt_auth, prop.request_user];
  const guardWrite = [...guardRead, can_manage_menu];

  // ******************** Helper ****************************
  // Validates + cleans body. Returns {status,message} or null.
  async function validate(body) {
    if (body.type !== undefined && !BANNER_TYPES.includes(body.type)) return { status: 400, message: typeInvalid };
    if (body.image !== undefined && !(body.image && body.image.url)) return { status: 400, message: imageInvalid };

    for (const key of ["category_id", "menu_item_id", "start_date", "end_date"]) {
      if (body[key] === "") body[key] = null;
    }
    for (const key of ["start_date", "end_date"]) {
      if (body[key] && isNaN(new Date(body[key]).getTime())) return { status: 400, message: dateInvalid };
    }
    if (body.category_id) {
      if (!mongoose.Types.ObjectId.isValid(body.category_id)) return { status: 400, message: noIDFound };
      if (!(await CategoryModel.exists({ _id: body.category_id, deleted: false }))) {
        return { status: 404, message: "រកមិនឃើញប្រភេទម្ហូប!" };
      }
    }
    if (body.menu_item_id) {
      if (!mongoose.Types.ObjectId.isValid(body.menu_item_id)) return { status: 400, message: noIDFound };
      if (!(await ItemModel.exists({ _id: body.menu_item_id, deleted: false }))) {
        return { status: 404, message: "រកមិនឃើញម្ហូប!" };
      }
    }
    return null;
  }

  const populate = [
    { path: "category_id", select: "code name_en name_kh" },
    { path: "menu_item_id", select: "code name_en name_kh price price_type sizes image" },
  ];

  // ===================================== CREATE ================================================
  prop.app.post(`${urlAPI}`, ...guardWrite, async (req, res) => {
    try {
      const requiredFields = [{ key: "image", label: "រូបភាព" }];
      if (!checkValidtion(res, req, requiredFields)) return;

      const body = pick(req.body, FIELDS);
      const { user_id: userId } = req.session;

      const error = await validate(body);
      if (error) return res.status(error.status).json({ success: false, message: error.message });

      if (body.sort_order === undefined) {
        body.sort_order = await BannerModel.countDocuments({ type: body.type || "hero", deleted: false });
      }

      const saveData = await BannerModel.create({
        ...body,
        deleted: false,
        created_by: userId,
        updated_by: userId,
      });

      await logActivity({
        title: `${document}ថ្មី (${saveData.type}) ${saveData.title || ""} ត្រូវបានបង្កើត!`,
        description: `បង្កើតដោយគណនី: ${req.user.email}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(201).json({ success: true, data: saveData, message: newSave });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET LIST (with filter + pagination) ================================================
  // Extra: ?type=hero|highlight|promo &category_id=<id>
  prop.app.get(`${urlAPI}`, ...guardRead, async (req, res) => {
    try {
      const extra = [];
      if (BANNER_TYPES.includes(req.query.type)) extra.push({ type: req.query.type });
      if (mongoose.Types.ObjectId.isValid(req.query.category_id)) {
        extra.push({ category_id: new mongoose.Types.ObjectId(String(req.query.category_id)) });
      }

      const query = { sort: "sort_order", order: "asc", ...req.query };
      const result = await getFilteredMongoDB(query, BannerModel, populate, extra);

      res.status(200).json({ success: true, data: result.data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===================================== GET ALL ================================================
  prop.app.get(`${urlAPI}-all`, ...guardRead, async (req, res) => {
    try {
      const filter = { deleted: false };
      if (BANNER_TYPES.includes(req.query.type)) filter.type = req.query.type;

      const result = await BannerModel.find(filter).populate(populate).sort({ type: 1, sort_order: 1 });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
  });

  // ===================================== SORT (drag & drop) ================================================
  prop.app.put(`${urlAPI}-sort`, ...guardWrite, async (req, res) => {
    try {
      const result = await saveSortOrder(BannerModel, req.body?.items, req.session.user_id);
      if (!result.ok) return res.status(400).json({ success: false, message: result.message });
      res.status(200).json({ success: true, data: result, message: "លំដាប់ត្រូវបានរក្សារទុក!" });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET BY ID ================================================
  prop.app.get(`${urlAPI}/:id`, ...guardRead, async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const data = await BannerModel.findOne({ _id: id, deleted: false }).populate(populate);
      if (!data) return res.status(404).json({ success: false, message: noDataFound });

      return res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: "Internal Error", error: err.message });
    }
  });

  // ===================================== UPDATE ================================================
  prop.app.put(`${urlAPI}/:id`, ...guardWrite, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const body = pick(req.body, FIELDS);
      const error = await validate(body);
      if (error) return res.status(error.status).json({ success: false, message: error.message });

      // keep explicit nulls (used to clear category / item / dates)
      const updateFields = { ...body, updated_by: userId };
      Object.keys(updateFields).forEach((k) => updateFields[k] === undefined && delete updateFields[k]);
      if (Object.keys(updateFields).length === 1) {
        return res.status(400).json({ success: false, message: noDataUpdate });
      }

      const updatedData = await BannerModel.findOneAndUpdate({ _id: id, deleted: false }, updateFields, {
        returnDocument: "after",
        runValidators: true,
      });
      if (!updatedData) return res.status(404).json({ success: false, message: noDataFound });

      delete updateFields.updated_by;
      await logActivity({
        title: `${document} (${updatedData.type}) ${updatedData.title || ""} ត្រូវបានកែប្រែ!`,
        description: `គណនី: ${req.user.email} បានកែប្រែព័ត៌មានដូចជា : ${JSON.stringify(removeEmpty({ ...updateFields }))}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: updatedData, message: updated });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SOFT DELETE ================================================
  prop.app.delete(`${urlAPI}/:id`, ...guardWrite, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const updatedData = await BannerModel.findOneAndUpdate(
        { _id: id, deleted: false },
        { deleted: true, updated_by: userId },
        { returnDocument: "after" },
      );
      if (!updatedData) return res.status(404).json({ success: false, message: noDataFound });

      await logActivity({
        title: `${document} (${updatedData.type}) ${updatedData.title || ""} ត្រូវបានលុប!`,
        description: `គណនី: ${req.user.email} បានលុបទិន្នន័យចេញពីប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: `${document} បានលុប`, message: deleted });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== RESTORE ================================================
  prop.app.put(`${urlAPI}/restore/:id`, ...guardWrite, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const updatedData = await BannerModel.findOneAndUpdate(
        { _id: id, deleted: true },
        { deleted: false, updated_by: userId },
        { returnDocument: "after" },
      );
      if (!updatedData) return res.status(404).json({ success: false, message: noDataFound });

      await logActivity({
        title: `${document} (${updatedData.type}) ${updatedData.title || ""} ត្រូវបានស្តារឡើងវិញ!`,
        description: `គណនី: ${req.user.email} បានស្តារទិន្នន័យចូលក្នុងប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: updatedData, message: `${document} បានស្តារឡើងវិញ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
