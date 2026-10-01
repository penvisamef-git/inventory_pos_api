const mongoose = require("mongoose");
const { defaultFields, schemaOptions } = require("../../../../util/default_fields");

const ATTRIBUTE_TYPES = ["size", "color", "other"];

// One value of an attribute, e.g. Size → "6-12M", Color → "Pink"
// Variants (Phase 1 product) store attribute_id + value _id.
const valueSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, lowercase: true }, // 6_12m, pink
  name_kh: { type: String, required: true, trim: true },
  name_en: { type: String, trim: true },
  color_hex: { type: String, trim: true, default: null }, // #F9A8D4 (color type only)
  sort_order: { type: Number, default: 0 },
  status: { type: Boolean, default: true },
});

// Variant attribute: Size, Color …
const attributeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true }, // size, color
    name_kh: { type: String, required: true, trim: true },
    name_en: { type: String, trim: true },
    type: { type: String, enum: ATTRIBUTE_TYPES, default: "other" },
    values: { type: [valueSchema], default: [] },
    sort_order: { type: Number, default: 0 },
    ...defaultFields,
  },
  schemaOptions,
);

attributeSchema.index({ code: 1 });

const AttributeModel = mongoose.model("Attribute", attributeSchema);
AttributeModel.ATTRIBUTE_TYPES = ATTRIBUTE_TYPES;

module.exports = AttributeModel;
