const mongoose = require("mongoose");

const oid = (ref) => ({ type: mongoose.Schema.Types.ObjectId, ref, default: null });

// One line = one SKU (or one batch of a batch-tracked SKU), always in the base unit
const lineSchema = new mongoose.Schema({
  product_id: { ...oid("Product"), required: true },
  variant_id: { ...oid("ProductVariant"), required: true },
  sku: String,
  name_kh: String,
  name_en: String,
  barcode: String,
  unit_id: oid("Unit"), // base unit
  unit_code: String,
  unit_name_kh: String,
  unit_name_en: String,
  track_batch: { type: Boolean, default: false },
  batch_id: oid("Batch"),
  batch_no: { type: String, default: null },
  expiry_date: { type: Date, default: null },
  expected_qty: { type: Number, default: null }, // system qty, taken when counting is submitted (hidden while counting)
  counted_qty: { type: Number, default: null }, // null = not counted
  diff_qty: { type: Number, default: null },
  unit_cost: { type: Number, default: null }, // average cost at post
  diff_cost: { type: Number, default: null },
  added: { type: Boolean, default: false }, // added while counting (not in the starting list)
  counted_at: { type: Date, default: null },
  note: { type: String, default: "" },
});

// Stock count (blind): counting → submitted → posted (→ one stock adjustment) | cancelled
const STATES = ["counting", "submitted", "posted", "cancelled"];
const countSchema = new mongoose.Schema(
  {
    doc_no: { type: String, required: true }, // SC-2610-0001
    doc_date: { type: Date, required: true },
    warehouse_id: { ...oid("Warehouse"), required: true },
    category_id: oid("Category"), // null = every product
    state: { type: String, enum: STATES, default: "counting" },
    uncounted: { type: String, enum: ["skip", "zero"], default: "skip" }, // set at submit
    lines: { type: [lineSchema], default: [] },
    total_lines: { type: Number, default: 0 },
    counted_lines: { type: Number, default: 0 },
    diff_lines: { type: Number, default: 0 },
    diff_in_qty: { type: Number, default: 0 },
    diff_out_qty: { type: Number, default: 0 },
    diff_cost: { type: Number, default: null }, // value of the differences (+ found / − missing), at post
    adjustment_id: oid("StockAdjustment"),
    note: { type: String, default: "" },
    submitted_by: oid("User"),
    submitted_at: { type: Date, default: null },
    posted_by: oid("User"),
    posted_at: { type: Date, default: null },
    cancelled_by: oid("User"),
    cancelled_at: { type: Date, default: null },
    created_by: { ...oid("User"), required: true },
    updated_by: { ...oid("User"), required: true },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
countSchema.index({ doc_no: 1 }, { unique: true });
countSchema.index({ warehouse_id: 1, state: 1, doc_date: -1 });

const StockCountModel = mongoose.model("StockCount", countSchema);
StockCountModel.STATES = STATES;
module.exports = StockCountModel;
