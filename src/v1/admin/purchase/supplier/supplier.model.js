const mongoose = require("mongoose");
const { defaultFields, schemaOptions } = require("../../../../util/default_fields");

// Supplier / distributor (goods receive, later purchase orders)
const supplierSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    contact_name: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
    vat_no: { type: String, default: "" },
    payment_term_days: { type: Number, default: 0 },
    sort_order: { type: Number, default: 0 },
    ...defaultFields,
  },
  schemaOptions,
);
supplierSchema.index({ code: 1 });

module.exports = mongoose.model("Supplier", supplierSchema);
