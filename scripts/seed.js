// First-time setup for a new database (safe to run again — existing rows are skipped).
//   1. API key record (api_auth checks API_AUTH_KEY against this collection)
//   2. First super admin
//   3. Setting document, default payment methods, first exchange rate (only when missing)
// Usage: set API_AUTH_KEY, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD in .env, then:  npm run seed
// Sample data for each module is added later with its own seed step.
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const connectDB = require("../src/util/db");
const User = require("../src/v1/admin/user/user.model");
const AuthKey = require("../src/v1/admin/auth/auth_api_key.model");
const Setting = require("../src/v1/admin/setup/setting/setting.model");
const PaymentMethod = require("../src/v1/admin/setup/payment_method/payment_method.model");
const ExchangeRate = require("../src/v1/admin/setup/exchange_rate/exchange_rate.model");

const PAYMENT_METHODS = [
  { code: "cash_usd", name_kh: "សាច់ប្រាក់ ដុល្លារ", name_en: "Cash USD", type: "cash", currency: "USD", sort_order: 0 },
  { code: "cash_khr", name_kh: "សាច់ប្រាក់ រៀល", name_en: "Cash KHR", type: "cash", currency: "KHR", sort_order: 1 },
  { code: "khqr", name_kh: "KHQR", name_en: "KHQR", type: "qr", currency: "any", requires_reference: true, online_mode: true, sort_order: 2 },
  { code: "aba", name_kh: "ABA", name_en: "ABA Pay", type: "qr", currency: "any", requires_reference: true, online_mode: true, sort_order: 3 },
];
const FIRST_RATE = 4100; // change it later in the admin web (ការរៀបចំ → អត្រាប្តូរប្រាក់)

async function seedApiKey() {
  const apiKey = String(process.env.API_AUTH_KEY || "");
  if (!apiKey) {
    console.error("❌ Set API_AUTH_KEY in .env");
    return;
  }
  const exists = await AuthKey.findOne({ api_auth_key: apiKey });
  if (exists) {
    console.log("ℹ️  API key already saved → skipped");
    return;
  }
  await AuthKey.create({ api_auth_key: apiKey });
  console.log("✅ API key saved");
}

async function seedSuperAdmin() {
  const email = String(process.env.SEED_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.SEED_ADMIN_PASSWORD || "");

  if (!email || password.length < 8) {
    console.error("❌ Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (8+ characters) in .env");
    return;
  }

  const exists = await User.findOne({ email, deleted: false });
  if (exists) {
    console.log(`ℹ️  User ${email} already exists → skipped`);
    return;
  }

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

async function seedSystem() {
  const admin = await User.findOne({ is_super_admin: true, deleted: false });
  if (!admin) return;

  await Setting.getMain();
  console.log("✅ Setting ready");

  for (const row of PAYMENT_METHODS) {
    if (await PaymentMethod.exists({ code: row.code, deleted: false })) continue;
    await PaymentMethod.create({ ...row, status: true, deleted: false, created_by: admin._id, updated_by: admin._id });
    console.log(`✅ Payment method ${row.code} created`);
  }

  if (!(await ExchangeRate.exists({ deleted: false }))) {
    await ExchangeRate.create({
      rate: FIRST_RATE,
      effective_from: new Date(),
      note: "Seed",
      created_by: admin._id,
      updated_by: admin._id,
    });
    console.log(`✅ Exchange rate 1 USD = ${FIRST_RATE} ៛ created`);
  }
}

async function run() {
  await connectDB();
  await seedApiKey();
  await seedSuperAdmin();
  await seedSystem();
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("❌ Seed failed:", err.message);
  await mongoose.connection.close();
  process.exit(1);
});
