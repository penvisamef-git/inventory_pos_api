const mongoose = require("mongoose");
const { defaultFields, schemaOptions } = require("../../../../util/default_fields");

// Sale price (USD) of one variant in one unit, with history.
//   warehouse_id = null → default price for every shop
//   warehouse_id = shop → override for that shop (price = null → "back to default" from that date)
// Rows of one chain (variant + unit + warehouse) never overlap: effective_from ≤ t < effective_to (null = open).
// A change is always a new row; only rows that have not started yet can be deleted.
const priceSchema = new mongoose.Schema(
  {
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variant_id: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    unit_id: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true },
    warehouse_id: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    price: { type: Number, default: null, min: 0 }, // null only for a shop override = use default
    effective_from: { type: Date, required: true },
    effective_to: { type: Date, default: null },
    ...defaultFields,
  },
  schemaOptions,
);

priceSchema.index({ variant_id: 1, unit_id: 1, warehouse_id: 1, effective_from: -1 });
priceSchema.index({ product_id: 1, deleted: 1 });
priceSchema.index({ warehouse_id: 1, effective_from: -1 });

module.exports = mongoose.model("Price", priceSchema);
