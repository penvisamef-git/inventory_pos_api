const mongoose = require("mongoose");

// On-hand per warehouse × variant (cache of the ledger). qty can be negative in shops (POS sales only).
const balanceSchema = new mongoose.Schema(
  {
    warehouse_id: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variant_id: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    qty: { type: Number, default: 0 },
    avg_cost: { type: Number, default: 0 }, // moving average per base unit
    total_value: { type: Number, default: 0 },
    last_movement_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
balanceSchema.index({ warehouse_id: 1, variant_id: 1 }, { unique: true });
balanceSchema.index({ variant_id: 1 });
balanceSchema.index({ product_id: 1 });

// On-hand per warehouse × variant × batch (FEFO = first expiry, first out)
const batchBalanceSchema = new mongoose.Schema(
  {
    warehouse_id: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variant_id: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    batch_id: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
    qty: { type: Number, default: 0 },
    expiry_date: { type: Date, default: null }, // copied from Batch for FEFO sort
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
batchBalanceSchema.index({ warehouse_id: 1, variant_id: 1, batch_id: 1 }, { unique: true });
batchBalanceSchema.index({ warehouse_id: 1, variant_id: 1, expiry_date: 1 });
batchBalanceSchema.index({ expiry_date: 1, qty: 1 });

module.exports = {
  StockBalanceModel: mongoose.model("StockBalance", balanceSchema),
  StockBatchBalanceModel: mongoose.model("StockBatchBalance", batchBalanceSchema),
};
