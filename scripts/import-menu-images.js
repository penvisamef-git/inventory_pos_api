// Uploads the dish photos from the Le Blend menu sheet (scripts/data/images/<CODE>.jpg)
// to Cloudinary (folder <CLOUDINARY_FOLDER>/menu) and saves them on the matching menu item.
// Safe to run again: items that already have an image are skipped.
// Usage: node scripts/import-menu-images.js [--only F0001,F0002] [--dry]
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");
const Item = require("../src/v1/admin/menu/item/model");
const { uploadBuffer } = require("../src/util/cloudinary");

const DIR = path.join(__dirname, "data", "images");
const DRY = process.argv.includes("--dry");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const ONLY = process.argv.includes("--only") && onlyArg ? onlyArg.split(",") : null;

async function run() {
  await connectDB();
  const files = fs.readdirSync(DIR).filter((f) => /\.jpe?g$|\.png$|\.webp$/i.test(f));
  const stat = { uploaded: 0, hasImage: 0, noItem: 0, failed: 0 };

  const queue = files.filter((f) => !ONLY || ONLY.includes(path.parse(f).name.toUpperCase()));
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      const code = path.parse(file).name.toUpperCase();
      try {
        const item = await Item.findOne({ code, deleted: false }).select("_id image name_en");
        if (!item) {
          stat.noItem++;
          console.log(`  ? ${code}: no item with this code`);
          continue;
        }
        if (item.image?.url) {
          stat.hasImage++;
          continue;
        }
        if (DRY) {
          stat.uploaded++;
          continue;
        }
        const buffer = fs.readFileSync(path.join(DIR, file));
        const image = await uploadBuffer({ buffer, originalname: `${code}.jpg` }, "menu");
        await Item.updateOne({ _id: item._id }, { image });
        stat.uploaded++;
        console.log(`  ✓ ${code} ${item.name_en || ""}`);
      } catch (err) {
        stat.failed++;
        console.log(`  ✗ ${code}: ${err.message || err.error?.message || err}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  console.log(DRY ? "🔎 DRY RUN" : "✅ Done", stat);
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("❌ Failed:", err.message);
  await mongoose.connection.close();
  process.exit(1);
});
