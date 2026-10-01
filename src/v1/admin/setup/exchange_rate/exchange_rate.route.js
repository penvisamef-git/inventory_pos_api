const mongoose = require("mongoose");
const ExchangeRateModel = require("./exchange_rate.model");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { checkValidtion } = require("../../../../util/helper");
const { can_manage_setup, can_view_master } = require("../../../../util/permission");
const baseRoute = "setup/exchange-rate";

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  const logTitle = "exchange_rate";
  const document = "អត្រាប្តូរប្រាក់";

  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const noDataFound = `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!`;
  const noCurrent = `មិនទាន់មាន${document}ដែលកំពុងប្រើ!`;
  const newSave = `${document}ថ្មីត្រូវបានរក្សារទុក!`;
  const noIDFound = "មិនមាន ID ត្រឹមត្រូវ!";
  const rateInvalid = "អត្រាត្រូវតែជាលេខធំជាង 0!";
  const dateInvalid = "កាលបរិច្ឆេទចាប់ផ្តើមមិនត្រឹមត្រូវ!";
  const sameDate = `មាន${document}ចាប់ផ្តើមនៅពេលនេះរួចហើយ!`;
  const lockedPast = `${document}ដែលបានចាប់ផ្តើមប្រើរួច មិនអាចកែប្រែ ឬលុបបានទេ (សូមបង្កើតអត្រាថ្មី)!`;

  const text = (r) => `1 USD = ${Number(r.rate).toLocaleString("en-US")} ៛`;
  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master];
  const editGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_setup];

  // rate > 0 and a valid date (returns { rate, date } or { error })
  function readBody(body, partial = false) {
    const out = {};
    if (!partial || body.rate !== undefined) {
      const rate = Number(body.rate);
      if (!Number.isFinite(rate) || rate <= 0) return { error: rateInvalid };
      out.rate = rate;
    }
    if (!partial || body.effective_from !== undefined) {
      const date = new Date(body.effective_from);
      if (Number.isNaN(date.getTime())) return { error: dateInvalid };
      out.effective_from = date;
    }
    return out;
  }

  // ===================================== CREATE ================================================
  // body: { rate: 4100, effective_from: "2026-10-02T00:00:00+07:00", note }  (past date = starts now)
  prop.app.post(`${urlAPI}`, ...editGuard, async (req, res) => {
    try {
      const requiredFields = [
        { key: "rate", label: "អត្រា (៛ ក្នុង 1 USD)" },
        { key: "effective_from", label: "ចាប់ផ្តើមប្រើពី" },
      ];
      if (!checkValidtion(res, req, requiredFields)) return;

      const { user_id: userId } = req.session;
      const body = readBody(req.body);
      if (body.error) return res.status(400).json({ success: false, message: body.error });

      if (await ExchangeRateModel.exists({ deleted: false, effective_from: body.effective_from })) {
        return res.status(409).json({ success: false, message: sameDate });
      }

      const saveData = await ExchangeRateModel.create({
        ...body,
        note: req.body.note,
        status: true,
        deleted: false,
        created_by: userId,
        updated_by: userId,
      });

      await logActivity({
        title: `${document}ថ្មី ${text(saveData)} ត្រូវបានបង្កើត!`,
        description: `ចាប់ផ្តើមប្រើ: ${saveData.effective_from.toISOString()} · ដោយគណនី: ${req.user.email}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(201).json({ success: true, data: saveData, message: newSave });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== CURRENT ================================================
  // → the rate in force now (POS, price screens)
  prop.app.get(`${urlAPI}/current`, ...viewGuard, async (req, res) => {
    try {
      const data = await ExchangeRateModel.currentAt(new Date());
      if (!data) return res.status(404).json({ success: false, message: noCurrent });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET LIST (history) ================================================
  // Rows include state: "upcoming" | "current" | "past"
  prop.app.get(`${urlAPI}`, ...viewGuard, async (req, res) => {
    try {
      const query = { sort: "effective_from", order: "desc", ...req.query };
      const [result, current] = await Promise.all([
        getFilteredMongoDB(query, ExchangeRateModel, [{ path: "created_by", select: "firstname lastname email" }]),
        ExchangeRateModel.currentAt(new Date()),
      ]);
      const now = Date.now();
      const data = result.data.map((row) => {
        const r = row.toJSON();
        r.state =
          current && String(current._id) === String(row._id)
            ? "current"
            : new Date(row.effective_from).getTime() > now
              ? "upcoming"
              : "past";
        return r;
      });
      res.status(200).json({ success: true, data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET BY ID ================================================
  prop.app.get(`${urlAPI}/:id`, ...viewGuard, async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });
      const data = await ExchangeRateModel.findOne({ _id: id, deleted: false });
      if (!data) return res.status(404).json({ success: false, message: noDataFound });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== UPDATE (upcoming only) ================================================
  prop.app.put(`${urlAPI}/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });

      const current = await ExchangeRateModel.findOne({ _id: id, deleted: false });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });
      if (current.effective_from.getTime() <= Date.now()) {
        return res.status(400).json({ success: false, message: lockedPast });
      }

      const body = readBody(req.body, true);
      if (body.error) return res.status(400).json({ success: false, message: body.error });
      if (
        body.effective_from &&
        (await ExchangeRateModel.exists({ _id: { $ne: id }, deleted: false, effective_from: body.effective_from }))
      ) {
        return res.status(409).json({ success: false, message: sameDate });
      }

      Object.assign(current, body);
      if (req.body.note !== undefined) current.note = req.body.note;
      current.updated_by = userId;
      await current.save();

      await logActivity({
        title: `${document} ${text(current)} ត្រូវបានកែប្រែ!`,
        description: `ចាប់ផ្តើមប្រើ: ${current.effective_from.toISOString()} · ដោយគណនី: ${req.user.email}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: current, message: `${document}ត្រូវបានកែប្រែ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SOFT DELETE (upcoming only) ================================================
  prop.app.delete(`${urlAPI}/:id`, ...editGuard, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: noIDFound });

      const current = await ExchangeRateModel.findOne({ _id: id, deleted: false });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });
      if (current.effective_from.getTime() <= Date.now()) {
        return res.status(400).json({ success: false, message: lockedPast });
      }

      current.deleted = true;
      current.updated_by = userId;
      await current.save();

      await logActivity({
        title: `${document} ${text(current)} ត្រូវបានលុប!`,
        description: `គណនី: ${req.user.email} បានលុបអត្រាដែលមិនទាន់ចាប់ផ្តើមប្រើ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: `${text(current)} បានលុប`, message: `${document}ត្រូវបានលុប!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
