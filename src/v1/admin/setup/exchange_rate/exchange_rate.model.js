const mongoose = require("mongoose");

// USD → KHR rate with history. Active rate = newest effective_from ≤ now.
// Past rates are never changed (invoices keep the rate they used).
const exchangeRateSchema = new mongoose.Schema(
  {
    rate: { type: Number, required: true, min: 1 }, // 1 USD = rate KHR
    effective_from: { type: Date, required: true },

    // >>>>>> Default <<<<< //
    note: String,
    status: {
      type: Boolean,
      default: true,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

exchangeRateSchema.index({ deleted: 1, effective_from: -1 });

const ExchangeRateModel = mongoose.model("ExchangeRate", exchangeRateSchema);

// Rate in force at a moment (default: now) → document or null
ExchangeRateModel.currentAt = function (date = new Date()) {
  return this.findOne({ deleted: false, status: true, effective_from: { $lte: date } }).sort({ effective_from: -1 });
};

module.exports = ExchangeRateModel;
