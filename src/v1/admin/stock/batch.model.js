const mongoose = require("mongoose");

// A lot of a batch-tracked variant (formula, shampoo …). Created when goods are received / opened.
// Same variant + batch_no = same batch (expiry must match).
const batchSchema = new mongoose.Schema(
  {
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variant_id: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    batch_no: { type: String, required: true, trim: true, uppercase: true },
    expiry_date: { type: Date, default: null },
    mfg_date: { type: Date, default: null },
    receive_cost: { type: Number, default: null }, // reference only (valuation uses average cost)
    source_type: { type: String, default: null }, // opening | goods_receive | adjustment
    source_id: { type: mongoose.Schema.Types.ObjectId, default: null },
    source_no: { type: String, default: null },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);

batchSchema.index({ variant_id: 1, batch_no: 1 }, { unique: true });
batchSchema.index({ expiry_date: 1 });

module.exports = mongoose.model("Batch", batchSchema);
