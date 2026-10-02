const mongoose = require("mongoose");

const oid = (ref) => ({ type: mongoose.Schema.Types.ObjectId, ref, default: null });

// ---------------------------------------------------------------------------------------------
// POS device: one computer in a shop. Linked once with a pairing code made in the admin web;
// after pairing it calls the cloud with its own secret key (x-device-key: <id>.<secret>, only a hash is kept).
// ---------------------------------------------------------------------------------------------
const deviceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // "Counter 1"
    code: { type: String, required: true, trim: true, uppercase: true }, // PP01-P1 → invoice prefix
    warehouse_id: { ...oid("Warehouse"), required: true }, // a shop
    pair_code: { type: String, default: null }, // 6 digits while waiting to be paired
    pair_expires_at: { type: Date, default: null },
    key_hash: { type: String, default: null, select: false }, // sha256 of the secret
    key_hint: { type: String, default: null }, // last 4 characters, for the screen
    paired_at: { type: Date, default: null },
    last_seen_at: { type: Date, default: null },
    last_pull_at: { type: Date, default: null },
    last_push_at: { type: Date, default: null },
    offline_alerted_at: { type: Date, default: null }, // Telegram "POS not synced" sent (once per offline time)
    app_version: { type: String, default: "" },
    status: { type: Boolean, default: true }, // off = the POS can't sync until turned on again
    deleted: { type: Boolean, default: false },
    note: { type: String, default: "" },
    created_by: { ...oid("User"), required: true },
    updated_by: { ...oid("User"), required: true },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
deviceSchema.index({ code: 1 }, { unique: true });
deviceSchema.index({ pair_code: 1 });
const PosDeviceModel = mongoose.model("PosDevice", deviceSchema);

// ---------------------------------------------------------------------------------------------
// Sale (invoice) as received from a POS. The POS makes the invoice offline; the cloud keeps a copy,
// takes the stock out of the shop (sale_out, negative allowed) and records the cost at that moment.
// `uuid` (made by the POS) makes a push safe to repeat.
// ---------------------------------------------------------------------------------------------
const lineSchema = new mongoose.Schema(
  {
    product_id: { ...oid("Product"), required: true },
    variant_id: { ...oid("ProductVariant"), required: true },
    sku: String,
    name_kh: String,
    name_en: String,
    unit_id: oid("Unit"),
    unit_code: String,
    unit_name_kh: String,
    unit_name_en: String,
    factor: { type: Number, default: 1 }, // 1 sale unit = factor base units
    qty: { type: Number, required: true }, // in the sale unit
    base_qty: { type: Number, required: true },
    price: { type: Number, required: true }, // USD per sale unit
    discount: { type: Number, default: 0 }, // USD for the line (incl. its share of the bill discount)
    line_total: { type: Number, required: true }, // USD after discount
    unit_cost: { type: Number, default: null }, // avg cost per base unit when posted (cloud)
    cost_total: { type: Number, default: null },
    refunded_qty: { type: Number, default: 0 }, // in the sale unit, given back later (refund / void)
  },
  { _id: false },
);
const paymentSchema = new mongoose.Schema(
  {
    method_id: oid("PaymentMethod"),
    code: String,
    name_kh: String,
    name_en: String,
    type: String, // cash | qr | card | bank
    currency: String, // USD | KHR
    amount: { type: Number, required: true }, // in its currency
    amount_usd: { type: Number, required: true },
    reference: { type: String, default: "" },
  },
  { _id: false },
);
const saleSchema = new mongoose.Schema(
  {
    uuid: { type: String, required: true }, // from the POS
    invoice_no: { type: String, required: true }, // PP01-P1-2610-00001
    device_id: { ...oid("PosDevice"), required: true },
    warehouse_id: { ...oid("Warehouse"), required: true },
    shift_no: { type: String, default: "" },
    cashier_id: oid("User"),
    cashier_name: String,
    discount_by: oid("User"), // manager who approved a discount
    discount_by_name: { type: String, default: "" },
    stock_override_by: oid("User"), // manager who allowed selling with 0 or less stock
    stock_override_by_name: { type: String, default: "" },
    stock_override_items: { type: Array, default: [] }, // [{ variant_id, sku, stock, qty }]
    sold_at: { type: Date, required: true },
    items: { type: [lineSchema], default: [] },
    subtotal: { type: Number, required: true }, // before discounts
    discount_total: { type: Number, default: 0 },
    tax_mode: { type: String, default: "none" },
    tax_rate: { type: Number, default: 0 },
    tax_amount: { type: Number, default: 0 },
    total: { type: Number, required: true }, // USD to pay
    rate: { type: Number, required: true }, // 1 USD = rate KHR
    total_khr: { type: Number, default: 0 },
    payments: { type: [paymentSchema], default: [] },
    paid_usd: { type: Number, default: 0 },
    change_usd: { type: Number, default: 0 },
    change_khr: { type: Number, default: 0 },
    refunded_total: { type: Number, default: 0 }, // USD given back by refunds / void (see RefundModel)
    refund_count: { type: Number, default: 0 },
    refund_status: { type: String, default: "" }, // "" | partial | full
    change_give_usd: { type: Number, default: 0 }, // change handed back in dollars …
    change_give_khr: { type: Number, default: 0 }, // … and in riel
    cost_total: { type: Number, default: null },
    state: { type: String, enum: ["paid", "void"], default: "paid" },
    note: { type: String, default: "" },
    received_at: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
saleSchema.index({ uuid: 1 }, { unique: true });
saleSchema.index({ invoice_no: 1 }, { unique: true });
saleSchema.index({ warehouse_id: 1, sold_at: -1 });
saleSchema.index({ sold_at: -1 });
saleSchema.index({ cashier_id: 1, sold_at: -1 });
const SaleModel = mongoose.model("Sale", saleSchema);

// ---------------------------------------------------------------------------------------------
// Cash drawer shift from a POS (sent with the sales): float, expected vs counted cash at closing.
// One row per device + shift_no; the POS sends it again when it closes (upsert).
// ---------------------------------------------------------------------------------------------
const shiftSchema = new mongoose.Schema(
  {
    device_id: { ...oid("PosDevice"), required: true },
    warehouse_id: { ...oid("Warehouse"), required: true },
    shift_no: { type: String, required: true }, // PP01-P1-S261002-1
    state: { type: String, enum: ["open", "closed"], default: "open" },
    opened_by: oid("User"),
    opened_by_name: { type: String, default: "" },
    opened_at: { type: Date, required: true },
    opening_usd: { type: Number, default: 0 },
    opening_khr: { type: Number, default: 0 },
    closed_by: oid("User"),
    closed_by_name: { type: String, default: "" },
    closed_at: { type: Date, default: null },
    counted_usd: { type: Number, default: null },
    counted_khr: { type: Number, default: null },
    report: { type: Object, default: null }, // invoice_count, sales_total, methods, expected_usd/khr, diff_* …
    note: { type: String, default: "" },
    received_at: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
shiftSchema.index({ device_id: 1, shift_no: 1 }, { unique: true });
shiftSchema.index({ warehouse_id: 1, opened_at: -1 });
const PosShiftModel = mongoose.model("PosShift", shiftSchema);

// ---------------------------------------------------------------------------------------------
// Refund / void from a POS: money back for some or all items of an invoice. Stock comes back into the shop
// (refund_in, at the cost of the sale); reports count it on the day of the refund. uuid → safe to push again.
// ---------------------------------------------------------------------------------------------
const refundLineSchema = new mongoose.Schema(
  {
    index: Number, // line of the invoice
    product_id: oid("Product"),
    variant_id: { ...oid("ProductVariant"), required: true },
    sku: String,
    name_kh: String,
    name_en: String,
    unit_id: oid("Unit"),
    unit_code: String,
    unit_name_kh: String,
    unit_name_en: String,
    factor: { type: Number, default: 1 },
    qty: { type: Number, required: true },
    base_qty: { type: Number, required: true },
    price: Number,
    amount: { type: Number, required: true }, // USD given back for this line
    unit_cost: { type: Number, default: null },
    cost_total: { type: Number, default: null },
  },
  { _id: false },
);
const refundSchema = new mongoose.Schema(
  {
    uuid: { type: String, required: true },
    refund_no: { type: String, required: true }, // PP01-P1-R2610-00001
    kind: { type: String, enum: ["void", "refund"], default: "refund" },
    sale_id: { ...oid("Sale"), required: true },
    invoice_no: String,
    device_id: { ...oid("PosDevice"), required: true },
    warehouse_id: { ...oid("Warehouse"), required: true },
    shift_no: { type: String, default: "" },
    cashier_id: oid("User"),
    cashier_name: String,
    approved_by: oid("User"),
    approved_by_name: { type: String, default: "" },
    refunded_at: { type: Date, required: true },
    reason: { type: String, default: "" },
    items: { type: [refundLineSchema], default: [] },
    total: { type: Number, required: true },
    rate: Number,
    total_khr: Number,
    payments: { type: [paymentSchema], default: [] },
    cost_total: { type: Number, default: 0 },
    received_at: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
refundSchema.index({ uuid: 1 }, { unique: true });
refundSchema.index({ refund_no: 1 }, { unique: true });
refundSchema.index({ sale_id: 1 });
refundSchema.index({ warehouse_id: 1, refunded_at: -1 });
const RefundModel = mongoose.model("SaleRefund", refundSchema);

// POS login / logout (attendance), sent by the POS with the next push
const attendanceSchema = new mongoose.Schema(
  {
    uuid: { type: String, required: true },
    device_id: { ...oid("PosDevice"), required: true },
    warehouse_id: { ...oid("Warehouse"), required: true },
    user_id: oid("User"),
    name: { type: String, default: "" },
    action: { type: String, enum: ["login", "logout"], required: true },
    at: { type: Date, required: true },
  },
  { timestamps: { createdAt: "created_date", updatedAt: false } },
);
attendanceSchema.index({ uuid: 1 }, { unique: true });
attendanceSchema.index({ warehouse_id: 1, at: -1 });
const PosAttendanceModel = mongoose.model("PosAttendance", attendanceSchema);

module.exports = { PosDeviceModel, SaleModel, PosShiftModel, RefundModel, PosAttendanceModel };
