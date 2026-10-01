const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");
const { defaultFields, schemaOptions } = require("../../../../util/default_fields");

// Product category tree (parent_id = null → top level)
const categorySchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true }, // clothing, clothing_tops
    name_kh: { type: String, required: true, trim: true },
    name_en: { type: String, trim: true },
    parent_id: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },
    image: { type: imageSchema, default: null },
    sort_order: { type: Number, default: 0 },
    ...defaultFields,
  },
  schemaOptions,
);

categorySchema.index({ code: 1 });
categorySchema.index({ parent_id: 1, sort_order: 1 });

module.exports = mongoose.model("Category", categorySchema);
