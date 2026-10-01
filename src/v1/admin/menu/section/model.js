const mongoose = require("mongoose");

// A header inside a category, e.g. Coffee → "HOT COFFEE", "ICED COFFEE"
const SECTION_STYLES = ["normal", "signature"];

const sectionSchema = new mongoose.Schema(
  {
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Menu_Category",
      required: true,
    },
    name_en: { type: String, required: true, trim: true },
    name_kh: { type: String, required: false, trim: true },
    name_cn: { type: String, required: false, trim: true },
    subtitle: { type: String, required: false }, // "CRAFTED WITH PASSION, INSPIRED BY CAMBODIA"
    style: { type: String, enum: SECTION_STYLES, default: "normal" },
    sort_order: { type: Number, default: 0 },

    // >>>>>> Default <<<<< //
    note: String,
    status: {
      type: Boolean,
      default: true,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

sectionSchema.index({ category_id: 1, deleted: 1, sort_order: 1 });

module.exports = mongoose.model("Menu_Section", sectionSchema);
module.exports.SECTION_STYLES = SECTION_STYLES;
