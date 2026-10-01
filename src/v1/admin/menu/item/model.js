const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");

// single → one price       e.g. 3.80
// size   → price per size  e.g. [{ label: "S", price: 8 }, { label: "M", price: 13.8 }]
const PRICE_TYPES = ["single", "size"];

const sizeSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const itemSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true }, // "001", "020B", "SET01"
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Menu_Category",
      required: true,
    },
    // Menu books this item is printed in (Breakfast, Lunch & Dinner, Drinks) — can be many
    book_ids: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Menu_Book",
      },
    ],
    section_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Menu_Section",
      required: false,
      default: null,
    },

    name_en: { type: String, required: false, trim: true },
    name_kh: { type: String, required: false, trim: true },
    name_cn: { type: String, required: false, trim: true }, // Chinese
    desc_en: { type: String, required: false },
    desc_kh: { type: String, required: false },
    desc_cn: { type: String, required: false },
    image: { type: imageSchema, required: false },

    price_type: { type: String, enum: PRICE_TYPES, default: "single" },
    price: { type: Number, min: 0, default: null },
    sizes: { type: [sizeSchema], default: [] },

    is_featured: { type: Boolean, default: false }, // signature card
    is_available: { type: Boolean, default: true }, // false = sold out today
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

itemSchema.index({ category_id: 1, deleted: 1, sort_order: 1 });
itemSchema.index({ code: 1, deleted: 1 });
itemSchema.index({ book_ids: 1, deleted: 1 });

module.exports = mongoose.model("Menu_Item", itemSchema);
module.exports.PRICE_TYPES = PRICE_TYPES;
