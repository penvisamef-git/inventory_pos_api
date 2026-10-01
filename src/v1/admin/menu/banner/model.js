const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");

// hero      → big slider at the top
// highlight → small dish slider (can link to a menu item)
// promo     → poster shown inside one category (e.g. Breakfast promotion)
const BANNER_TYPES = ["hero", "highlight", "promo"];

const bannerSchema = new mongoose.Schema(
  {
    type: { type: String, enum: BANNER_TYPES, default: "hero" },
    title: { type: String, required: false, trim: true },
    subtitle: { type: String, required: false },
    image: { type: imageSchema, required: true },

    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Menu_Category",
      required: false,
      default: null,
    },
    menu_item_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Menu_Item",
      required: false,
      default: null,
    },
    link_url: { type: String, required: false },

    // Optional schedule (empty = always show)
    start_date: { type: Date, required: false, default: null },
    end_date: { type: Date, required: false, default: null },

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

bannerSchema.index({ type: 1, deleted: 1, sort_order: 1 });

module.exports = mongoose.model("Menu_Banner", bannerSchema);
module.exports.BANNER_TYPES = BANNER_TYPES;
