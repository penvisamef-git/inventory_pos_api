const crypto = require("crypto");
const SettingModel = require("./model");
const { logActivity } = require("../../../../util/log");
const { pick } = require("../../../../util/helper");
const { can_manage_users } = require("../../../../util/permission");
const baseRoute = "menu/setting";

const FIELDS = [
  "restaurant_name",
  "tagline",
  "logo",
  "address",
  "phone",
  "email",
  "website",
  "facebook",
  "telegram",
  "map_url",
  "currency",
  "currency_symbol",
  "exchange_rate_khr",
  "opening_hours",
  "copyright",
];

// random, URL-safe, hard to guess (16 chars)
function newPublicToken() {
  return crypto.randomBytes(12).toString("base64url");
}

const route = (prop) => {
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  const logTitle = "setting";
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";

  const guardRead = [prop.api_auth, prop.jwt_auth, prop.request_user];
  const guardWrite = [...guardRead, can_manage_users];

  // ===================================== GET ================================================
  prop.app.get(`${urlAPI}`, ...guardRead, async (req, res) => {
    try {
      let data = await SettingModel.findOne({ key: "main" });
      if (!data) data = await SettingModel.create({ key: "main" });
      // first time: give the public menu link a token
      if (!data.public_token) {
        data.public_token = newPublicToken();
        await data.save();
      }
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== PUBLIC LINK: REGENERATE TOKEN ================================================
  // Old links / printed QR codes stop working after this.
  prop.app.put(`${urlAPI}/public-token`, ...guardWrite, async (req, res) => {
    try {
      const data = await SettingModel.findOneAndUpdate(
        { key: "main" },
        { public_token: newPublicToken(), updated_by: req.session.user_id },
        { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
      );

      await logActivity({
        title: "តំណម៉ឺនុយសាធារណៈត្រូវបានបង្កើតថ្មី!",
        description: `គណនី: ${req.user.email} បានបង្កើតតំណម៉ឺនុយថ្មី (តំណចាស់លែងប្រើបាន)`,
        categoryTitle: logTitle,
        createdBy: req.session.user_id,
        req,
      });

      res.status(200).json({
        success: true,
        data,
        message: "តំណម៉ឺនុយថ្មីត្រូវបានបង្កើត! QR ចាស់លែងប្រើបានទៀតហើយ។",
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== UPDATE ================================================
  prop.app.put(`${urlAPI}`, ...guardWrite, async (req, res) => {
    try {
      const updateFields = pick(req.body, FIELDS);
      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({ success: false, message: "មិនមានទិន្នន័យដើម្បីកែប្រែ!" });
      }
      if (updateFields.logo !== undefined && updateFields.logo !== null && !updateFields.logo.url) {
        return res.status(400).json({ success: false, message: "សូមបញ្ចូលរូបភាព (logo.url)" });
      }
      if (
        updateFields.exchange_rate_khr !== undefined &&
        !(Number(updateFields.exchange_rate_khr) > 0)
      ) {
        return res.status(400).json({ success: false, message: "អត្រាប្តូរប្រាក់មិនត្រឹមត្រូវ!" });
      }

      const data = await SettingModel.findOneAndUpdate(
        { key: "main" },
        { ...updateFields, updated_by: req.session.user_id },
        { returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true },
      );

      await logActivity({
        title: "ការកំណត់ភោជនីយដ្ឋានត្រូវបានកែប្រែ!",
        description: `គណនី: ${req.user.email} បានកែប្រែព័ត៌មានដូចជា : ${JSON.stringify(updateFields)}`,
        categoryTitle: logTitle,
        createdBy: req.session.user_id,
        req,
      });

      res.status(200).json({ success: true, data, message: "ការកំណត់ត្រូវបានរក្សារទុក!" });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
