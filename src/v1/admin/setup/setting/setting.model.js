const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");

const TAX_MODES = ["none", "inclusive", "exclusive"];
// Look of the admin web + shop portal for everyone (light / dark stays each user's choice)
const UI_THEMES = [
  "forest", "ocean", "candy", "navy",
  // themes made from seeds (inventory_pos_admin/src/page/theme/themeSeeds.js)
  "emerald", "lagoon", "olive", "jungle", "sky", "arctic", "indigo", "midnight", "royal", "lavender", "grape", "bubblegum", "rose", "wine", "coral", "cherry", "sunset", "honey", "mocha", "charcoal",
];

// POS receipt styles (inventory_pos_admin/src/page/cloudpos/receiptTemplates.js · local_pos/src/receiptTemplates.js)
const RECEIPT_TEMPLATES = [
  "classic", "typewriter", "minimal", "modern", "bold", "elegant",
  "compact", "table", "large", "retro", "boxed", "numbered",
  "barcode", "banner_table", "boutique", "playful", "mono_lite", "double_line",
  "express", "executive", "clean_grid", "big_total", "dotted_box", "premium",
];

// One document only (key: "main") — company, receipt, tax and stock alert settings
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "main", unique: true },

    // ---- Company ----
    company_name_kh: { type: String, trim: true, default: "" },
    company_name_en: { type: String, trim: true, default: "" },
    logo: { type: imageSchema, default: null },
    address: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    vat_no: { type: String, trim: true, default: "" },

    // ---- Money ----
    base_currency: { type: String, default: "USD" },
    khr_rounding: { type: Number, default: 100 }, // cash KHR is rounded to this (100៛)

    // ---- Tax (VAT) — invoices keep a snapshot, so a change only affects new invoices ----
    tax_mode: { type: String, enum: TAX_MODES, default: "none" },
    tax_rate: { type: Number, default: 0, min: 0, max: 100 },
    tax_name: { type: String, trim: true, default: "VAT" },

    // ---- Receipt ----
    receipt_header: { type: String, default: "" },
    receipt_footer: { type: String, default: "សូមអរគុណ!" },
    receipt_template: { type: String, enum: RECEIPT_TEMPLATES, default: "classic" }, // POS receipt style (24)

    // ---- Loyalty (customers earn points on the POS, spend them as a payment) ----
    loyalty_enabled: { type: Boolean, default: true },
    points_per_usd: { type: Number, default: 1, min: 0 }, // $1 paid = 1 point (whole points, rounded down)
    point_value_usd: { type: Number, default: 0.01, min: 0 }, // 1 point = $0.01 → 100 points = $1
    min_redeem_points: { type: Number, default: 100, min: 0 }, // smallest number of points a customer can use
    birthday_notified_on: { type: String, default: "" }, // "YYYY-MM-DD" of the last Telegram birthday list

    // ---- Stock alerts ----
    low_stock_default: { type: Number, default: 5, min: 0 },
    expiry_alert_days: { type: Number, default: 30, min: 0 },

    // ---- Look (admin web + shop portal) ----
    ui_theme: { type: String, enum: UI_THEMES, default: "forest" },

    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

const SettingModel = mongoose.model("Setting", settingSchema);
SettingModel.TAX_MODES = TAX_MODES;

// Get the setting document (created with defaults the first time)
SettingModel.getMain = async function () {
  return this.findOneAndUpdate(
    { key: "main" },
    { $setOnInsert: { key: "main" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

SettingModel.UI_THEMES = UI_THEMES;
SettingModel.RECEIPT_TEMPLATES = RECEIPT_TEMPLATES;

module.exports = SettingModel;
