require("dotenv").config();
require("./lib/test_db_guard").assertTestDb("Sample stock");
// UAT sample STOCK data (Phase 2) — called by seed-sample.js after products and prices.
// Goes through the real API in-process (same rules as the admin web), signed in as the sample users.
// Safe to run again: skipped when WH01 already has an opening stock document.
const Supplier = require("../src/v1/admin/purchase/supplier/supplier.model");
const Warehouse = require("../src/v1/admin/setup/warehouse/warehouse.model");
const Product = require("../src/v1/admin/product/item/product.model");
const Variant = require("../src/v1/admin/product/item/variant.model");
const Unit = require("../src/v1/admin/product/unit/unit.model");
const StockOpening = require("../src/v1/admin/stock/opening/opening.model");

const SUPPLIERS = [
  { code: "angkor_baby", name: "Angkor Baby Distribution", contact_name: "Mr. Sokha", phone: "012 555 101", payment_term_days: 30, sort_order: 0 },
  { code: "mekong_diapers", name: "Mekong Diapers Co., Ltd.", contact_name: "Ms. Lina", phone: "012 555 202", payment_term_days: 15, sort_order: 1 },
  { code: "sunrise_care", name: "Sunrise Pharma & Baby Care", contact_name: "Mr. Vibol", phone: "012 555 303", payment_term_days: 30, sort_order: 2 },
  { code: "lb_garment", name: "Little Bear Garment (house brand)", contact_name: "Ms. Dara", phone: "012 555 404", payment_term_days: 0, sort_order: 3 },
];

// opening qty per variant (base unit) and cost ratio of the default price
const OPENING = {
  WH01: { ROMPER01: 20, TSHIRT01: 20, SLEEP01: 12, DIAPANT01: 40, DIATAPE01: 40, WIPES01: 60, SHAMP01: 48, LOTION01: 48, POWDER01: 24, FORMULA01: 30, BOTTLE01: 15, SOCKS01: 30, RATTLE01: 10 },
  PP01: { ROMPER01: 3, TSHIRT01: 3, DIAPANT01: 8, WIPES01: 12, SHAMP01: 6, FORMULA01: 6, BOTTLE01: 3, SOCKS01: 6, RATTLE01: 2 },
  PP02: { ROMPER01: 2, TSHIRT01: 2, DIATAPE01: 8, WIPES01: 10, LOTION01: 6, FORMULA01: 4, SOCKS01: 4 },
};
const COST_RATIO = 0.55;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function seedStock(app) {
  const wh = Object.fromEntries((await Warehouse.find({ code: { $in: ["WH01", "PP01", "PP02"] }, deleted: false }).lean()).map((w) => [w.code, w]));
  if (!wh.WH01 || !wh.PP01 || !wh.PP02) return console.log("ℹ️  Stock: sample warehouses missing → skipped");
  for (const s of SUPPLIERS) {
    if (await Supplier.exists({ code: s.code, deleted: false })) continue;
    const admin = await require("../src/v1/admin/user/user.model").findOne({ is_super_admin: true, deleted: false });
    await Supplier.create({ ...s, created_by: admin._id, updated_by: admin._id });
    console.log(`✅ Supplier ${s.code}`);
  }
  if (await StockOpening.exists({ warehouse_id: wh.WH01._id, state: { $ne: "cancelled" } })) return console.log("ℹ️  Stock sample already exists → skipped");

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const call = async (m, p, t, b) => {
    const r = await fetch(base + p, { method: m, headers: { "x-api-key": process.env.API_AUTH_KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const json = await r.json().catch(() => ({}));
    if (!json.success) throw new Error(`${m} ${p}: ${json.message || r.status}`);
    return json.data;
  };
  const login = async (email) => (await call("POST", "/auth/login", null, { email, password: "Sample@2026" })).access_token;
  try {
    const central = await login("central@inventorypos.test");
    const m1 = await login("manager.pp01@inventorypos.test");
    const m2 = await login("manager.pp02@inventorypos.test");
    const PriceModel = require("../src/v1/admin/product/price/price.model");
    const products = await Product.find({ deleted: false }).lean();
    const pByCode = Object.fromEntries(products.map((p) => [p.code, p]));
    const variantsOf = async (code) => Variant.find({ product_id: pByCode[code]._id, deleted: false }).sort({ sort_order: 1 }).lean();
    const costOf = async (v) => {
      const pr = await PriceModel.findOne({ variant_id: v._id, warehouse_id: null, deleted: false, unit_id: pByCode[Object.keys(pByCode).find((c) => String(pByCode[c]._id) === String(v.product_id))].base_unit_id }).sort({ effective_from: 1 }).lean();
      return Math.round((pr?.price || 1) * COST_RATIO * 100) / 100;
    };

    // ---------- opening stock (posted) ----------
    for (const [code, list] of Object.entries(OPENING)) {
      const items = [];
      for (const [pcode, qty] of Object.entries(list)) {
        const p = pByCode[pcode];
        for (const v of await variantsOf(pcode)) {
          const cost = await costOf(v);
          if (pcode === "FORMULA01") {
            // two batches: one expiring soon (shows in the expiry alert)
            const soon = Math.min(6, qty);
            items.push({ variant_id: v._id, qty: soon, unit_cost: cost, batch_no: "F2401", expiry_date: day(20) });
            if (qty > soon) items.push({ variant_id: v._id, qty: qty - soon, unit_cost: cost, batch_no: "F2405", expiry_date: day(300) });
          } else if (p.track_batch) items.push({ variant_id: v._id, qty, unit_cost: cost, batch_no: `${pcode.slice(0, 3)}2403`, expiry_date: day(400) });
          else items.push({ variant_id: v._id, qty, unit_cost: cost });
        }
      }
      const doc = await call("POST", "/stock/opening", central, { warehouse_id: wh[code]._id, items, note: "ស្តុកដើមគ្រា (sample)" });
      await call("PUT", `/stock/opening/post/${doc._id}`, central);
      console.log(`✅ Opening stock ${code} ${doc.doc_no} (${items.length} lines)`);
    }

    // ---------- goods receive ----------
    const box = await Unit.findOne({ code: "box" }).lean();
    const [dm, dl] = await variantsOf("DIAPANT01");
    const gr1 = await call("POST", "/stock/receive", central, {
      warehouse_id: wh.WH01._id,
      supplier_id: (await Supplier.findOne({ code: "mekong_diapers" }))._id,
      supplier_invoice_no: "MD-INV-0912",
      items: [
        { variant_id: dm._id, unit_id: box._id, qty: 10, unit_cost: 30 },
        { variant_id: dl._id, unit_id: box._id, qty: 10, unit_cost: 32 },
      ],
      note: "Pampers pants M / L",
    });
    await call("PUT", `/stock/receive/post/${gr1._id}`, central);
    console.log(`✅ Goods receive ${gr1.doc_no} posted`);
    const [sh] = await variantsOf("SHAMP01");
    const gr2 = await call("POST", "/stock/receive", central, {
      warehouse_id: wh.WH01._id,
      supplier_id: (await Supplier.findOne({ code: "sunrise_care" }))._id,
      supplier_invoice_no: "SC-7781",
      items: [{ variant_id: sh._id, unit_id: box._id, qty: 2, unit_cost: 60, batch_no: "SHA2409", expiry_date: day(540) }],
    });
    console.log(`✅ Goods receive ${gr2.doc_no} (draft)`);

    // ---------- transfers ----------
    const romp = await variantsOf("ROMPER01");
    const [fm] = await variantsOf("FORMULA01");
    const t1 = await call("POST", "/stock/transfer", central, {
      warehouse_id: wh.WH01._id,
      to_warehouse_id: wh.PP01._id,
      items: [...romp.slice(3, 6).map((v) => ({ variant_id: v._id, qty: 4 })), { variant_id: dm._id, qty: 12 }, { variant_id: fm._id, qty: 6 }],
      note: "ផ្ទេរប្រចាំសប្តាហ៍",
    });
    const d1 = await call("PUT", `/stock/transfer/dispatch/${t1._id}`, central);
    const diaperLine = d1.items.find((i) => String(i.variant_id) === String(dm._id));
    const r1 = await call("PUT", `/stock/transfer/receive/${t1._id}`, m1, { items: [{ _id: diaperLine._id, received_qty: 11 }], note: "ខ្វះកន្ទប ១ កញ្ចប់" });
    console.log(`✅ Transfer ${t1.doc_no} received at PP01 (shortage ${r1.shortage_qty})`);

    const tee = await variantsOf("TSHIRT01");
    const t2 = await call("POST", "/stock/transfer", central, {
      warehouse_id: wh.WH01._id,
      to_warehouse_id: wh.PP02._id,
      items: [...tee.slice(0, 3).map((v) => ({ variant_id: v._id, qty: 3 })), { variant_id: fm._id, qty: 4 }],
    });
    await call("PUT", `/stock/transfer/dispatch/${t2._id}`, central);
    console.log(`✅ Transfer ${t2.doc_no} dispatched to PP02 (in transit)`);

    const tape = await variantsOf("DIATAPE01");
    const t3 = await call("POST", "/stock/transfer", m2, {
      to_warehouse_id: wh.PP02._id,
      items: [{ variant_id: tape[2]._id, qty: 10 }, { variant_id: tape[3]._id, qty: 6 }],
      note: "ស្នើសុំកន្ទបបិទ M / L",
    });
    console.log(`✅ Transfer ${t3.doc_no} requested by PP02`);

    // ---------- adjustments ----------
    const [lo] = await variantsOf("LOTION01");
    const a1 = await call("POST", "/stock/adjustment", central, { warehouse_id: wh.PP02._id, reason: "damaged", items: [{ variant_id: lo._id, qty: 1 }], note: "ដបបែក" });
    await call("PUT", `/stock/adjustment/post/${a1._id}`, central);
    const socks = await variantsOf("SOCKS01");
    const a2 = await call("POST", "/stock/adjustment", m1, { warehouse_id: wh.PP01._id, reason: "lost", items: [{ variant_id: socks[1]._id, qty: 1 }], note: "រកមិនឃើញពេលរាប់" });
    console.log(`✅ Adjustments ${a1.doc_no} (posted), ${a2.doc_no} (draft by PP01 manager)`);
  } finally {
    server.close();
  }
}

module.exports = { seedStock };
