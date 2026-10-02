const mongoose = require("mongoose");
const { defaultFields, schemaOptions } = require("../../../util/default_fields");

// Public catalog link (QR code): anyone with the link sees the items of ONE warehouse / shop —
// name, picture, sale price and a stock STATUS (in stock / few left / out), never the real qty or cost.
// The token is random; turning `status` off or making a new token stops the old link at once.
const catalogLinkSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // "Toul Kork shop — Facebook page"
    warehouse_id: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
    category_id: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null }, // null = every product
    token: { type: String, required: true }, // in the URL: /c/<token>
    views: { type: Number, default: 0 },
    last_viewed_at: { type: Date, default: null },
    ...defaultFields,
  },
  schemaOptions,
);
catalogLinkSchema.index({ token: 1 }, { unique: true });
catalogLinkSchema.index({ warehouse_id: 1, deleted: 1 });

module.exports = mongoose.model("CatalogLink", catalogLinkSchema);
