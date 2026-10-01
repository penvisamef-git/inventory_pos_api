const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");

const PAYMENT_TYPES = ["cash", "qr", "card", "bank"];
const PAYMENT_CURRENCIES = ["USD", "KHR", "any"];

// Payment methods shown on the POS (cash USD, cash KHR, KHQR, ABA ...)
const paymentMethodSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true }, // cash_usd, khqr ...
    name_kh: { type: String, required: true, trim: true },
    name_en: { type: String, trim: true },
    type: { type: String, enum: PAYMENT_TYPES, required: true },
    currency: { type: String, enum: PAYMENT_CURRENCIES, default: "any" },
    requires_reference: { type: Boolean, default: false }, // cashier must type a reference no. (offline QR)
    online_mode: { type: Boolean, default: false }, // dynamic QR with amount when the POS is online
    icon: { type: imageSchema, default: null },
    sort_order: { type: Number, default: 0 },

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

paymentMethodSchema.index({ code: 1 });

const PaymentMethodModel = mongoose.model("PaymentMethod", paymentMethodSchema);
PaymentMethodModel.PAYMENT_TYPES = PAYMENT_TYPES;
PaymentMethodModel.PAYMENT_CURRENCIES = PAYMENT_CURRENCIES;

module.exports = PaymentMethodModel;
