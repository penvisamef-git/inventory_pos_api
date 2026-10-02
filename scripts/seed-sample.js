// UAT sample data (baby & kid store) — replace with the client's real data later.
// Safe to run again: rows are matched by code and only created when missing.
// Needs a super admin first (npm run seed).   Usage: npm run seed:sample
require("dotenv").config();
require("./lib/test_db_guard").assertTestDb("Sample data");
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");
const User = require("../src/v1/admin/user/user.model");
const bcrypt = require("bcrypt");
const Warehouse = require("../src/v1/admin/setup/warehouse/warehouse.model");
const Unit = require("../src/v1/admin/product/unit/unit.model");
const Category = require("../src/v1/admin/product/category/category.model");
const Attribute = require("../src/v1/admin/product/attribute/attribute.model");
const Brand = require("../src/v1/admin/product/brand/brand.model");
const Product = require("../src/v1/admin/product/item/product.model");
const Variant = require("../src/v1/admin/product/item/variant.model");
const { buildProduct } = require("../src/v1/admin/product/item/product.service");
const Price = require("../src/v1/admin/product/price/price.model");
const { checkItem, insertPrices } = require("../src/v1/admin/product/price/price.service");
const { ROLES } = require("../src/util/user_roles");

// Password + POS PIN for every sample user (UAT only — change in production)
const SAMPLE_PASSWORD = "Sample@2026";
const SAMPLE_PIN = "1234";

// ================= Warehouses =================
const WAREHOUSES = [
  {
    code: "WH01",
    name_kh: "ឃ្លាំងកណ្តាល",
    name_en: "Central Warehouse",
    type: "central",
    address: "ភ្នំពេញ",
    allow_negative_stock: false,
    sort_order: 0,
  },
  {
    code: "PP01",
    name_kh: "ហាង ភ្នំពេញ ០១",
    name_en: "Phnom Penh Shop 01",
    type: "shop",
    address: "ភ្នំពេញ",
    allow_negative_stock: true,
    sort_order: 1,
  },
  {
    code: "PP02",
    name_kh: "ហាង ភ្នំពេញ ០២",
    name_en: "Phnom Penh Shop 02",
    type: "shop",
    address: "ភ្នំពេញ",
    allow_negative_stock: true,
    sort_order: 2,
  },
];

// ================= Units =================
const UNITS = [
  { code: "pcs", name_kh: "ដុំ", name_en: "Piece", sort_order: 0 },
  { code: "pack", name_kh: "កញ្ចប់", name_en: "Pack", sort_order: 1 },
  { code: "box", name_kh: "ប្រអប់", name_en: "Box", sort_order: 2 },
  { code: "set", name_kh: "ឈុត", name_en: "Set", sort_order: 3 },
  { code: "bottle", name_kh: "ដប", name_en: "Bottle", sort_order: 4 },
  { code: "can", name_kh: "កំប៉ុង", name_en: "Can", sort_order: 5 },
  { code: "pair", name_kh: "គូ", name_en: "Pair", sort_order: 6 },
];

// ================= Categories (parent → children) =================
const CATEGORIES = [
  { code: "clothing", name_kh: "សម្លៀកបំពាក់", name_en: "Clothing", children: [
    { code: "clothing_bodysuit", name_kh: "អាវជាប់ខោ (Romper)", name_en: "Bodysuits & Rompers" },
    { code: "clothing_tops", name_kh: "អាវ", name_en: "Tops" },
    { code: "clothing_bottoms", name_kh: "ខោ", name_en: "Bottoms" },
    { code: "clothing_sets", name_kh: "ឈុត", name_en: "Sets" },
    { code: "clothing_sleepwear", name_kh: "សម្លៀកបំពាក់គេង", name_en: "Sleepwear" },
  ] },
  { code: "diapers", name_kh: "កន្ទប និងក្រដាសជូត", name_en: "Diapers & Wipes", children: [
    { code: "diapers_tape", name_kh: "កន្ទបបិទ", name_en: "Tape Diapers" },
    { code: "diapers_pants", name_kh: "កន្ទបខោ", name_en: "Pants Diapers" },
    { code: "wipes", name_kh: "ក្រដាសជូតសើម", name_en: "Wet Wipes" },
  ] },
  { code: "bath_care", name_kh: "ងូតទឹក និងថែរក្សា", name_en: "Bath & Skincare", children: [
    { code: "bath_shampoo", name_kh: "សាប៊ូកក់សក់", name_en: "Shampoo & Wash" },
    { code: "bath_lotion", name_kh: "ឡេ និងប្រេង", name_en: "Lotion & Oil" },
    { code: "bath_powder", name_kh: "ម្សៅ", name_en: "Powder" },
  ] },
  { code: "feeding", name_kh: "ការបំបៅ", name_en: "Feeding", children: [
    { code: "feeding_formula", name_kh: "ទឹកដោះគោម្សៅ", name_en: "Formula Milk" },
    { code: "feeding_bottles", name_kh: "ដបទឹកដោះ", name_en: "Bottles & Teats" },
    { code: "feeding_food", name_kh: "អាហារកុមារ", name_en: "Baby Food" },
  ] },
  { code: "toys", name_kh: "ប្រដាប់ក្មេងលេង", name_en: "Toys", children: [] },
  { code: "accessories", name_kh: "គ្រឿងប្រើប្រាស់", name_en: "Accessories", children: [
    { code: "acc_hats_socks", name_kh: "មួក និងស្រោមជើង", name_en: "Hats & Socks" },
    { code: "acc_shoes", name_kh: "ស្បែកជើង", name_en: "Shoes" },
  ] },
];

// ================= Attributes (variants) =================
const ATTRIBUTES = [
  { code: "size", name_kh: "ទំហំ", name_en: "Size", type: "size", sort_order: 0, values: [
    ["nb", "ទើបកើត", "Newborn"], ["0-3m", "0-3 ខែ", "0-3M"], ["3-6m", "3-6 ខែ", "3-6M"], ["6-12m", "6-12 ខែ", "6-12M"],
    ["12-18m", "12-18 ខែ", "12-18M"], ["18-24m", "18-24 ខែ", "18-24M"], ["2y", "2 ឆ្នាំ", "2Y"], ["3y", "3 ឆ្នាំ", "3Y"], ["4y", "4 ឆ្នាំ", "4Y"],
  ] },
  { code: "diaper_size", name_kh: "ទំហំកន្ទប", name_en: "Diaper size", type: "size", sort_order: 1, values: [
    ["nb", "NB", "NB"], ["s", "S", "S"], ["m", "M", "M"], ["l", "L", "L"], ["xl", "XL", "XL"], ["xxl", "XXL", "XXL"],
  ] },
  { code: "color", name_kh: "ពណ៌", name_en: "Color", type: "color", sort_order: 2, values: [
    ["white", "ស", "White", "#FFFFFF"], ["pink", "ផ្កាឈូក", "Pink", "#F9A8D4"], ["blue", "ខៀវ", "Blue", "#93C5FD"],
    ["yellow", "លឿង", "Yellow", "#FDE68A"], ["green", "បៃតង", "Green", "#86EFAC"], ["grey", "ប្រផេះ", "Grey", "#D1D5DB"],
  ] },
];

// ================= Brands =================
const BRANDS = [
  { code: "little_bear", name_kh: "ឡីថលប៊ែរ (ម៉ាកហាង)", name_en: "Little Bear (house brand)", sort_order: 0 },
  { code: "pampers", name_kh: "ផេមភើស", name_en: "Pampers", sort_order: 1 },
  { code: "huggies", name_kh: "ហាគីស", name_en: "Huggies", sort_order: 2 },
  { code: "mamypoko", name_kh: "ម៉ាមីប៉ូកូ", name_en: "MamyPoko", sort_order: 3 },
  { code: "johnsons", name_kh: "ចនសុន", name_en: "Johnson's", sort_order: 4 },
  { code: "pigeon", name_kh: "ភីជិន", name_en: "Pigeon", sort_order: 5 },
  { code: "dumex", name_kh: "ឌូម៉ិច", name_en: "Dumex", sort_order: 6 },
];

// ================= Products =================
// axes: { attribute code: [value codes] } → one variant per combination
// units: [[unit code, factor]] · barcode: true → sample EAN-13 (prefix 200 = in-store, never a real product)
const PRODUCTS = [
  { code: "ROMPER01", name_kh: "អាវជាប់ខោកប្បាស", name_en: "Cotton romper", category: "clothing_bodysuit", brand: "little_bear", unit: "pcs", min_stock: 3,
    axes: { size: ["nb", "0-3m", "3-6m", "6-12m"], color: ["white", "pink", "blue"] }, barcode: true },
  { code: "TSHIRT01", name_kh: "អាវយឺតកុមារ", name_en: "Kids T-shirt", category: "clothing_tops", brand: "little_bear", unit: "pcs", min_stock: 3,
    axes: { size: ["12-18m", "18-24m", "2y", "3y", "4y"], color: ["yellow", "green", "grey"] }, barcode: true },
  { code: "SLEEP01", name_kh: "ឈុតគេងទារក", name_en: "Baby sleepsuit", category: "clothing_sleepwear", brand: "little_bear", unit: "pcs", min_stock: 2,
    axes: { size: ["0-3m", "3-6m", "6-12m", "12-18m"], color: ["white", "blue"] }, barcode: true },
  { code: "DIAPANT01", name_kh: "កន្ទបខោ Pampers", name_en: "Pampers baby-dry pants", category: "diapers_pants", brand: "pampers", unit: "pack", units: [["box", 4]], min_stock: 10,
    axes: { diaper_size: ["m", "l", "xl", "xxl"] }, barcode: true },
  { code: "DIATAPE01", name_kh: "កន្ទបបិទ Huggies", name_en: "Huggies tape diapers", category: "diapers_tape", brand: "huggies", unit: "pack", units: [["box", 4]], min_stock: 10,
    axes: { diaper_size: ["nb", "s", "m", "l"] }, barcode: true },
  { code: "WIPES01", name_kh: "ក្រដាសជូតសើម ៨០សន្លឹក", name_en: "Baby wipes 80 sheets", category: "wipes", brand: "mamypoko", unit: "pack", units: [["box", 12]], min_stock: 24, barcode: true },
  { code: "SHAMP01", name_kh: "សាប៊ូកក់សក់ទារក ២០០ml", name_en: "Baby shampoo 200ml", category: "bath_shampoo", brand: "johnsons", unit: "bottle", units: [["box", 24]], min_stock: 12, track_batch: true, barcode: true },
  { code: "LOTION01", name_kh: "ឡេលាបស្បែកទារក ១០០ml", name_en: "Baby lotion 100ml", category: "bath_lotion", brand: "johnsons", unit: "bottle", units: [["box", 24]], min_stock: 12, track_batch: true, barcode: true },
  { code: "POWDER01", name_kh: "ម្សៅទារក ២០០g", name_en: "Baby powder 200g", category: "bath_powder", brand: "johnsons", unit: "bottle", units: [["box", 24]], min_stock: 6, track_batch: true, barcode: true },
  { code: "FORMULA01", name_kh: "ទឹកដោះគោម្សៅ ដំណាក់កាលទី១ ៨០០g", name_en: "Formula milk stage 1 800g", category: "feeding_formula", brand: "dumex", unit: "can", units: [["box", 6]], min_stock: 6, track_batch: true, barcode: true },
  { code: "BOTTLE01", name_kh: "ដបទឹកដោះ ២៤០ml", name_en: "Feeding bottle 240ml", category: "feeding_bottles", brand: "pigeon", unit: "pcs", min_stock: 4,
    axes: { color: ["pink", "blue"] }, barcode: true },
  { code: "SOCKS01", name_kh: "ស្រោមជើងទារក", name_en: "Baby socks", category: "acc_hats_socks", brand: "little_bear", unit: "pair", units: [["pack", 3]], min_stock: 6,
    axes: { color: ["white", "pink", "blue"] }, barcode: true },
  { code: "RATTLE01", name_kh: "ប្រដាប់ក្មេងលេង កណ្តឹងរោទ៍", name_en: "Rattle toy", category: "toys", brand: null, unit: "pcs", min_stock: 2, barcode: true },
];

// ================= Prices (USD) =================
// per product: { base: price | { value code: price }, units: { unit code: price | { value code: price } } }
const PRICES = {
  ROMPER01: { base: { nb: 5.9, "0-3m": 5.9, "3-6m": 6.5, "6-12m": 6.5 } },
  TSHIRT01: { base: { "12-18m": 4.5, "18-24m": 4.5, "2y": 5, "3y": 5, "4y": 5 } },
  SLEEP01: { base: 7.9 },
  DIAPANT01: { base: { m: 13.5, l: 14.5, xl: 15.5, xxl: 16.5 }, units: { box: { m: 52, l: 56, xl: 60, xxl: 64 } } },
  DIATAPE01: { base: { nb: 11, s: 11.5, m: 12.5, l: 13.5 }, units: { box: { nb: 42, s: 44, m: 48, l: 52 } } },
  WIPES01: { base: 1.8, units: { box: 20 } },
  SHAMP01: { base: 4.75, units: { box: 108 } },
  LOTION01: { base: 5.25, units: { box: 120 } },
  POWDER01: { base: 3.9, units: { box: 88 } },
  FORMULA01: { base: 24.5, units: { box: 144 } },
  BOTTLE01: { base: 8.9 },
  SOCKS01: { base: 1.5, units: { pack: 3.99 } },
  RATTLE01: { base: 3.5 },
};
// shop overrides + one upcoming price change (to show the history in the admin)
const SHOP_PRICES = [{ shop: "PP02", product: "DIAPANT01", value: "m", price: 13.9 }];
const UPCOMING_PRICES = [{ product: "FORMULA01", price: 25.5, days: 14 }];

// EAN-13 with check digit: 200 + 9-digit number
let eanSeq = 0;
function sampleEan(seed) {
  const body = `200${String(seed).padStart(9, "0")}`;
  const sum = body.split("").reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

// ================= Users (one per role) =================
const USERS = [
  { email: "central@inventorypos.test", firstname: "Chan", lastname: "Thy", role: ROLES.CENTRAL_MANAGER.value, job_title: "Central Warehouse Manager", shops: [] },
  { email: "accountant@inventorypos.test", firstname: "Sophea", lastname: "Kim", role: ROLES.ACCOUNTANT.value, job_title: "Accountant", shops: [] },
  { email: "manager.pp01@inventorypos.test", firstname: "Dara", lastname: "Sok", role: ROLES.SHOP_MANAGER.value, job_title: "Shop Manager", shops: ["PP01"] },
  { email: "manager.pp02@inventorypos.test", firstname: "Lina", lastname: "Chea", role: ROLES.SHOP_MANAGER.value, job_title: "Shop Manager", shops: ["PP02"] },
  { email: "cashier.pp01@inventorypos.test", firstname: "Nita", lastname: "Ros", role: ROLES.CASHIER.value, job_title: "Cashier", shops: ["PP01"], pin: true },
  { email: "cashier.pp02@inventorypos.test", firstname: "Vanna", lastname: "Heng", role: ROLES.CASHIER.value, job_title: "Cashier", shops: ["PP02"], pin: true },
];

async function seedCategories(adminId) {
  for (const [i, top] of CATEGORIES.entries()) {
    let parent = await Category.findOne({ code: top.code, deleted: false });
    if (!parent) {
      const { children, ...row } = top;
      parent = await Category.create({ ...row, parent_id: null, sort_order: i, created_by: adminId, updated_by: adminId });
      console.log(`✅ Category ${top.code} created`);
    }
    for (const [j, child] of top.children.entries()) {
      if (await Category.exists({ code: child.code, deleted: false })) continue;
      await Category.create({ ...child, parent_id: parent._id, sort_order: j, created_by: adminId, updated_by: adminId });
      console.log(`   ✅ ${child.code}`);
    }
  }
}

async function seedAttributes(adminId) {
  for (const a of ATTRIBUTES) {
    if (await Attribute.exists({ code: a.code, deleted: false })) {
      console.log(`ℹ️  Attribute ${a.code} already exists → skipped`);
      continue;
    }
    const values = a.values.map(([code, name_kh, name_en, color_hex], i) => ({ code, name_kh, name_en, color_hex: color_hex || null, sort_order: i }));
    await Attribute.create({ ...a, values, created_by: adminId, updated_by: adminId });
    console.log(`✅ Attribute ${a.code} created (${values.length} values)`);
  }
}

async function seedUsers(adminId) {
  const password = await bcrypt.hash(SAMPLE_PASSWORD, 10);
  const pin = await bcrypt.hash(SAMPLE_PIN, 10);
  for (const u of USERS) {
    if (await User.exists({ email: u.email, deleted: false })) {
      console.log(`ℹ️  User ${u.email} already exists → skipped`);
      continue;
    }
    const shops = await Warehouse.find({ code: { $in: u.shops }, deleted: false }).select("_id");
    await User.create({
      firstname: u.firstname,
      lastname: u.lastname,
      email: u.email,
      job_title: u.job_title,
      role: u.role,
      warehouse_ids: shops.map((w) => w._id),
      password,
      pos_pin: u.pin ? pin : null,
      is_first_login: false,
      is_super_admin: false,
      status: true,
      deleted: false,
      created_by: adminId,
      updated_by: adminId,
    });
    console.log(`✅ User ${u.email} created`);
  }
}

async function seedProducts(adminId) {
  const idOf = async (Model, code) => (code ? (await Model.findOne({ code, deleted: false }).select("_id"))?._id : null);
  for (const [pi, p] of PRODUCTS.entries()) {
    eanSeq = (pi + 1) * 1000; // stable barcodes on every run
    if (await Product.exists({ code: p.code, deleted: false })) {
      console.log(`ℹ️  Product ${p.code} already exists → skipped`);
      continue;
    }
    const units = [];
    for (const [code, factor] of p.units || []) units.push({ unit_id: await idOf(Unit, code), factor });

    // variants = every combination of the axes
    const attrs = [];
    for (const [code, values] of Object.entries(p.axes || {})) {
      const a = await Attribute.findOne({ code, deleted: false }).lean();
      attrs.push({ a, values: values.map((v) => a.values.find((x) => x.code === v)) });
    }
    let combos = [[]];
    for (const { a, values } of attrs) combos = combos.flatMap((c) => values.map((v) => [...c, { attribute_id: a._id, value_id: v._id }]));
    const variants = combos.map((options) => {
      const row = { options };
      if (p.barcode) {
        row.barcode = sampleEan(++eanSeq);
        row.unit_barcodes = units.map((u) => ({ unit_id: u.unit_id, barcode: sampleEan(++eanSeq) }));
      }
      return row;
    });

    const built = await buildProduct({
      code: p.code, name_kh: p.name_kh, name_en: p.name_en,
      category_id: await idOf(Category, p.category), brand_id: await idOf(Brand, p.brand), base_unit_id: await idOf(Unit, p.unit),
      units, attribute_ids: attrs.map((x) => x.a._id), track_batch: !!p.track_batch, min_stock: p.min_stock, variants,
    });
    if (built.error) {
      console.log(`❌ Product ${p.code}: ${built.error}`);
      continue;
    }
    const product = await Product.create({ ...built.product, sort_order: pi, deleted: false, created_by: adminId, updated_by: adminId });
    await Variant.insertMany(built.variants.map(({ isNew, ...v }) => ({ ...v, product_id: product._id, deleted: false, created_by: adminId, updated_by: adminId })));
    console.log(`✅ Product ${p.code} created (${built.variants.length} variant${built.variants.length > 1 ? "s" : ""})`);
  }
}

async function seedPrices(adminId) {
  const priceOf = (rule, valueCode) => (typeof rule === "object" ? rule[valueCode] : rule);
  for (const [code, rule] of Object.entries(PRICES)) {
    const product = await Product.findOne({ code, deleted: false }).populate("units.unit_id", "code").lean();
    if (!product) continue;
    if (await Price.exists({ product_id: product._id, deleted: false })) {
      console.log(`ℹ️  Prices for ${code} already exist → skipped`);
      continue;
    }
    const variants = await Variant.find({ product_id: product._id, deleted: false }).lean();
    const items = [];
    for (const v of variants) {
      const valueCode = v.options[0]?.value_code;
      items.push({ variant_id: v._id, price: priceOf(rule.base, valueCode) });
      for (const [unitCode, uRule] of Object.entries(rule.units || {})) {
        const pu = product.units.find((u) => u.unit_id.code === unitCode);
        items.push({ variant_id: v._id, unit_id: pu.unit_id._id, price: priceOf(uRule, valueCode) });
      }
    }
    const rows = [];
    for (const it of items) {
      const c = await checkItem(it);
      if (c.error) throw new Error(`${code}: ${c.error}`);
      rows.push({ ...c.row, effective_from: new Date() });
    }
    const r = await insertPrices(rows, adminId);
    if (r.error) throw new Error(`${code}: ${r.error}`);
    console.log(`✅ Prices ${code} (${rows.length})`);
  }
  for (const sp of SHOP_PRICES) {
    const shop = await Warehouse.findOne({ code: sp.shop, deleted: false });
    const product = await Product.findOne({ code: sp.product, deleted: false });
    const variant = await Variant.findOne({ product_id: product._id, deleted: false, "options.value_code": sp.value });
    if (await Price.exists({ variant_id: variant._id, warehouse_id: shop._id, deleted: false })) continue;
    const c = await checkItem({ variant_id: variant._id, warehouse_id: shop._id, price: sp.price });
    await insertPrices([{ ...c.row, effective_from: new Date() }], adminId);
    console.log(`✅ Shop price ${sp.shop} ${variant.code} = $${sp.price}`);
  }
  for (const up of UPCOMING_PRICES) {
    const product = await Product.findOne({ code: up.product, deleted: false });
    const variant = await Variant.findOne({ product_id: product._id, deleted: false });
    if (await Price.exists({ variant_id: variant._id, warehouse_id: null, deleted: false, effective_from: { $gt: new Date() } })) continue;
    const c = await checkItem({ variant_id: variant._id, price: up.price });
    await insertPrices([{ ...c.row, effective_from: new Date(Date.now() + up.days * 86400000) }], adminId);
    console.log(`✅ Upcoming price ${variant.code} = $${up.price} in ${up.days} days`);
  }
}

async function upsertByCode(Model, rows, userId, label) {
  for (const row of rows) {
    const exists = await Model.findOne({ code: row.code, deleted: false });
    if (exists) {
      console.log(`ℹ️  ${label} ${row.code} already exists → skipped`);
      continue;
    }
    await Model.create({ ...row, status: true, deleted: false, created_by: userId, updated_by: userId });
    console.log(`✅ ${label} ${row.code} created`);
  }
}

async function run() {
  await connectDB();

  const admin = await User.findOne({ is_super_admin: true, deleted: false });
  if (!admin) {
    console.error("❌ No super admin yet → run: npm run seed");
    await mongoose.connection.close();
    process.exit(1);
  }

  await upsertByCode(Warehouse, WAREHOUSES, admin._id, "Warehouse");
  await upsertByCode(Unit, UNITS, admin._id, "Unit");
  await seedCategories(admin._id);
  await seedAttributes(admin._id);
  await upsertByCode(Brand, BRANDS, admin._id, "Brand");
  await seedProducts(admin._id);
  await seedPrices(admin._id);
  await seedUsers(admin._id);
  // Phase 2 stock (through the API, as the sample users)
  const app = require("../index");
  await require("./seed-stock").seedStock(app);
  console.log(`\nSample users: password "${SAMPLE_PASSWORD}", cashiers POS PIN "${SAMPLE_PIN}"`);

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("❌ Sample seed failed:", err.message);
  await mongoose.connection.close();
  process.exit(1);
});
