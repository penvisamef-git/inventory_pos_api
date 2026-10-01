const mongoose = require("mongoose");
const CategoryModel = require("./model");
const { CATEGORY_TYPES } = require("./model");
const SectionModel = require("../section/model");
const ItemModel = require("../item/model");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { checkValidtion, pick, removeEmpty } = require("../../../../util/helper");
const { saveSortOrder } = require("../../../../util/sort_order");
const { can_manage_menu } = require("../../../../util/permission");
const baseRoute = "menu/category";

// Fields the client may send
const FIELDS = [
  "code",
  "name_en",
  "name_kh",
  "name_cn",
  "type",
  "icon",
  "serve_from",
  "serve_to",
  "intro_en",
  "intro_kh",
  "intro_cn",
  "sort_order",
  "note",
  "status",
];

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  // Log
  const logTitle = "category";
  // Error Content
  const document = "ប្រភេទម្ហូប";

  function updatedText(name) {
    return `${document} ${name} ត្រូវបានកែប្រែ និងរក្សារទុក!`;
  }
  function deletedText(name) {
    return `${document} ${name} ត្រូវបានលុបចេញពីប្រព័ន្ធ!`;
  }
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const existsText = `កូដ${document}នេះ មាននៅក្នុងប្រព័ន្ធរួចហើយ!`;
  const noDataFound = `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!`;
  const newSave = `${document} ថ្មីត្រូវបានរក្សារទុក!`;
  const noIDFound = "មិនមាន ID ត្រឹមត្រូវ!";
  const noDataUpdate = "មិនមានទិន្នន័យដើម្បីកែប្រែ!";
  const hasChildError = `មិនអាចលុប${document}បានទេ ព្រោះនៅមានម្ហូប ឬផ្នែកនៅក្នុងនោះ!`;
  const typeInvalid = `ប្រភេទមិនត្រឹមត្រូវ! (${CATEGORY_TYPES.join(" | ")})`;
  const timeInvalid = "ម៉ោងមិនត្រឹមត្រូវ! (ទម្រង់ HH:mm ឧ. 06:00)";

  const guardRead = [prop.api_auth, prop.jwt_auth, prop.request_user];
  const guardWrite = [...guardRead, can_manage_menu];

  // ******************** Helper ****************************
  const isTime = (v) => v === "" || v === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));

  // Returns an error message or null
  function validateBody(body) {
    if (body.type !== undefined && !CATEGORY_TYPES.includes(body.type)) return typeInvalid;
    if (body.serve_from !== undefined && !isTime(body.serve_from)) return timeInvalid;
    if (body.serve_to !== undefined && !isTime(body.serve_to)) return timeInvalid;
    return null;
  }

  // ===================================== CREATE ================================================
  prop.app.post(`${urlAPI}`, ...guardWrite, async (req, res) => {
    try {
      const requiredFields = [
        { key: "code", label: "កូដ (ឧ. breakfast)" },
        { key: "name_en", label: "ឈ្មោះ (អង់គ្លេស)" },
      ];
      if (!checkValidtion(res, req, requiredFields)) return;

      const body = pick(req.body, FIELDS);
      const error = validateBody(body);
      if (error) return res.status(400).json({ success: false, message: error });

      const { user_id: userId } = req.session;
      body.code = String(body.code).trim().toLowerCase();

      // ✅ Check duplicate code
      const exists = await CategoryModel.exists({ code: body.code, deleted: false });
      if (exists) {
        return res.status(409).json({ success: false, message: existsText });
      }

      // ✅ New category goes to the end of the list
      if (body.sort_order === undefined) {
        body.sort_order = await CategoryModel.countDocuments({ deleted: false });
      }

      const saveData = await CategoryModel.create({
        ...body,
        deleted: false,
        created_by: userId,
        updated_by: userId,
      });

      await logActivity({
        title: `${document}ថ្មី ${saveData.name_en} ត្រូវបានបង្កើត!`,
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
  // Extra: ?type=food|drink
  prop.app.get(`${urlAPI}`, ...guardRead, async (req, res) => {
    try {
      const extra = [];
      if (CATEGORY_TYPES.includes(req.query.type)) extra.push({ type: req.query.type });

      const query = { sort: "sort_order", order: "asc", ...req.query };
      const result = await getFilteredMongoDB(query, CategoryModel, [], extra);

      // Count items per category (for the admin table)
      const ids = result.data.map((c) => c._id);
      const counts = await ItemModel.aggregate([
        { $match: { category_id: { $in: ids }, deleted: false } },
        { $group: { _id: "$category_id", total: { $sum: 1 } } },
      ]);
      const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c.total]));
      const data = result.data.map((c) => ({ ...c.toObject(), item_count: countMap[String(c._id)] || 0 }));

      res.status(200).json({ success: true, data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===================================== GET ALL (dropdown) ================================================
  prop.app.get(`${urlAPI}-all`, ...guardRead, async (req, res) => {
    try {
      const filter = { deleted: false };
      if (CATEGORY_TYPES.includes(req.query.type)) filter.type = req.query.type;

      const result = await CategoryModel.find(filter).sort({ sort_order: 1, created_date: 1 });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
  });

  // ===================================== SORT (drag & drop) ================================================
  // body: { items: [{ _id, sort_order }] }
  prop.app.put(`${urlAPI}-sort`, ...guardWrite, async (req, res) => {
    try {
      const result = await saveSortOrder(CategoryModel, req.body?.items, req.session.user_id);
      if (!result.ok) return res.status(400).json({ success: false, message: result.message });

      await logActivity({
        title: `លំដាប់${document}ត្រូវបានផ្លាស់ប្តូរ!`,
        description: `គណនី: ${req.user.email}`,
        categoryTitle: logTitle,
        createdBy: req.session.user_id,
        req,
      });

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

      const data = await CategoryModel.findOne({ _id: id, deleted: false });
      if (!data) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

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

      const updateFields = removeEmpty({ ...pick(req.body, FIELDS), updated_by: userId });
      if (Object.keys(updateFields).length === 1) {
        return res.status(400).json({ success: false, message: noDataUpdate });
      }

      const error = validateBody(updateFields);
      if (error) return res.status(400).json({ success: false, message: error });

      if (updateFields.code !== undefined) {
        updateFields.code = String(updateFields.code).trim().toLowerCase();
        const exists = await CategoryModel.exists({ code: updateFields.code, deleted: false, _id: { $ne: id } });
        if (exists) return res.status(409).json({ success: false, message: existsText });
      }

      const updatedData = await CategoryModel.findOneAndUpdate(
        { _id: id, deleted: false },
        updateFields,
        { returnDocument: "after", runValidators: true },
      );

      if (!updatedData) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

      delete updateFields.updated_by;
      await logActivity({
        title: `${document} ${updatedData.name_en} ត្រូវបានកែប្រែ!`,
        description: `គណនី: ${req.user.email} បានកែប្រែព័ត៌មានដូចជា : ${JSON.stringify(updateFields)}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: updatedData, message: updatedText(updatedData.name_en) });
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

      // ✅ Block delete while items / sections still belong to this category
      const [hasItem, hasSection] = await Promise.all([
        ItemModel.exists({ category_id: id, deleted: false }),
        SectionModel.exists({ category_id: id, deleted: false }),
      ]);
      if (hasItem || hasSection) {
        return res.status(400).json({ success: false, message: hasChildError });
      }

      const updatedData = await CategoryModel.findOneAndUpdate(
        { _id: id, deleted: false },
        { deleted: true, updated_by: userId },
        { returnDocument: "after" },
      );

      if (!updatedData) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

      await logActivity({
        title: `${document} ${updatedData.name_en} ត្រូវបានលុប!`,
        description: `គណនី: ${req.user.email} បានលុបទិន្នន័យចេញពីប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({
        success: true,
        data: `${document} ${updatedData.name_en} បានលុប`,
        message: deletedText(updatedData.name_en),
      });
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

      const current = await CategoryModel.findOne({ _id: id, deleted: true });
      if (!current) {
        return res.status(404).json({ success: false, message: noDataFound });
      }
      if (await CategoryModel.exists({ code: current.code, deleted: false })) {
        return res.status(409).json({ success: false, message: existsText });
      }

      current.deleted = false;
      current.updated_by = userId;
      await current.save();

      await logActivity({
        title: `${document} ${current.name_en} ត្រូវបានស្តារឡើងវិញ!`,
        description: `គណនី: ${req.user.email} បានស្តារទិន្នន័យចូលក្នុងប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: current, message: `${document} ${current.name_en} បានស្តារឡើងវិញ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
