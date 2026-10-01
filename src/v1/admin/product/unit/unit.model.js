const mongoose = require("mongoose");
const { defaultFields, schemaOptions } = require("../../../../util/default_fields");

// pcs, pack, box, set, bottle … (product base unit + other units)
const unitSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true }, // pcs
    name_kh: { type: String, required: true, trim: true }, // គ្រាប់
    name_en: { type: String, trim: true }, // Piece
    sort_order: { type: Number, default: 0 },
    ...defaultFields,
  },
  schemaOptions,
);

unitSchema.index({ code: 1 });

module.exports = mongoose.model("Unit", unitSchema);
