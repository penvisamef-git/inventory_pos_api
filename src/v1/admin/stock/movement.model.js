const mongoose = require("mongoose");

const MOVE_TYPES = ["opening", "purchase_in", "transfer_out", "transfer_in", "sale_out", "refund_in", "adjust_in", "adjust_out"];
const REF_TYPES = ["opening", "goods_receive", "transfer", "stock_adjustment", "invoice"];

// The stock ledger — APPEND-ONLY. Never edited or deleted; a mistake is fixed by a new document.
// qty is signed and always in the product's base unit (+ in, − out).
const movementSchema = new mongoose.Schema(
  {
    movement_date: { type: Date, required: true },
    warehouse_id: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variant_id: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    batch_id: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    type: { type: String, enum: MOVE_TYPES, required: true },
    qty: { type: Number, required: true },
    unit_cost: { type: Number, default: 0 }, // per base unit
    total_cost: { type: Number, default: 0 }, // signed (qty × unit_cost)
    balance_after: { type: Number, required: true }, // warehouse × variant after this row
    avg_cost_after: { type: Number, required: true },
    ref_type: { type: String, enum: REF_TYPES, required: true },
    ref_id: { type: mongoose.Schema.Types.ObjectId, required: true },
    ref_no: { type: String, default: null },
    note: { type: String, default: "" },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: "created_date", updatedAt: false } },
);

movementSchema.index({ warehouse_id: 1, variant_id: 1, movement_date: -1 });
movementSchema.index({ ref_type: 1, ref_id: 1 });
movementSchema.index({ product_id: 1 });
movementSchema.index({ batch_id: 1 });
movementSchema.index({ movement_date: -1 });

const StockMovementModel = mongoose.model("StockMovement", movementSchema);
StockMovementModel.MOVE_TYPES = MOVE_TYPES;
StockMovementModel.REF_TYPES = REF_TYPES;
module.exports = StockMovementModel;
