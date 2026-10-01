const mongoose = require("mongoose");
const WarehouseModel = require("./warehouse.model");
const UserModel = require("../../user/user.model");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { checkValidtion, sanitizeUpdate, removeEmpty, codeExists } = require("../../../../util/helper");
const { saveSortOrder } = require("../../../../util/sort_order");
const { can_manage_setup, can_view_master } = require("../../../../util/permission");
const { warehouse_scope, scopeFilter, canAccessWarehouse } = require("../../../../util/warehouse_scope");
const baseRoute = "setup/warehouse";

const { WAREHOUSE_TYPES } = WarehouseModel;

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  // Log
  const logTitle = "warehouse";
  // Error Content
  const document = "ឃ្លាំង";

  function updatedText(name) {
    return `${document} ${name} ត្រូវបានកែប្រែ និងរក្សារទុក!`;
  }
  function deletedText(name) {
    return `${document} ${name} ត្រូវបានលុបចេញពីប្រព័ន្ធ!`;
  }
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const existsText = `កូដ${document}នេះមាននៅក្នុងប្រព័ន្ធរួចហើយ!`;
  const noDataFound = `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!`;
  const newSave = `${document} ថ្មីត្រូវបានរក្សារទុក!`;
  const noIDFound = "មិនមាន ID ត្រឹមត្រូវ!";
  const noDataUpdate = "មិនមានទិន្នន័យដើម្បីកែប្រែ!";
  const typeInvalid = `ប្រភេទ${document}មិនត្រឹមត្រូវ! (${WAREHOUSE_TYPES.join(" | ")})`;
  const managerInvalid = "អ្នកគ្រប់គ្រងមិនត្រឹមត្រូវ ឬមិនមាននៅក្នុងប្រព័ន្ធ!";
  const usedByUsers = `មិនអាចលុប${document}បានទេ ព្រោះនៅមានអ្នកប្រើប្រាស់ភ្ជាប់ជាមួយ!`;

  const nameOf = (w) => `${w.name_kh} (${w.code})`;
  const populate = [{ path: "manager_id", select: "firstname lastname email" }];

  // view: every admin-web role, limited to own warehouses for shop roles · edit: admin
  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master, warehouse_scope];
  const editGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_setup];

  // manager must be an existing, active user
  async function validManager(managerId) {
    if (managerId === undefined || managerId === null || managerId === "") return true;
    if (!mongoose.Types.ObjectId.isValid(managerId)) return false;
    return !!(await UserModel.exists({ _id: managerId, deleted: false, status: true }));
  }

  // ===================================== CREATE ================================================
  // body: { code, name_kh, name_en, type: central|shop, address, phone, manager_id, allow_negative_stock, sort_order, note, status }
  prop.app.post(`${urlAPI}`, ...editGuard, async (req, res) => {
    try {
      // ✅ Validate required fields
      const requiredFields = [
        { key: "code", label: "កូដឃ្លាំង" },
        { key: "name_kh", label: "ឈ្មោះឃ្លាំង (ខ្មែរ)" },
        { key: "type", label: "ប្រភេទឃ្លាំង" },
      ];
      if (!checkValidtion(res, req, requiredFields)) return;

      const { user_id: userId } = req.session;
      const { name_kh, name_en, type, address, phone, manager_id, allow_negative_stock, sort_order, note, status } =
        req.body;
      const code = String(req.body.code).trim().toUpperCase();

      if (!WAREHOUSE_TYPES.includes(type)) {
        return res.status(400).json({ success: false, message: typeInvalid });
      }
      if (!(await validManager(manager_id))) {
        return res.status(400).json({ success: false, message: managerInvalid });
      }

      // ✅ Check duplicate code
      if (await codeExists(WarehouseModel, code)) {
        return res.status(409).json({ success: false, message: existsText });
      }

      // ✅ Create (shop allows negative stock by default, central does not)
      const saveData = await WarehouseModel.create({
        code,
        name_kh,
        name_en,
        type,
        address,
        phone,
        manager_id: manager_id || null,
        allow_negative_stock: allow_negative_stock !== undefined ? !!allow_negative_stock : type === "shop",
        sort_order: Number(sort_order) || 0,
        note,
        status,
        deleted: false,
        created_by: userId,
        updated_by: userId,
      });

      // ✅ Log activity
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

  // ===================================== GET LIST (with filter + pagination) ================================================
  // Extra filter: ?type=central|shop   · shop roles only see their own warehouses
  prop.app.get(`${urlAPI}`, ...viewGuard, async (req, res) => {
    try {
      const extra = [];
      const scope = scopeFilter(req, "_id");
      if (Object.keys(scope).length) extra.push(scope);
      if (WAREHOUSE_TYPES.includes(req.query.type)) extra.push({ type: req.query.type });

      const result = await getFilteredMongoDB(req.query, WarehouseModel, populate, extra);
      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===================================== GET ALL (dropdown) ================================================
  // ?type=central|shop
  prop.app.get(`${urlAPI}-all`, ...viewGuard, async (req, res) => {
    try {
      const filter = { deleted: false, status: true, ...scopeFilter(req, "_id") };
      if (WAREHOUSE_TYPES.includes(req.query.type)) filter.type = req.query.type;

      const data = await WarehouseModel.find(filter).sort({ type: 1, sort_order: 1, code: 1 });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SORT (drag & drop) ================================================
  // body: { items: [{ _id, sort_order }] }
  prop.app.put(`${urlAPI}-sort`, ...editGuard, async (req, res) => {
    try {
      const result = await saveSortOrder(WarehouseModel, req.body.items, req.session.user_id);
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
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }
      // outside this user's scope → same answer as "not found"
      if (!canAccessWarehouse(req, id)) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

      const data = await WarehouseModel.findOne({ _id: id, deleted: false }).populate(populate);
      if (!data) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

      return res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== UPDATE ================================================
  prop.app.put(`${urlAPI}/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      // ✅ Build update fields (manager_id may be cleared with null → keep it before removeEmpty)
      const body = sanitizeUpdate(req.body, ["sort_order"]);
      const clearManager = body.manager_id === null || body.manager_id === "";
      const updateFields = removeEmpty({ ...body, updated_by: userId });
      if (clearManager) updateFields.manager_id = null;

      if (Object.keys(updateFields).length === 1) {
        return res.status(400).json({ success: false, message: noDataUpdate });
      }

      if (updateFields.code !== undefined) {
        updateFields.code = String(updateFields.code).trim().toUpperCase();
        if (await codeExists(WarehouseModel, updateFields.code, id)) {
          return res.status(409).json({ success: false, message: existsText });
        }
      }

      if (updateFields.type !== undefined && !WAREHOUSE_TYPES.includes(updateFields.type)) {
        return res.status(400).json({ success: false, message: typeInvalid });
      }
      // type is locked once the warehouse has stock history (TODO Phase 3: or a POS device)
      if (updateFields.type !== undefined) {
        const cur = await WarehouseModel.findOne({ _id: id, deleted: false }).select("type").lean();
        const StockMovementModel = require("../../stock/movement.model");
        if (cur && cur.type !== updateFields.type && (await StockMovementModel.exists({ warehouse_id: id }))) {
          return res.status(400).json({ success: false, message: `មិនអាចប្តូរប្រភេទ${document}បានទេ ព្រោះមានប្រវត្តិស្តុករួចហើយ!` });
        }
      }

      if (!clearManager && !(await validManager(updateFields.manager_id))) {
        return res.status(400).json({ success: false, message: managerInvalid });
      }

      const updatedData = await WarehouseModel.findOneAndUpdate({ _id: id, deleted: false }, updateFields, {
        returnDocument: "after",
        runValidators: true,
      }).populate(populate);

      if (!updatedData) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

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
        message: updatedText(nameOf(updatedData)),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SOFT DELETE ================================================
  prop.app.delete(`${urlAPI}/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      // ✅ Blocked while users are linked or it has stock history (TODO Phase 3: POS device)
      const hasUsers = await UserModel.exists({ warehouse_ids: id, deleted: false });
      if (hasUsers) {
        return res.status(400).json({ success: false, message: usedByUsers });
      }
      const StockMovementModel = require("../../stock/movement.model");
      if (await StockMovementModel.exists({ warehouse_id: id })) {
        return res.status(400).json({ success: false, message: `មិនអាចលុប${document}បានទេ ព្រោះមានប្រវត្តិស្តុក!` });
      }

      const updatedData = await WarehouseModel.findOneAndUpdate(
        { _id: id, deleted: false },
        { deleted: true, updated_by: userId },
        { returnDocument: "after" },
      );

      if (!updatedData) {
        return res.status(404).json({ success: false, message: noDataFound });
      }

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
        message: deletedText(nameOf(updatedData)),
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

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const current = await WarehouseModel.findOne({ _id: id, deleted: true });
      if (!current) {
        return res.status(404).json({ success: false, message: noDataFound });
      }
      if (await codeExists(WarehouseModel, current.code)) {
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

      res.status(200).json({
        success: true,
        data: current,
        message: `${document} ${nameOf(current)} បានស្តារឡើងវិញ!`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
