const mongoose = require("mongoose");

// Running numbers for documents: key "PO-2610" → seq 1, 2, 3 ...
const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

module.exports = mongoose.model("Counter", counterSchema);
