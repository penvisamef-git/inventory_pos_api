const mongoose = require("mongoose");
const oid = (ref) => ({ type: mongoose.Schema.Types.ObjectId, ref, default: null });

// Customers of the shops (parents). Made in the admin or on a POS (also offline: `uuid` from the POS).
// points = loyalty balance (sum of the ledger); total_spent / visits from the invoices.
const customerSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true }, // C000123
    uuid: { type: String, default: null }, // made by a POS (offline) — the same customer when pushed again
    name: { type: String, required: true, trim: true }, // parent name
    phone: { type: String, required: true, trim: true }, // digits only (0xx…), unique
    gender: { type: String, enum: ["", "male", "female"], default: "" },
    kid_name: { type: String, trim: true, default: "" },
    kid_birthday: { type: String, default: "" }, // "YYYY-MM-DD"
    kid_gender: { type: String, enum: ["", "boy", "girl"], default: "" },
    address: { type: String, trim: true, default: "" },
    warehouse_id: oid("Warehouse"), // home shop (where the customer was added)
    points: { type: Number, default: 0 },
    total_spent: { type: Number, default: 0 }, // USD, after refunds
    visits: { type: Number, default: 0 },
    last_visit_at: { type: Date, default: null },
    note: { type: String, default: "" },
    status: { type: Boolean, default: true },
    deleted: { type: Boolean, default: false },
    created_by: oid("User"),
    updated_by: oid("User"),
    created_device_id: oid("PosDevice"),
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
customerSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { deleted: false } });
customerSchema.index({ code: 1 }, { unique: true });
customerSchema.index({ uuid: 1 }, { unique: true, partialFilterExpression: { uuid: { $type: "string" } } });
customerSchema.index({ name: 1 });
const CustomerModel = mongoose.model("Customer", customerSchema);

// Every change of points: earn (sale), redeem (sale paid with points), refund (taken back / given back), adjust (admin)
const pointSchema = new mongoose.Schema(
  {
    customer_id: { ...oid("Customer"), required: true },
    type: { type: String, enum: ["earn", "redeem", "refund", "adjust"], required: true },
    points: { type: Number, required: true }, // + / −
    balance: { type: Number, default: 0 }, // after this row
    sale_id: oid("Sale"),
    invoice_no: { type: String, default: "" },
    refund_no: { type: String, default: "" },
    warehouse_id: oid("Warehouse"),
    note: { type: String, default: "" },
    created_by: oid("User"),
    at: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: "created_date", updatedAt: false } },
);
pointSchema.index({ customer_id: 1, at: -1 });
const CustomerPointModel = mongoose.model("CustomerPoint", pointSchema);

module.exports = { CustomerModel, CustomerPointModel };
