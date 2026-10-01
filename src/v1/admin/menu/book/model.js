const mongoose = require("mongoose");
const imageSchema = require("../../../../util/image.schema");

// A printed / digital menu: e.g. Breakfast, Lunch & Dinner, Drinks
// One menu item can be in many books (item.book_ids)
const BOOK_FORMATS = ["book", "folded"]; // សៀវភៅ | ក្រដាសបទ

const bookSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true }, // "breakfast", "lunch_dinner", "drink"
    name_en: { type: String, required: true, trim: true },
    name_kh: { type: String, required: false, trim: true },
    name_cn: { type: String, required: false, trim: true },

    location: { type: String, required: false }, // "ភោជនីយដ្ឋាន និង កាហ្វេ"
    format: { type: String, enum: BOOK_FORMATS, default: "book" },
    serve_from: { type: String, required: false }, // "06:00"
    serve_to: { type: String, required: false }, // "10:00"
    cover: { type: imageSchema, required: false },

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

bookSchema.index({ deleted: 1, sort_order: 1 });

module.exports = mongoose.model("Menu_Book", bookSchema);
module.exports.BOOK_FORMATS = BOOK_FORMATS;
