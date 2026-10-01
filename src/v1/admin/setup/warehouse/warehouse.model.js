const mongoose = require("mongoose");

// Central warehouse (no POS) or shop (warehouse + one POS)
const WAREHOUSE_TYPES = ["central", "shop"];

const warehouseSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true }, // WH01, PP01 (also the POS receipt prefix)
    name_kh: { type: String, required: true, trim: true },
    name_en: { type: String, trim: true },
    type: { type: String, enum: WAREHOUSE_TYPES, required: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    manager_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // shop: true (POS may sell when stock shows 0) · central: false
    allow_negative_stock: { type: Boolean, default: false },
    sort_order: { type: Number, default: 0 },

    // >>>>>> Default <<<<< //
    note: String,
    status: {
      type: Boolean,
      default: true,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

warehouseSchema.index({ code: 1 });
warehouseSchema.index({ type: 1, sort_order: 1 });

const WarehouseModel = mongoose.model("Warehouse", warehouseSchema);
WarehouseModel.WAREHOUSE_TYPES = WAREHOUSE_TYPES;

module.exports = WarehouseModel;
