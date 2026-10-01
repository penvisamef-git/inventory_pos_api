const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");
const { defaultFields, schemaOptions } = require("../../../../util/default_fields");

// One option of a variant: Size = 0-3M. Names are a snapshot (refreshed when the product is saved).
const optionSchema = new mongoose.Schema(
  {
    attribute_id: { type: mongoose.Schema.Types.ObjectId, ref: "Attribute", required: true },
    value_id: { type: mongoose.Schema.Types.ObjectId, required: true }, // Attribute.values._id
    attribute_code: String,
    value_code: String,
    name_kh: String,
    name_en: String,
    color_hex: { type: String, default: null },
  },
  { _id: false },
);

// Barcode of a bigger unit of this variant (pack of 30 Size M)
const unitBarcodeSchema = new mongoose.Schema(
  {
    unit_id: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true },
    barcode: { type: String, required: true, trim: true },
  },
  { _id: false },
);

// Sellable item (SKU). Stock, price, batch and invoice lines point to a variant.
const variantSchema = new mongoose.Schema(
  {
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    code: { type: String, required: true, trim: true, uppercase: true }, // SKU: ROMPER01-0-3M-PINK
    name_kh: { type: String, required: true, trim: true }, // product name + options
    name_en: { type: String, trim: true },
    options: { type: [optionSchema], default: [] },
    option_key: { type: String, default: "" }, // sorted value ids, unique per product
    is_default: { type: Boolean, default: false }, // the only variant of a simple product
    barcode: { type: String, trim: true, default: null }, // base unit barcode
    unit_barcodes: { type: [unitBarcodeSchema], default: [] },
    image: { type: imageSchema, default: null },
    min_stock: { type: Number, default: null }, // null = use product.min_stock
    sort_order: { type: Number, default: 0 },
    deleted_with_product: { type: Boolean, default: false }, // restored together with the product
    ...defaultFields,
  },
  schemaOptions,
);

variantSchema.index({ product_id: 1, deleted: 1, sort_order: 1 });
variantSchema.index({ code: 1 });
variantSchema.index({ barcode: 1 });
variantSchema.index({ "unit_barcodes.barcode": 1 });
variantSchema.index({ "options.value_id": 1 });

module.exports = mongoose.model("ProductVariant", variantSchema);
