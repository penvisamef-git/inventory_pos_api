const SettingModel = require("./setting.model");
const { logActivity } = require("../../../../util/log");
const { pick } = require("../../../../util/helper");
const { can_manage_setup, can_view_master } = require("../../../../util/permission");
const baseRoute = "setup/setting";

const { TAX_MODES } = SettingModel;

// Fields the client may change
const EDITABLE = [
  "company_name_kh",
  "company_name_en",
  "logo",
  "address",
  "phone",
  "email",
  "vat_no",
  "khr_rounding",
  "tax_mode",
  "tax_rate",
  "tax_name",
  "receipt_header",
  "receipt_footer",
  "low_stock_default",
  "expiry_alert_days",
];
const NUMBERS = ["khr_rounding", "tax_rate", "low_stock_default", "expiry_alert_days"];

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  const logTitle = "setting";
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const noDataUpdate = "មិនមានទិន្នន័យដើម្បីកែប្រែ!";
  const saved = "ការកំណត់ត្រូវបានរក្សាទុក!";
  const taxModeInvalid = `របៀបពន្ធមិនត្រឹមត្រូវ! (${TAX_MODES.join(" | ")})`;
  const taxRateInvalid = "អត្រាពន្ធត្រូវនៅចន្លោះ 0 ដល់ 100!";
  const numberInvalid = "តម្លៃលេខមិនត្រឹមត្រូវ (ត្រូវតែ ≥ 0)!";

  const viewGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_view_master];
  const editGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_setup];

  // ===================================== GET ================================================
  prop.app.get(`${urlAPI}`, ...viewGuard, async (req, res) => {
    try {
      const data = await SettingModel.getMain();
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== UPDATE ================================================
  prop.app.put(`${urlAPI}`, ...editGuard, async (req, res) => {
    try {
      const { user_id: userId } = req.session;
      const updateFields = pick(req.body, EDITABLE);

      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({ success: false, message: noDataUpdate });
      }

      for (const key of NUMBERS) {
        if (updateFields[key] === undefined) continue;
        const n = Number(updateFields[key]);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ success: false, message: numberInvalid });
        }
        updateFields[key] = n;
      }
      if (updateFields.tax_mode !== undefined && !TAX_MODES.includes(updateFields.tax_mode)) {
        return res.status(400).json({ success: false, message: taxModeInvalid });
      }
      if (updateFields.tax_rate !== undefined && updateFields.tax_rate > 100) {
        return res.status(400).json({ success: false, message: taxRateInvalid });
      }

      await SettingModel.getMain();
      const before = await SettingModel.findOne({ key: "main" }).lean();
      const data = await SettingModel.findOneAndUpdate(
        { key: "main" },
        { ...updateFields, updated_by: userId },
        { returnDocument: "after", runValidators: true },
      );

      // log old → new for the fields that really changed
      const changes = Object.keys(updateFields)
        .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(data[k]))
        .map((k) => (k === "logo" ? "logo" : `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(data[k])}`));

      await logActivity({
        title: "ការកំណត់ប្រព័ន្ធត្រូវបានកែប្រែ!",
        description: `គណនី: ${req.user.email} បានកែប្រែ : ${changes.join(", ") || "-"}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data, message: saved });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
