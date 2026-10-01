// Creates the first super admin + the settings document.
// Usage: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env, then:  npm run seed
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const connectDB = require("../src/util/db");
const User = require("../src/v1/admin/user/user.model");
const Setting = require("../src/v1/admin/menu/setting/model");

async function run() {
  const email = String(process.env.SEED_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.SEED_ADMIN_PASSWORD || "");

  if (!email || password.length < 8) {
    console.error("❌ Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (8+ characters) in .env");
    process.exit(1);
  }

  await connectDB();

  const exists = await User.findOne({ email, deleted: false });
  if (exists) {
    console.log(`ℹ️  User ${email} already exists → skipped`);
  } else {
    const id = new mongoose.Types.ObjectId();
    await User.create({
      _id: id,
      firstname: "Super",
      lastname: "Admin",
      email,
      password: await bcrypt.hash(password, 10),
      role: null,
      is_super_admin: true,
      is_first_login: false,
      status: true,
      deleted: false,
      created_by: id,
      updated_by: id,
    });
    console.log(`✅ Super admin created: ${email}`);
  }

  const setting = await Setting.findOne({ key: "main" });
  if (!setting) {
    await Setting.create({ key: "main", restaurant_name: "Le Blend" });
    console.log("✅ Setting created");
  }

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("❌ Seed failed:", err.message);
  await mongoose.connection.close();
  process.exit(1);
});
