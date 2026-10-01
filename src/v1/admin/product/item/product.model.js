const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");
const { defaultFields, schemaOptions } = require("../../../../util/default_fields");

// Other units of a product: 1 pack = 12 pcs (factor = qty of the base unit)
// Barcodes are per variant (ProductVariant.unit_barcodes) because each size / color has its own.
const productUnitSchema = new mongoose.Schema(
  {
    unit_id: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true },
    factor: { type: Number, required: true, min: 0.0001 },
    is_sale_unit: { type: Boolean, default: true },
    is_purchase_unit: { type: Boolean, default: true },
  },
  { _id: false },
);

// Product = the "style" (Baby romper, Diaper pants, Baby shampoo 200ml).
// What is sold / stocked / priced is a ProductVariant (size × color …).
// Simple products get one default variant (is_default = true, no options).
const productSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true }, // ROMPER01
    name_kh: { type: String, required: true, trim: true },
    name_en: { type: String, trim: true },
    category_id: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    brand_id: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", default: null },
    base_unit_id: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true }, // stock is kept in this unit
    units: { type: [productUnitSchema], default: [] },
    attribute_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "Attribute" }], // variant axes, [] = simple product
    image: { type: imageSchema, default: null },
    description: { type: String, default: "" },
    track_stock: { type: Boolean, default: true }, // false = service / gift wrap
    track_batch: { type: Boolean, default: false }, // batch no + expiry on receive (formula, shampoo …)
    min_stock: { type: Number, default: 0 }, // low-stock alert, base unit, per variant
    allow_discount: { type: Boolean, default: true },
    is_taxable: { type: Boolean, default: true },
    variant_count: { type: Number, default: 0 }, // kept by the route
    sort_order: { type: Number, default: 0 },
    ...defaultFields,
  },
  schemaOptions,
);

productSchema.index({ code: 1 });
productSchema.index({ category_id: 1, deleted: 1 });
productSchema.index({ brand_id: 1 });
productSchema.index({ "units.unit_id": 1 });
productSchema.index({ base_unit_id: 1 });
productSchema.index({ attribute_ids: 1 });

module.exports = mongoose.model("Product", productSchema);
