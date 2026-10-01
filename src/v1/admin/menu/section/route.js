const mongoose = require("mongoose");
const SectionModel = require("./model");
const { SECTION_STYLES } = require("./model");
const CategoryModel = require("../category/model");
const ItemModel = require("../item/model");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { checkValidtion, pick, removeEmpty } = require("../../../../util/helper");
const { saveSortOrder } = require("../../../../util/sort_order");
const { can_manage_menu } = require("../../../../util/permission");
const baseRoute = "menu/section";

const FIELDS = ["category_id", "name_en", "name_kh", "name_cn", "subtitle", "style", "sort_order", "note", "status"];

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  // Log
  const logTitle = "menu_section";
  // Error Content
  const document = "ផ្នែកម៉ឺនុយ";

  function updatedText(name) {
    return `${document} ${name} ត្រូវបានកែប្រែ និងរក្សារទុក!`;
  }
  function deletedText(name) {
    return `${document} ${name} ត្រូវបានលុបចេញពីប្រព័ន្ធ!`;
  }
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const existsText = `${document}នេះ មាននៅក្នុងប្រភេទនេះរួចហើយ!`;
  const noDataFound = `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!`;
  const newSave = `${document} ថ្មីត្រូវបានរក្សារទុក!`;
  const noIDFound = "មិនមាន ID ត្រឹមត្រូវ!";
  const noDataUpdate = "មិនមានទិន្នន័យដើម្បីកែប្រែ!";
  const categoryNotFound = "រកមិនឃើញប្រភេទម្ហូប!";
  const hasChildError = `មិនអាចលុប${document}បានទេ ព្រោះនៅមានម្ហូបក្នុងនោះ!`;
  const styleInvalid = `រចនាប័ទ្មមិនត្រឹមត្រូវ! (${SECTION_STYLES.join(" | ")})`;

  const guardRead = [prop.api_auth, prop.jwt_auth, prop.request_user];
  const guardWrite = [...guardRead, can_manage_menu];

  // ******************** Helper ****************************
  async function checkCategory(category_id) {
    if (!mongoose.Types.ObjectId.isValid(category_id)) return { status: 400, message: noIDFound };
    const ok = await CategoryModel.exists({ _id: category_id, deleted: false });
    return ok ? null : { status: 404, message: categoryNotFound };
  }

  // ===================================== CREATE ================================================
  prop.app.post(`${urlAPI}`, ...guardWrite, async (req, res) => {
    try {
      const requiredFields = [
        { key: "category_id", label: "ប្រភេទម្ហូប" },
        { key: "name_en", label: "ឈ្មោះ (អង់គ្លេស)" },
      ];
      if (!checkValidtion(res, req, requiredFields)) return;

      const body = pick(req.body, FIELDS);
      const { user_id: userId } = req.session;

      if (body.style !== undefined && !SECTION_STYLES.includes(body.style)) {
        return res.status(400).json({ success: false, message: styleInvalid });
      }
      const catError = await checkCategory(body.category_id);
      if (catError) return res.status(catError.status).json({ success: false, message: catError.message });

      const exists = await SectionModel.exists({
        category_id: body.category_id,
        name_en: body.name_en,
        deleted: false,
      });
      if (exists) return res.status(409).json({ success: false, message: existsText });

      if (body.sort_order === undefined) {
        body.sort_order = await SectionModel.countDocuments({ category_id: body.category_id, deleted: false });
      }

      const saveData = await SectionModel.create({
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
  // Extra: ?category_id=<id>
  prop.app.get(`${urlAPI}`, ...guardRead, async (req, res) => {
    try {
      const extra = [];
      if (mongoose.Types.ObjectId.isValid(req.query.category_id)) {
        extra.push({ category_id: new mongoose.Types.ObjectId(String(req.query.category_id)) });
      }

      const query = { sort: "sort_order", order: "asc", ...req.query };
      const result = await getFilteredMongoDB(
        query,
        SectionModel,
        [{ path: "category_id", select: "code name_en name_kh name_cn" }],
        extra,
      );

      res.status(200).json({ success: true, data: result.data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===================================== GET ALL (dropdown) ================================================
  // ?category_id=<id>
  prop.app.get(`${urlAPI}-all`, ...guardRead, async (req, res) => {
    try {
      const filter = { deleted: false };
      if (mongoose.Types.ObjectId.isValid(req.query.category_id)) filter.category_id = req.query.category_id;

      const result = await SectionModel.find(filter).sort({ sort_order: 1, created_date: 1 });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
  });

  // ===================================== SORT (drag & drop) ================================================
  prop.app.put(`${urlAPI}-sort`, ...guardWrite, async (req, res) => {
    try {
      const result = await saveSortOrder(SectionModel, req.body?.items, req.session.user_id);
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

      const data = await SectionModel.findOne({ _id: id, deleted: false }).populate(
        "category_id",
        "code name_en name_kh name_cn",
      );
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

      const updateFields = removeEmpty({ ...pick(req.body, FIELDS), updated_by: userId });
      if (Object.keys(updateFields).length === 1) {
        return res.status(400).json({ success: false, message: noDataUpdate });
      }

      if (updateFields.style !== undefined && !SECTION_STYLES.includes(updateFields.style)) {
        return res.status(400).json({ success: false, message: styleInvalid });
      }

      const current = await SectionModel.findOne({ _id: id, deleted: false });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });

      if (updateFields.category_id !== undefined) {
        const catError = await checkCategory(updateFields.category_id);
        if (catError) return res.status(catError.status).json({ success: false, message: catError.message });

        // Items inside must follow the section to the new category
        if (String(updateFields.category_id) !== String(current.category_id)) {
          const hasItem = await ItemModel.exists({ section_id: id, deleted: false });
          if (hasItem) {
            return res.status(400).json({
              success: false,
              message: "មិនអាចប្តូរប្រភេទបានទេ ព្រោះនៅមានម្ហូបក្នុងផ្នែកនេះ!",
            });
          }
        }
      }

      const updatedData = await SectionModel.findOneAndUpdate({ _id: id, deleted: false }, updateFields, {
        returnDocument: "after",
        runValidators: true,
      });

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

      const hasItem = await ItemModel.exists({ section_id: id, deleted: false });
      if (hasItem) return res.status(400).json({ success: false, message: hasChildError });

      const updatedData = await SectionModel.findOneAndUpdate(
        { _id: id, deleted: false },
        { deleted: true, updated_by: userId },
        { returnDocument: "after" },
      );
      if (!updatedData) return res.status(404).json({ success: false, message: noDataFound });

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

      const current = await SectionModel.findOne({ _id: id, deleted: true });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });

      const catError = await checkCategory(current.category_id);
      if (catError) return res.status(catError.status).json({ success: false, message: catError.message });

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
