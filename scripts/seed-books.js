// Creates the 3 menu books from the Le Blend menu sheet (safe to run again — existing codes are skipped)
// and moves the exchange rate from the old default 4100 to 4000.
// Usage: npm run seed:books
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");
const User = require("../src/v1/admin/user/user.model");
const Book = require("../src/v1/admin/menu/book/model");
const Setting = require("../src/v1/admin/menu/setting/model");

const BOOKS = [
  {
    code: "breakfast",
    name_kh: "អាហារពេលព្រឹក",
    name_en: "Breakfast",
    name_cn: "早餐",
    location: "ភោជនីយដ្ឋាន និង កាហ្វេ",
    format: "book",
  },
  {
    code: "lunch_dinner",
    name_kh: "អាហារថ្ងៃត្រង់ និង ពេលល្ងាច",
    name_en: "Lunch & Dinner",
    name_cn: "午餐和晚餐",
    location: "ភោជនីយដ្ឋាន និង ស្កាយបារ",
    format: "book",
  },
  {
    code: "drink",
    name_kh: "ភេសជ្ជៈ",
    name_en: "Drinks",
    name_cn: "饮品",
    location: "ភោជនីយដ្ឋាន ស្កាយបារ និង កាហ្វេ",
    format: "folded",
  },
];

async function run() {
  await connectDB();

  const admin = await User.findOne({ is_super_admin: true, deleted: false }).select("_id");
  if (!admin) {
    console.error("❌ No super admin yet — run: npm run seed");
    process.exit(1);
  }

  for (const [i, book] of BOOKS.entries()) {
    const exists = await Book.exists({ code: book.code, deleted: false });
    if (exists) {
      console.log(`ℹ️  Book "${book.code}" already exists → skipped`);
      continue;
    }
    await Book.create({ ...book, sort_order: i, status: true, deleted: false, created_by: admin._id, updated_by: admin._id });
    console.log(`✅ Book created: ${book.name_en}`);
  }

  // $ → Riel: the menu sheet uses 4,000 (only replaces the old default, never a rate you set yourself)
  const res = await Setting.updateOne({ key: "main", exchange_rate_khr: 4100 }, { exchange_rate_khr: 4000 });
  if (res.modifiedCount) console.log("✅ Exchange rate set to 4000");

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("❌ Seed failed:", err.message);
  await mongoose.connection.close();
  process.exit(1);
});
