// Imports the Le Blend menu sheet (scripts/data/le-blend-menu-sheet.json):
//   menu books → categories → items (linked to their category + books).
// Safe to run again: anything whose code already exists is skipped (never changed).
// Usage:  node scripts/import-menu-sheet.js --dry   (only shows what would be created)
//         node scripts/import-menu-sheet.js         (creates)
require("dotenv").config();
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");
const User = require("../src/v1/admin/user/user.model");
const Book = require("../src/v1/admin/menu/book/model");
const Category = require("../src/v1/admin/menu/category/model");
const Item = require("../src/v1/admin/menu/item/model");

const DRY = process.argv.includes("--dry");
const data = require(path.join(__dirname, "data", "le-blend-menu-sheet.json"));

async function run() {
  await connectDB();
  const admin = await User.findOne({ is_super_admin: true, deleted: false }).select("_id");
  if (!admin) throw new Error("No super admin yet — run: npm run seed");
  const by = { created_by: admin._id, updated_by: admin._id };
  const stat = { books: [0, 0], categories: [0, 0], items: [0, 0] }; // [created, skipped]

  // ---- books ----
  const bookId = {};
  for (const b of data.books) {
    const found = await Book.findOne({ code: b.code, deleted: false }).select("_id");
    if (found) {
      bookId[b.code] = found._id;
      stat.books[1]++;
      continue;
    }
    stat.books[0]++;
    if (!DRY) bookId[b.code] = (await Book.create({ ...b, status: true, deleted: false, ...by }))._id;
    else bookId[b.code] = new mongoose.Types.ObjectId();
  }

  // ---- categories ----
  const catId = {};
  for (const c of data.cats) {
    const found = await Category.findOne({ code: c.code, deleted: false }).select("_id");
    if (found) {
      catId[c.code] = found._id;
      stat.categories[1]++;
      continue;
    }
    stat.categories[0]++;
    if (!DRY) catId[c.code] = (await Category.create({ ...c, status: true, deleted: false, ...by }))._id;
    else catId[c.code] = new mongoose.Types.ObjectId();
  }

  // ---- items ----
  const skipped = [];
  for (const it of data.items) {
    if (await Item.exists({ code: it.code, deleted: false })) {
      stat.items[1]++;
      skipped.push(it.code);
      continue;
    }
    stat.items[0]++;
    if (DRY) continue;
    await Item.create({
      code: it.code,
      category_id: catId[it.cat],
      book_ids: it.books.map((code) => bookId[code]).filter(Boolean),
      name_kh: it.name_kh,
      name_en: it.name_en,
      name_cn: it.name_cn,
      price_type: "single",
      price: it.price,
      sizes: [],
      is_featured: false,
      is_available: true,
      sort_order: it.sort_order,
      status: true,
      deleted: false,
      ...by,
    });
  }

  console.log(DRY ? "🔎 DRY RUN — nothing written" : "✅ Import done");
  for (const [k, [c, s]] of Object.entries(stat)) console.log(`   ${k}: ${DRY ? "would create" : "created"} ${c}, skipped (already there) ${s}`);
  if (skipped.length) console.log("   skipped item codes:", skipped.join(", "));
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("❌ Import failed:", err.message);
  await mongoose.connection.close();
  process.exit(1);
});
