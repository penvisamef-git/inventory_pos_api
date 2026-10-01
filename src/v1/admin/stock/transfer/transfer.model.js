const mongoose = require("mongoose");
const { docSchema } = require("../stock.doc");

// Transfer between warehouses (TR-2610-0001). warehouse_id = FROM, to_warehouse_id = TO.
//   requested  → shop manager asked central for stock (central edits qty, then dispatches)
//   draft      → created by central
//   dispatched → stock left FROM (transfer_out) — in transit
//   received   → TO confirmed (transfer_in); shortage → posted adjustment "transfer_shortage" (loss)
const STATES = ["requested", "draft", "dispatched", "received", "cancelled"];

const TransferModel = mongoose.model(
  "Transfer",
  docSchema(
    {
      to_warehouse_id: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
      requested_items: { type: Array, default: [] }, // what the shop asked for: [{ variant_id, sku, unit_code, qty }]
      dispatched_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      dispatched_at: { type: Date, default: null },
      received_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      received_at: { type: Date, default: null },
      receive_note: { type: String, default: "" },
      shortage_qty: { type: Number, default: 0 }, // base units
      shortage_cost: { type: Number, default: 0 },
      shortage_adjustment_id: { type: mongoose.Schema.Types.ObjectId, ref: "StockAdjustment", default: null },
    },
    {
      received_qty: { type: Number, default: null }, // in the line unit
      received_base_qty: { type: Number, default: null },
    },
    STATES,
  ),
);
TransferModel.STATES = STATES;
module.exports = TransferModel;
