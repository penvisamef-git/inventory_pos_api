const mongoose = require("mongoose");

// Money paid to a supplier (SP-2610-0001). What we owe = posted goods receives − these payments.
const supplierPaymentSchema = new mongoose.Schema(
  {
    doc_no: { type: String, required: true },
    supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    amount: { type: Number, required: true }, // USD
    paid_at: { type: Date, required: true },
    method: { type: String, enum: ["cash", "bank", "cheque", "other"], default: "bank" },
    reference: { type: String, default: "" }, // bank ref / cheque no.
    note: { type: String, default: "" },
    voided: { type: Boolean, default: false },
    void_reason: { type: String, default: "" },
    voided_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    voided_at: { type: Date, default: null },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
supplierPaymentSchema.index({ doc_no: 1 }, { unique: true });
supplierPaymentSchema.index({ supplier_id: 1, voided: 1, paid_at: 1 });

module.exports = mongoose.model("SupplierPayment", supplierPaymentSchema);
