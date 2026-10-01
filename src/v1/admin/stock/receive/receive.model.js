const mongoose = require("mongoose");
const { docSchema } = require("../stock.doc");

// Goods receive from a supplier into the central warehouse (GR-2610-0001)
module.exports = mongoose.model(
  "GoodsReceive",
  docSchema({
    supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    supplier_invoice_no: { type: String, default: "" },
    purchase_order_id: { type: mongoose.Schema.Types.ObjectId, default: null }, // Phase 5
  }),
);
