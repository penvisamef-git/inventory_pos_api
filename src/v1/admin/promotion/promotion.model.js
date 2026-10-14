const mongoose = require("mongoose");
const oid = (ref) => ({ type: mongoose.Schema.Types.ObjectId, ref, default: null });

const PROMO_TYPES = ["percent", "amount_off", "buy_x_get_y", "bundle", "bill_percent", "bill_amount"];
const PROMO_SCOPES = ["all", "category", "brand", "product"];

// Promotions applied by the POS by itself (offline too) — engine: local_pos_api/src/promo.js (same file in the POS screens).
const promotionSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true }, // PR0001
    name_kh: { type: String, required: true, trim: true },
    name_en: { type: String, trim: true, default: "" },
    type: { type: String, enum: PROMO_TYPES, required: true },
    value: { type: Number, default: 0 }, // % (percent, bill_percent) or USD (amount_off per item, bill_amount)
    buy_qty: { type: Number, default: 2 }, // buy_x_get_y
    get_qty: { type: Number, default: 1 },
    get_percent: { type: Number, default: 100 }, // 100 = free, 50 = half price
    bundle_items: { type: [{ _id: false, product_id: oid("Product"), variant_id: oid("ProductVariant"), qty: { type: Number, default: 1 } }], default: [] },
    bundle_price: { type: Number, default: 0 },
    scope: { type: String, enum: PROMO_SCOPES, default: "all" },
    category_ids: [oid("Category")],
    brand_ids: [oid("Brand")],
    product_ids: [oid("Product")],
    min_qty: { type: Number, default: 0 }, // item promotions: at least this many items in scope
    min_amount: { type: Number, default: 0 }, // bill promotions: bill at least this much (USD)
    start_at: { type: Date, default: null },
    end_at: { type: Date, default: null },
    days: { type: [Number], default: [] }, // 0 = Sunday … empty = every day
    time_from: { type: String, default: "" }, // "HH:mm" happy hour (Cambodia time)
    time_to: { type: String, default: "" },
    warehouse_ids: [oid("Warehouse")], // empty = every shop
    member_only: { type: Boolean, default: false }, // only when a customer is on the sale
    priority: { type: Number, default: 0 },
    note: { type: String, default: "" },
    status: { type: Boolean, default: true },
    deleted: { type: Boolean, default: false },
    created_by: oid("User"),
    updated_by: oid("User"),
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
promotionSchema.index({ code: 1 }, { unique: true });
const PromotionModel = mongoose.model("Promotion", promotionSchema);
PromotionModel.PROMO_TYPES = PROMO_TYPES;
PromotionModel.PROMO_SCOPES = PROMO_SCOPES;
module.exports = PromotionModel;
