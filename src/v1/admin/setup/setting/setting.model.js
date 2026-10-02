const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");

const TAX_MODES = ["none", "inclusive", "exclusive"];
// Look of the admin web + shop portal for everyone (light / dark stays each user's choice)
const UI_THEMES = ["forest", "ocean", "candy", "navy"];

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

module.exports = SettingModel;
