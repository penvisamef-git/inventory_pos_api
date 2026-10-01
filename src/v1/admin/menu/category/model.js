const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");

const CATEGORY_TYPES = ["food", "drink"];

const categorySchema = new mongoose.Schema(
  {
    // Short key used by the website, e.g. "breakfast", "coffee"
    code: { type: String, required: true, trim: true, lowercase: true },
    name_en: { type: String, required: true, trim: true },
    name_kh: { type: String, required: false, trim: true },
    name_cn: { type: String, required: false, trim: true },
    type: { type: String, enum: CATEGORY_TYPES, default: "food" },
    icon: { type: imageSchema, required: false },

    // Optional serving time, e.g. Breakfast 06:00 – 10:00
    serve_from: { type: String, required: false }, // "06:00"
    serve_to: { type: String, required: false }, // "10:00"
    intro_en: { type: String, required: false }, // "Begin your morning with ..."
    intro_kh: { type: String, required: false },
    intro_cn: { type: String, required: false },

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

categorySchema.index({ deleted: 1, sort_order: 1 });

module.exports = mongoose.model("Menu_Category", categorySchema);
module.exports.CATEGORY_TYPES = CATEGORY_TYPES;
