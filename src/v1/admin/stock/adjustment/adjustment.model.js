const mongoose = require("mongoose");
const { docSchema } = require("../stock.doc");

// in = found · out = damaged, expired, lost · other = either (signed qty) · transfer_shortage / stock_count = system only
const REASONS = ["damaged", "expired", "lost", "found", "other", "transfer_shortage", "stock_count"];

const StockAdjustmentModel = mongoose.model(
  "StockAdjustment",
  docSchema({
    reason: { type: String, enum: REASONS, required: true },
    transfer_id: { type: mongoose.Schema.Types.ObjectId, ref: "Transfer", default: null },
    count_id: { type: mongoose.Schema.Types.ObjectId, ref: "StockCount", default: null },
  }),
);
StockAdjustmentModel.REASONS = REASONS;
module.exports = StockAdjustmentModel;
