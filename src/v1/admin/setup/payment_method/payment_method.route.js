const mongoose = require("mongoose");
const PaymentMethodModel = require("./payment_method.model");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { checkValidtion, sanitizeUpdate, removeEmpty, codeExists } = require("../../../../util/helper");
const { saveSortOrder } = require("../../../../util/sort_order");
const { can_manage_setup, can_view_master } = require("../../../../util/permission");
const baseRoute = "setup/payment-method";

const { PAYMENT_TYPES, PAYMENT_CURRENCIES } = PaymentMethodModel;
const CODE_PATTERN = /^[a-z0-9_]{2,30}$/;

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  const logTitle = "payment_method";
  const document = "វិធីបង់ប្រាក់";

  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const existsText = `កូដ${document}នេះមាននៅក្នុងប្រព័ន្ធរួចហើយ!`;
  const noDataFound = `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!`;
  const newSave = `${document}ថ្មីត្រូវបានរក្សារទុក!`;
  const noIDFound = "មិនមាន ID ត្រឹមត្រូវ!";
  const noDataUpdate = "មិនមានទិន្នន័យដើម្បីកែប្រែ!";
  const codeInvalid = "កូដត្រូវជាអក្សរអង់គ្លេសតូច លេខ ឬ _ (2–30 តួ) ឧ. cash_usd";
  const typeInvalid = `ប្រភេទមិនត្រឹមត្រូវ! (${PAYMENT_TYPES.join(" | ")})`;
  const currencyInvalid = `រូបិយប័ណ្ណមិនត្រឹមត្រូវ! (${PAYMENT_CURRENCIES.join(" | ")})`;

  const nameOf = (p) => `${p.name_kh} (${p.code})`;
  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master];
  const editGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_setup];

  // returns an error message or null
  function validate(body) {
    if (body.code !== undefined && !CODE_PATTERN.test(String(body.code).trim().toLowerCase())) return codeInvalid;
    if (body.type !== undefined && !PAYMENT_TYPES.includes(body.type)) return typeInvalid;
    if (body.currency !== undefined && !PAYMENT_CURRENCIES.includes(body.currency)) return currencyInvalid;
    return null;
  }

  // ===================================== CREATE ================================================
  prop.app.post(`${urlAPI}`, ...editGuard, async (req, res) => {
    try {
      const requiredFields = [
        { key: "code", label: "កូដ" },
        { key: "name_kh", label: "ឈ្មោះ (ខ្មែរ)" },
        { key: "type", label: "ប្រភេទ" },
      ];
      if (!checkValidtion(res, req, requiredFields)) return;

      const { user_id: userId } = req.session;
      const error = validate(req.body);
      if (error) return res.status(400).json({ success: false, message: error });

      const code = String(req.body.code).trim().toLowerCase();
      if (await codeExists(PaymentMethodModel, code)) {
        return res.status(409).json({ success: false, message: existsText });
      }

      const { name_kh, name_en, type, currency, requires_reference, online_mode, icon, sort_order, note, status } =
        req.body;
      const saveData = await PaymentMethodModel.create({
        code,
        name_kh,
        name_en,
        type,
        currency: currency || "any",
        requires_reference: !!requires_reference,
        online_mode: !!online_mode,
        icon: icon || null,
        sort_order: Number(sort_order) || 0,
        note,
        status,
        deleted: false,
        created_by: userId,
        updated_by: userId,
      });

      await logActivity({
        title: `${document}ថ្មី ${nameOf(saveData)} ត្រូវបានបង្កើត!`,
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

  // ===================================== GET LIST ================================================
  // ?type=cash|qr|card|bank
  prop.app.get(`${urlAPI}`, ...viewGuard, async (req, res) => {
    try {
      const extra = [];
      if (PAYMENT_TYPES.includes(req.query.type)) extra.push({ type: req.query.type });
      const result = await getFilteredMongoDB(req.query, PaymentMethodModel, [], extra);
      res.status(200).json({ success: true, data: result.data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===================================== GET ALL (POS / dropdown) ================================================
  prop.app.get(`${urlAPI}-all`, ...viewGuard, async (req, res) => {
    try {
      const data = await PaymentMethodModel.find({ deleted: false, status: true }).sort({ sort_order: 1, code: 1 });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SORT ================================================
  prop.app.put(`${urlAPI}-sort`, ...editGuard, async (req, res) => {
    try {
      const result = await saveSortOrder(PaymentMethodModel, req.body.items, req.session.user_id);
      if (!result.ok) return res.status(400).json({ success: false, message: result.message });
      res.status(200).json({ success: true, message: "លំដាប់ត្រូវបានរក្សាទុក!", data: { modified: result.modified } });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET BY ID ================================================
  prop.app.get(`${urlAPI}/:id`, ...viewGuard, async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });
      const data = await PaymentMethodModel.findOne({ _id: id, deleted: false });
      if (!data) return res.status(404).json({ success: false, message: noDataFound });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== UPDATE ================================================
  // TODO Phase 3: lock `code` once invoices use this method
  prop.app.put(`${urlAPI}/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });

      const body = sanitizeUpdate(req.body, ["sort_order"]);
      const clearIcon = body.icon === null;
      const updateFields = removeEmpty({ ...body, updated_by: userId });
      if (clearIcon) updateFields.icon = null;

      if (Object.keys(updateFields).length === 1) {
        return res.status(400).json({ success: false, message: noDataUpdate });
      }
      const error = validate(updateFields);
      if (error) return res.status(400).json({ success: false, message: error });

      if (updateFields.code !== undefined) {
        updateFields.code = String(updateFields.code).trim().toLowerCase();
        if (await codeExists(PaymentMethodModel, updateFields.code, id)) {
          return res.status(409).json({ success: false, message: existsText });
        }
      }

      const updatedData = await PaymentMethodModel.findOneAndUpdate({ _id: id, deleted: false }, updateFields, {
        returnDocument: "after",
        runValidators: true,
      });
      if (!updatedData) return res.status(404).json({ success: false, message: noDataFound });

      delete updateFields.updated_by;
      await logActivity({
        title: `${document} ${nameOf(updatedData)} ត្រូវបានកែប្រែ!`,
        description: `គណនី: ${req.user.email} បានកែប្រែព័ត៌មានដូចជា : ${JSON.stringify(updateFields)}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({
        success: true,
        data: updatedData,
        message: `${document} ${nameOf(updatedData)} ត្រូវបានកែប្រែ និងរក្សារទុក!`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SOFT DELETE ================================================
  // TODO Phase 3: block while invoices use this method
  prop.app.delete(`${urlAPI}/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });

      const updatedData = await PaymentMethodModel.findOneAndUpdate(
        { _id: id, deleted: false },
        { deleted: true, updated_by: userId },
        { returnDocument: "after" },
      );
      if (!updatedData) return res.status(404).json({ success: false, message: noDataFound });

      await logActivity({
        title: `${document} ${nameOf(updatedData)} ត្រូវបានលុប!`,
        description: `គណនី: ${req.user.email} បានលុបទិន្នន័យចេញពីប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({
        success: true,
        data: `${document} ${nameOf(updatedData)} បានលុប`,
        message: `${document} ${nameOf(updatedData)} ត្រូវបានលុបចេញពីប្រព័ន្ធ!`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== RESTORE ================================================
  prop.app.put(`${urlAPI}/restore/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });

      const current = await PaymentMethodModel.findOne({ _id: id, deleted: true });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });
      if (await codeExists(PaymentMethodModel, current.code)) {
        return res.status(409).json({ success: false, message: existsText });
      }

      current.deleted = false;
      current.updated_by = userId;
      await current.save();

      await logActivity({
        title: `${document} ${nameOf(current)} ត្រូវបានស្តារឡើងវិញ!`,
        description: `គណនី: ${req.user.email} បានស្តារទិន្នន័យចូលក្នុងប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: current, message: `${document} ${nameOf(current)} បានស្តារឡើងវិញ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
