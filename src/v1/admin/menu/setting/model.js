const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");

// Only ONE document (restaurant info shown on the menu website)
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "main", unique: true },

    restaurant_name: { type: String, default: "" },
    tagline: { type: String, default: "" },
    logo: { type: imageSchema, required: false },

    address: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    website: { type: String, default: "" },
    facebook: { type: String, default: "" },
    telegram: { type: String, default: "" },
    map_url: { type: String, default: "" },

    currency: { type: String, default: "USD" },
    currency_symbol: { type: String, default: "$" },
    exchange_rate_khr: { type: Number, default: 4000 },

    opening_hours: { type: String, default: "" },
    copyright: { type: String, default: "" },

    // Secret part of the public menu link: <menu site>/m/<public_token>
    // Regenerate it (PUT /menu/setting/public-token) to make old links / QR codes stop working.
    public_token: { type: String, default: "" },

    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

module.exports = mongoose.model("Menu_Setting", settingSchema);
