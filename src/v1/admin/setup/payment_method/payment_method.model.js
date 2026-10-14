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
    online_mode: { type: Boolean, default: false }, // dynamic Bakong KHQR with the amount (paid → the POS finishes by itself)
    bakong_account_id: { type: String, trim: true, default: "" }, // shop@aclb — the Bakong account that receives the money
    merchant_name: { type: String, trim: true, default: "" }, // name shown in the customer's bank app
    merchant_city: { type: String, trim: true, default: "Phnom Penh" },
    icon: { type: imageSchema, default: null },
    qr_enabled: { type: Boolean, default: false }, // show a fixed QR (shop's KHQR / ABA) on the customer display
    qr_image: { type: imageSchema, default: null }, // the uploaded QR picture
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
