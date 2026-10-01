const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    access_token: { type: String, required: true },
    device: Object,
    time: String,
    create_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    // Snapshot of the user at login (password removed)
    user_data: Object,
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

sessionSchema.index({ access_token: 1 });
sessionSchema.index({ user_id: 1 });

module.exports = mongoose.model("Session", sessionSchema);
