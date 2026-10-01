const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");
const { defaultFields, schemaOptions } = require("../../../../util/default_fields");

// Product brand: Pampers, Huggies, Johnson's … (optional on a product)
const brandSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true }, // pampers
    name_kh: { type: String, required: true, trim: true },
    name_en: { type: String, trim: true },
    logo: { type: imageSchema, default: null },
    sort_order: { type: Number, default: 0 },
    ...defaultFields,
  },
  schemaOptions,
);

brandSchema.index({ code: 1 });

module.exports = mongoose.model("Brand", brandSchema);
