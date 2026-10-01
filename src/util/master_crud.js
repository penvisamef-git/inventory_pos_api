const mongoose = require("mongoose");
const getFilteredMongoDB = require("./mongo_db/mongoDB_Queries");
const { logActivity } = require("./log");
const { checkValidtion, sanitizeUpdate, codeExists } = require("./helper");
const { saveSortOrder } = require("./sort_order");

const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
const noIDFound = "មិនមាន ID ត្រឹមត្រូវ!";
const noDataUpdate = "មិនមានទិន្នន័យដើម្បីកែប្រែ!";

/**
 * Standard master-data routes (same behaviour as the hand-written modules):
 *   POST /x · GET /x · GET /x-all · PUT /x-sort · GET /x/:id · PUT /x/:id · DELETE /x/:id · PUT /x/restore/:id
 *
 * options:
 *   prop, baseRoute ("product/unit"), Model
 *   document      Khmer name used in messages ("ឯកតា")
 *   logTitle      activity log category ("unit")
 *   viewGuard / editGuard   middleware arrays
 *   required      [{ key, label }] for create
 *   codePattern   RegExp for `code` (saved lowercase)
 *   codeHint      Khmer message when the code is invalid
 *   protect       extra fields the client may never send
 *   normalize     async (fields, { req, isCreate, current }) → { error } | fields  (validate + clean)
 *   beforeDelete  async (doc) → Khmer error message | null
 *   populate      populate for list / get / update
 *   listFilter    (req) → [extra mongo filters]
 *   afterList     async (rows) → rows (add counts …)
 *   allSort       sort for -all (default sort_order, code)
 */
function masterCrud(o) {
  const urlAPI = `/${o.prop.main_route}/${o.baseRoute}`;
  const doc = o.document;
  const existsText = `កូដ${doc}នេះមាននៅក្នុងប្រព័ន្ធរួចហើយ!`;
  const noDataFound = `មិនមាន${doc}នៅក្នុងប្រព័ន្ធ!`;
  const nameOf = o.nameOf || ((d) => `${d.name_kh} (${d.code})`);
  const populate = o.populate || [];
  const normalize = o.normalize || (async (f) => f);

  const cleanCode = (code) => String(code).trim().toLowerCase();
  const badCode = (code) => o.codePattern && !o.codePattern.test(cleanCode(code));

  // ===================================== CREATE ================================================
  o.prop.app.post(`${urlAPI}`, ...o.editGuard, async (req, res) => {
    try {
      if (!checkValidtion(res, req, o.required)) return;
      const { user_id: userId } = req.session;

      const body = sanitizeUpdate(req.body, o.protect || []);
      body.code = cleanCode(body.code);
      if (badCode(body.code)) return res.status(400).json({ success: false, message: o.codeHint });
      if (await codeExists(o.Model, body.code)) return res.status(409).json({ success: false, message: existsText });

      const fields = await normalize(body, { req, isCreate: true, current: null });
      if (fields.error) return res.status(400).json({ success: false, message: fields.error });

      const saveData = await o.Model.create({ ...fields, deleted: false, created_by: userId, updated_by: userId });

      await logActivity({
        title: `${doc}ថ្មី ${nameOf(saveData)} ត្រូវបានបង្កើត!`,
        description: `បង្កើតដោយគណនី: ${req.user.email}`,
        categoryTitle: o.logTitle,
        createdBy: userId,
        req,
      });
      res.status(201).json({ success: true, data: saveData, message: `${doc}ថ្មីត្រូវបានរក្សារទុក!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET LIST ================================================
  o.prop.app.get(`${urlAPI}`, ...o.viewGuard, async (req, res) => {
    try {
      const extra = o.listFilter ? o.listFilter(req) : [];
      const result = await getFilteredMongoDB(req.query, o.Model, populate, extra);
      const data = o.afterList ? await o.afterList(result.data) : result.data;
      res.status(200).json({ success: true, data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET ALL (dropdown) ================================================
  o.prop.app.get(`${urlAPI}-all`, ...o.viewGuard, async (req, res) => {
    try {
      const extra = o.listFilter ? o.listFilter(req) : [];
      const filter = { deleted: false, status: true, ...(extra.length ? { $and: extra } : {}) };
      const data = await o.Model.find(filter).populate(populate).sort(o.allSort || { sort_order: 1, code: 1 });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SORT ================================================
  o.prop.app.put(`${urlAPI}-sort`, ...o.editGuard, async (req, res) => {
    try {
      const result = await saveSortOrder(o.Model, req.body.items, req.session.user_id);
      if (!result.ok) return res.status(400).json({ success: false, message: result.message });
      res.status(200).json({ success: true, message: "លំដាប់ត្រូវបានរក្សាទុក!", data: { modified: result.modified } });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET BY ID ================================================
  o.prop.app.get(`${urlAPI}/:id`, ...o.viewGuard, async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });
      const data = await o.Model.findOne({ _id: id, deleted: false }).populate(populate);
      if (!data) return res.status(404).json({ success: false, message: noDataFound });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== UPDATE ================================================
  o.prop.app.put(`${urlAPI}/:id`, ...o.editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });

      const current = await o.Model.findOne({ _id: id, deleted: false });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });

      const body = sanitizeUpdate(req.body, ["sort_order", ...(o.protect || [])]);
      Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
      if (Object.keys(body).length === 0) return res.status(400).json({ success: false, message: noDataUpdate });

      if (body.code !== undefined) {
        body.code = cleanCode(body.code);
        if (badCode(body.code)) return res.status(400).json({ success: false, message: o.codeHint });
        if (await codeExists(o.Model, body.code, id)) return res.status(409).json({ success: false, message: existsText });
      }

      const fields = await normalize(body, { req, isCreate: false, current });
      if (fields.error) return res.status(400).json({ success: false, message: fields.error });

      const updatedData = await o.Model.findOneAndUpdate(
        { _id: id, deleted: false },
        { ...fields, updated_by: userId },
        { returnDocument: "after", runValidators: true },
      ).populate(populate);

      await logActivity({
        title: `${doc} ${nameOf(updatedData)} ត្រូវបានកែប្រែ!`,
        description: `គណនី: ${req.user.email} បានកែប្រែព័ត៌មានដូចជា : ${JSON.stringify(fields).slice(0, 500)}`,
        categoryTitle: o.logTitle,
        createdBy: userId,
        req,
      });
      res.status(200).json({ success: true, data: updatedData, message: `${doc} ${nameOf(updatedData)} ត្រូវបានកែប្រែ និងរក្សារទុក!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SOFT DELETE ================================================
  o.prop.app.delete(`${urlAPI}/:id`, ...o.editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });

      const current = await o.Model.findOne({ _id: id, deleted: false });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });
      const blocked = o.beforeDelete ? await o.beforeDelete(current) : null;
      if (blocked) return res.status(400).json({ success: false, message: blocked });

      current.deleted = true;
      current.updated_by = userId;
      await current.save();

      await logActivity({
        title: `${doc} ${nameOf(current)} ត្រូវបានលុប!`,
        description: `គណនី: ${req.user.email} បានលុបទិន្នន័យចេញពីប្រព័ន្ធ។`,
        categoryTitle: o.logTitle,
        createdBy: userId,
        req,
      });
      res.status(200).json({ success: true, data: `${doc} ${nameOf(current)} បានលុប`, message: `${doc} ${nameOf(current)} ត្រូវបានលុបចេញពីប្រព័ន្ធ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== RESTORE ================================================
  o.prop.app.put(`${urlAPI}/restore/:id`, ...o.editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });

      const current = await o.Model.findOne({ _id: id, deleted: true });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });
      if (await codeExists(o.Model, current.code)) return res.status(409).json({ success: false, message: existsText });

      current.deleted = false;
      current.updated_by = userId;
      await current.save();

      await logActivity({
        title: `${doc} ${nameOf(current)} ត្រូវបានស្តារឡើងវិញ!`,
        description: `គណនី: ${req.user.email} បានស្តារទិន្នន័យចូលក្នុងប្រព័ន្ធ។`,
        categoryTitle: o.logTitle,
        createdBy: userId,
        req,
      });
      res.status(200).json({ success: true, data: current, message: `${doc} ${nameOf(current)} បានស្តារឡើងវិញ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  return { urlAPI };
}

module.exports = { masterCrud, serverError, noIDFound };
