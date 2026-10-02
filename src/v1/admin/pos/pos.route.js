const crypto = require("crypto");
const mongoose = require("mongoose");
const { PosDeviceModel, SaleModel, PosShiftModel, RefundModel, PosAttendanceModel } = require("./pos.model");
const telegram = require("../telegram/telegram.hooks");
const StockMovementModel = require("../stock/movement.model");
const WarehouseModel = require("../setup/warehouse/warehouse.model");
const SettingModel = require("../setup/setting/setting.model");
const ExchangeRateModel = require("../setup/exchange_rate/exchange_rate.model");
const PaymentMethodModel = require("../setup/payment_method/payment_method.model");
const UserModel = require("../user/user.model");
const CategoryModel = require("../product/category/category.model");
const BrandModel = require("../product/brand/brand.model");
const ProductModel = require("../product/item/product.model");
const VariantModel = require("../product/item/variant.model");
const { StockBalanceModel } = require("../stock/balance.model");
const { priceGrid } = require("../product/price/price.service");
const { inTransaction, postMovements, allocateFefo, EPS } = require("../stock/stock.engine");
const { logActivity } = require("../../../util/log");
const { round } = require("../../../util/helper");
const { serverError, noIDFound } = require("../../../util/master_crud");
const { can_manage_stock } = require("../../../util/permission");
const { ROLES } = require("../../../util/user_roles");

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const ok = (res, data, message, status = 200) => res.status(status).json({ success: true, data, message });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const PAIR_MINUTES = 30;
const newPairCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const POPULATE = [
  { path: "warehouse_id", select: "code name_kh name_en type" },
  { path: "created_by", select: "firstname lastname email" },
];
const MAX_PUSH = 100;

// ---------------- device key (x-device-key: <deviceId>.<secret>) ----------------
// The device row is kept 60 s per key so a sync costs no extra DB call.
const keyCache = new Map(); // key → { at, device }
async function device_auth(req, res, next) {
  try {
    const raw = String(req.headers["x-device-key"] || "");
    const [id, secret] = raw.split(".");
    // code tells the POS what happened: DEVICE_UNPAIRED (deleted / new pairing code) · DEVICE_OFF (turned off) → the POS clears its data
    const refuse = (message, status, code) => res.status(status).json({ success: false, code, message });
    if (!isId(id) || !secret) return refuse("POS មិនទាន់ភ្ជាប់ / POS is not paired", 401, "DEVICE_UNPAIRED");
    const hit = keyCache.get(raw);
    let device = hit && Date.now() - hit.at < 60 * 1000 ? hit.device : null;
    if (!device) {
      const d = await PosDeviceModel.findOne({ _id: id, deleted: false }).select("+key_hash").lean();
      if (!d) return refuse("POS នេះត្រូវបានលុបពី Admin / This POS was removed in the admin web", 401, "DEVICE_UNPAIRED");
      if (!d.key_hash || d.key_hash !== sha(secret)) return refuse("POS នេះត្រូវបានផ្តាច់ (លេខកូដថ្មី) — សូមភ្ជាប់ម្តងទៀត / This POS was unlinked (new pairing code) — pair again", 401, "DEVICE_UNPAIRED");
      device = d;
      keyCache.set(raw, { at: Date.now(), device });
    }
    if (!device.status) return refuse("POS នេះត្រូវបានបិទពី Admin / This POS was turned off in the admin web", 403, "DEVICE_OFF");
    req.device = device;
    PosDeviceModel.updateOne({ _id: device._id }, { last_seen_at: new Date(), offline_alerted_at: null, ...(req.headers["x-app-version"] ? { app_version: String(req.headers["x-app-version"]).slice(0, 30) } : {}) }).catch(() => {});
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: serverError, error: err.message });
  }
}
const clearKeyCache = () => keyCache.clear();

// ---------------- what a POS needs to sell offline (one shop) ----------------
async function snapshot(device) {
  const wh = await WarehouseModel.findById(device.warehouse_id).lean();
  const [setting, rate, methods, users, categories, brands, products] = await Promise.all([
    SettingModel.getMain(),
    ExchangeRateModel.currentAt(new Date()),
    PaymentMethodModel.find({ deleted: false, status: true }).sort({ sort_order: 1 }).lean(),
    // staff of this shop with a POS PIN (cashiers + shop managers)
    UserModel.find({ deleted: false, status: true, warehouse_ids: wh._id, pos_pin: { $ne: null }, role: { $in: [ROLES.CASHIER.value, ROLES.SHOP_MANAGER.value] } })
      .select("firstname lastname email role pos_pin")
      .lean(),
    CategoryModel.find({ deleted: false, status: { $ne: false } }).select("code name_kh name_en parent_id image sort_order").sort({ sort_order: 1 }).lean(),
    BrandModel.find({ deleted: false, status: { $ne: false } }).select("code name_kh name_en").lean(),
    ProductModel.find({ deleted: false, status: true })
      .select("code name_kh name_en category_id brand_id base_unit_id units image track_stock track_batch allow_discount is_taxable sort_order")
      .populate([{ path: "base_unit_id", select: "code name_kh name_en" }, { path: "units.unit_id", select: "code name_kh name_en" }])
      .sort({ sort_order: 1, code: 1 })
      .lean(),
  ]);
  const variants = await VariantModel.find({ deleted: false, status: true, product_id: { $in: products.map((p) => p._id) } })
    .select("product_id code name_kh name_en options barcode unit_barcodes image is_default sort_order")
    .sort({ sort_order: 1 })
    .lean();
  const [grid, balances] = await Promise.all([
    priceGrid(variants, { warehouseId: wh._id }),
    StockBalanceModel.find({ warehouse_id: wh._id }).select("variant_id qty").lean(),
  ]);
  const priceOf = new Map(grid.map((g) => [String(g.variant_id), g.units]));
  const qtyOf = new Map(balances.map((b) => [String(b.variant_id), b.qty]));
  const byProduct = new Map();
  variants.forEach((v) => {
    const k = String(v.product_id);
    if (!byProduct.has(k)) byProduct.set(k, []);
    byProduct.get(k).push(v);
  });
  const unitRow = (u) => (u ? { _id: u._id, code: u.code, name_kh: u.name_kh, name_en: u.name_en || u.name_kh } : null);

  const items = [];
  for (const p of products) {
    const vs = byProduct.get(String(p._id)) || [];
    if (!vs.length) continue;
    const saleUnits = [
      { ...unitRow(p.base_unit_id), factor: 1, is_base: true },
      ...(p.units || []).filter((u) => u.is_sale_unit && u.unit_id).map((u) => ({ ...unitRow(u.unit_id), factor: u.factor, is_base: false })),
    ];
    items.push({
      _id: p._id,
      code: p.code,
      name_kh: p.name_kh,
      name_en: p.name_en || p.name_kh,
      category_id: p.category_id,
      brand_id: p.brand_id,
      image: p.image?.url || null,
      track_stock: p.track_stock !== false,
      track_batch: !!p.track_batch,
      allow_discount: p.allow_discount !== false,
      is_taxable: p.is_taxable !== false,
      units: saleUnits,
      variants: vs.map((v) => {
        const prices = {};
        (priceOf.get(String(v._id)) || []).forEach((u) => {
          if (u.price !== null && u.price !== undefined) prices[String(u.unit_id)] = u.price;
        });
        return {
          _id: v._id,
          code: v.code,
          name_kh: v.name_kh,
          name_en: v.name_en || v.name_kh,
          is_default: !!v.is_default,
          options: (v.options || []).map((o) => ({ attribute_code: o.attribute_code, value_code: o.value_code, name_kh: o.name_kh, name_en: o.name_en, color_hex: o.color_hex || null })),
          barcode: v.barcode || null,
          unit_barcodes: (v.unit_barcodes || []).map((b) => ({ unit_id: b.unit_id, barcode: b.barcode })),
          image: v.image?.url || null,
          prices, // { unit_id: USD }
          stock: qtyOf.get(String(v._id)) || 0, // shop qty at pull time (base unit)
        };
      }),
    });
  }

  return {
    server_time: new Date(),
    device: { _id: device._id, name: device.name, code: device.code },
    warehouse: { _id: wh._id, code: wh.code, name_kh: wh.name_kh, name_en: wh.name_en || wh.name_kh, type: wh.type, address: wh.address || "", phone: wh.phone || "" },
    setting: {
      company_name_kh: setting?.company_name_kh || "",
      company_name_en: setting?.company_name_en || "",
      logo: setting?.logo?.url || null,
      address: setting?.address || "",
      phone: setting?.phone || "",
      vat_no: setting?.vat_no || "",
      base_currency: setting?.base_currency || "USD",
      khr_rounding: setting?.khr_rounding ?? 100,
      tax_mode: setting?.tax_mode || "none",
      tax_rate: setting?.tax_rate || 0,
      tax_name: setting?.tax_name || "VAT",
      receipt_header: setting?.receipt_header || "",
      receipt_footer: setting?.receipt_footer || "",
      ui_theme: setting?.ui_theme || "forest", // admin → General settings → System theme
    },
    rate: rate ? { rate: rate.rate, effective_from: rate.effective_from } : null,
    payment_methods: methods.map((m) => ({ _id: m._id, code: m.code, name_kh: m.name_kh, name_en: m.name_en || m.name_kh, type: m.type, currency: m.currency, requires_reference: !!m.requires_reference, icon: m.icon?.url || null })),
    users: users.map((u) => ({ _id: u._id, firstname: u.firstname, lastname: u.lastname, email: u.email, role: u.role, is_manager: u.role === ROLES.SHOP_MANAGER.value, pin_hash: u.pos_pin })),
    categories: categories.map((c) => ({ _id: c._id, code: c.code, name_kh: c.name_kh, name_en: c.name_en || c.name_kh, parent_id: c.parent_id || null, image: c.image?.url || null })),
    brands: brands.map((b) => ({ _id: b._id, code: b.code, name_kh: b.name_kh, name_en: b.name_en || b.name_kh })),
    products: items,
  };
}

// ---------------- one invoice from a POS → Sale + stock out ----------------
async function saveSale(device, inv) {
  if (!inv || typeof inv.uuid !== "string" || inv.uuid.length < 8 || inv.uuid.length > 64) return { error: "uuid ខុស" };
  if (await SaleModel.exists({ uuid: inv.uuid })) return { duplicate: true };
  const invoiceNo = String(inv.invoice_no || "").trim();
  if (!invoiceNo.startsWith(`${device.code}-`)) return { error: `លេខវិក្កយបត្រត្រូវចាប់ផ្តើមដោយ ${device.code}-` };
  if (await SaleModel.exists({ invoice_no: invoiceNo })) return { error: `លេខវិក្កយបត្រ ${invoiceNo} មានរួចហើយ` };
  const items = Array.isArray(inv.items) ? inv.items : [];
  if (!items.length || items.length > 500) return { error: "វិក្កយបត្រគ្មានទំនិញ" };
  const soldAt = inv.sold_at ? new Date(inv.sold_at) : new Date();
  if (Number.isNaN(soldAt.getTime())) return { error: "sold_at ខុស" };

  const variantIds = items.map((i) => i.variant_id).filter(isId);
  const variants = await VariantModel.find({ _id: { $in: variantIds } }).select("product_id code").lean();
  const vById = new Map(variants.map((v) => [String(v._id), v]));
  const products = await ProductModel.find({ _id: { $in: variants.map((v) => v.product_id) } }).select("track_stock track_batch name_kh").lean();
  const pById = new Map(products.map((p) => [String(p._id), p]));
  const lines = [];
  for (const i of items) {
    const v = vById.get(String(i.variant_id));
    if (!v) return { error: `រកមិនឃើញទំនិញ ${i.sku || i.variant_id}` };
    const qty = Number(i.qty);
    const factor = Number(i.factor) || 1;
    if (!Number.isFinite(qty) || qty <= 0) return { error: `ចំនួនខុស (${i.sku})` };
    lines.push({
      product_id: v.product_id,
      variant_id: v._id,
      sku: i.sku || v.code,
      name_kh: i.name_kh,
      name_en: i.name_en,
      unit_id: isId(i.unit_id) ? i.unit_id : null,
      unit_code: i.unit_code,
      unit_name_kh: i.unit_name_kh,
      unit_name_en: i.unit_name_en,
      factor,
      qty: round(qty, 4),
      base_qty: round(qty * factor, 4),
      price: round(Number(i.price) || 0, 4),
      discount: round(Number(i.discount) || 0, 4),
      line_total: round(Number(i.line_total) || 0, 4),
    });
  }

  const r = await inTransaction(async (session) => {
    const [sale] = await SaleModel.create(
      [
        {
          uuid: inv.uuid,
          invoice_no: invoiceNo,
          device_id: device._id,
          warehouse_id: device.warehouse_id,
          shift_no: String(inv.shift_no || ""),
          cashier_id: isId(inv.cashier_id) ? inv.cashier_id : null,
          cashier_name: String(inv.cashier_name || ""),
          discount_by: isId(inv.discount_by) ? inv.discount_by : null,
          discount_by_name: String(inv.discount_by_name || "").slice(0, 80),
          stock_override_by: isId(inv.stock_override_by) ? inv.stock_override_by : null,
          stock_override_by_name: String(inv.stock_override_by_name || "").slice(0, 80),
          stock_override_items: (Array.isArray(inv.stock_override_items) ? inv.stock_override_items : []).slice(0, 100).map((x) => ({ variant_id: String(x.variant_id || ""), sku: String(x.sku || ""), stock: Number(x.stock) || 0, qty: Number(x.qty) || 0 })),
          sold_at: soldAt,
          items: lines,
          subtotal: round(Number(inv.subtotal) || 0, 4),
          discount_total: round(Number(inv.discount_total) || 0, 4),
          tax_mode: inv.tax_mode || "none",
          tax_rate: Number(inv.tax_rate) || 0,
          tax_amount: round(Number(inv.tax_amount) || 0, 4),
          total: round(Number(inv.total) || 0, 2),
          rate: Number(inv.rate) || 4100,
          total_khr: Math.round(Number(inv.total_khr) || 0),
          payments: (Array.isArray(inv.payments) ? inv.payments : []).map((p) => ({
            method_id: isId(p.method_id) ? p.method_id : null,
            code: p.code,
            name_kh: p.name_kh,
            name_en: p.name_en,
            type: p.type,
            currency: p.currency,
            amount: Number(p.amount) || 0,
            amount_usd: round(Number(p.amount_usd) || 0, 4),
            reference: String(p.reference || "").slice(0, 60),
          })),
          paid_usd: round(Number(inv.paid_usd) || 0, 4),
          change_usd: round(Number(inv.change_usd) || 0, 4),
          change_khr: Math.round(Number(inv.change_khr) || 0),
          change_give_usd: round(Number(inv.change_give_usd) || 0, 2),
          change_give_khr: Math.round(Number(inv.change_give_khr) || 0),
          note: String(inv.note || "").slice(0, 300),
        },
      ],
      { session },
    );
    // stock out of the shop (FEFO batches; whatever has no batch stock goes out without a batch; negative allowed)
    const moves = [];
    for (const l of lines) {
      const p = pById.get(String(l.product_id));
      if (p && p.track_stock === false) continue;
      const base = { warehouse_id: device.warehouse_id, product_id: l.product_id, variant_id: l.variant_id, type: "sale_out", allow_negative: true, label: l.sku };
      if (p?.track_batch) {
        const { allocations, short } = await allocateFefo(device.warehouse_id, l.variant_id, l.base_qty, { session, at: soldAt, includeExpired: true });
        allocations.forEach((a) => moves.push({ ...base, batch_id: a.batch_id, qty: -a.qty }));
        if (short > EPS) moves.push({ ...base, qty: -short });
      } else moves.push({ ...base, qty: -l.base_qty });
    }
    const posted = await postMovements(moves, { session, userId: sale.cashier_id || device.created_by, date: soldAt, ref_type: "invoice", ref_id: sale._id, ref_no: invoiceNo });
    // cost of each line (average cost at the time)
    const costByVariant = new Map();
    posted.forEach((m) => costByVariant.set(String(m.variant_id), (costByVariant.get(String(m.variant_id)) || 0) + -m.total_cost));
    let costTotal = 0;
    sale.items.forEach((l) => {
      const c = costByVariant.get(String(l.variant_id));
      if (c === undefined) return;
      l.cost_total = round(c, 4);
      l.unit_cost = l.base_qty ? round(c / l.base_qty, 6) : 0;
      costTotal += c;
      costByVariant.delete(String(l.variant_id)); // same variant twice: first line carries it
    });
    sale.cost_total = round(costTotal, 4);
    await sale.save({ session });
    return sale;
  });
  if (r.error) return { error: r.error };
  return { sale: r.result };
}

// a refund / void sent by the POS → stock back into the shop (same batches the sale took, cost of the sale)
async function saveRefund(device, rf) {
  if (!rf || typeof rf.uuid !== "string" || rf.uuid.length < 8 || rf.uuid.length > 64) return { error: "uuid ខុស" };
  if (await RefundModel.exists({ uuid: rf.uuid })) return { duplicate: true };
  const no = String(rf.refund_no || "").trim();
  if (!no.startsWith(`${device.code}-`)) return { error: `លេខសងប្រាក់ត្រូវចាប់ផ្តើមដោយ ${device.code}-` };
  const sale = await SaleModel.findOne({ device_id: device._id, $or: [{ uuid: String(rf.sale_uuid || "") }, { invoice_no: String(rf.invoice_no || "") }] });
  // the invoice is not in the cloud yet → the POS tries again with the next push
  if (!sale) return { error: `វិក្កយបត្រ ${rf.invoice_no} មិនទាន់មកដល់ Cloud / invoice not in the cloud yet` };
  const at = rf.refunded_at ? new Date(rf.refunded_at) : new Date();
  if (Number.isNaN(at.getTime())) return { error: "refunded_at ខុស" };
  const items = Array.isArray(rf.items) ? rf.items : [];
  if (!items.length || items.length > 500) return { error: "គ្មានទំនិញសង" };
  const left = sale.items.map((i) => (i.qty || 0) - (i.refunded_qty || 0));
  const lines = [];
  for (const it of items) {
    let k = Number.isInteger(it.index) && sale.items[it.index] && String(sale.items[it.index].variant_id) === String(it.variant_id) ? it.index : -1;
    if (k < 0) k = sale.items.findIndex((x, n) => String(x.variant_id) === String(it.variant_id) && left[n] > 1e-9);
    const sl = sale.items[k];
    const qty = Number(it.qty);
    if (!sl || !(qty > 0)) return { error: `បន្ទាត់ខុស (${it.sku})` };
    if (qty > left[k] + 1e-6) return { error: `${it.sku}: សងលើសចំនួនលក់ / more than sold` };
    left[k] -= qty;
    const base = round((sl.base_qty / sl.qty) * qty, 4);
    lines.push({
      index: k,
      product_id: sl.product_id,
      variant_id: sl.variant_id,
      sku: sl.sku,
      name_kh: sl.name_kh,
      name_en: sl.name_en,
      unit_id: sl.unit_id,
      unit_code: sl.unit_code,
      unit_name_kh: sl.unit_name_kh,
      unit_name_en: sl.unit_name_en,
      factor: sl.factor,
      qty: round(qty, 4),
      base_qty: base,
      price: sl.price,
      amount: round(Number(it.amount) || 0, 4),
      unit_cost: sl.unit_cost ?? null,
      cost_total: sl.unit_cost === null || sl.unit_cost === undefined ? null : round(sl.unit_cost * base, 4),
    });
  }
  const r = await inTransaction(async (session) => {
    const [doc] = await RefundModel.create(
      [
        {
          uuid: rf.uuid,
          refund_no: no,
          kind: rf.kind === "void" ? "void" : "refund",
          sale_id: sale._id,
          invoice_no: sale.invoice_no,
          device_id: device._id,
          warehouse_id: device.warehouse_id,
          shift_no: String(rf.shift_no || ""),
          cashier_id: isId(rf.cashier_id) ? rf.cashier_id : null,
          cashier_name: String(rf.cashier_name || ""),
          approved_by: isId(rf.approved_by) ? rf.approved_by : null,
          approved_by_name: String(rf.approved_by_name || "").slice(0, 80),
          refunded_at: at,
          reason: String(rf.reason || "").slice(0, 200),
          items: lines,
          total: round(Number(rf.total) || 0, 2),
          rate: Number(rf.rate) || sale.rate,
          total_khr: Math.round(Number(rf.total_khr) || 0),
          payments: (Array.isArray(rf.payments) ? rf.payments : []).map((p) => ({ method_id: isId(p.method_id) ? p.method_id : null, code: p.code, name_kh: p.name_kh, name_en: p.name_en, type: p.type, currency: p.currency, amount: Number(p.amount) || 0, amount_usd: round(Number(p.amount_usd) || 0, 4), reference: String(p.reference || "").slice(0, 60) })),
          cost_total: round(lines.reduce((t, l) => t + (l.cost_total || 0), 0), 4),
        },
      ],
      { session },
    );
    // back into the same batches the sale took (minus what earlier refunds already put back)
    const products = await ProductModel.find({ _id: { $in: lines.map((l) => l.product_id) } }).select("track_stock").session(session).lean();
    const tracked = new Map(products.map((p) => [String(p._id), p.track_stock !== false]));
    const saleMoves = await StockMovementModel.find({ ref_type: "invoice", ref_id: sale._id, type: "sale_out" }).session(session).lean();
    const earlier = await RefundModel.find({ sale_id: sale._id, _id: { $ne: doc._id } }).select("_id").session(session).lean();
    const backMoves = earlier.length ? await StockMovementModel.find({ ref_type: "refund", ref_id: { $in: earlier.map((x) => x._id) } }).session(session).lean() : [];
    const moves = [];
    for (const l of lines) {
      if (!tracked.get(String(l.product_id))) continue;
      const base = { warehouse_id: device.warehouse_id, product_id: l.product_id, variant_id: l.variant_id, type: "refund_in", unit_cost: l.unit_cost, label: l.sku };
      let need = l.base_qty;
      for (const m of saleMoves.filter((x) => String(x.variant_id) === String(l.variant_id) && x.batch_id)) {
        const back = backMoves.filter((x) => String(x.variant_id) === String(l.variant_id) && String(x.batch_id) === String(m.batch_id)).reduce((t, x) => t + x.qty, 0) + moves.filter((x) => String(x.variant_id) === String(l.variant_id) && String(x.batch_id) === String(m.batch_id)).reduce((t, x) => t + x.qty, 0);
        const room = round(-m.qty - back, 4);
        if (room <= EPS || need <= EPS) continue;
        const q = Math.min(room, need);
        moves.push({ ...base, batch_id: m.batch_id, qty: q });
        need = round(need - q, 4);
      }
      if (need > EPS) moves.push({ ...base, qty: need });
    }
    await postMovements(moves, { session, userId: doc.cashier_id || device.created_by, date: at, ref_type: "refund", ref_id: doc._id, ref_no: no });
    // the invoice remembers what went back
    lines.forEach((l) => {
      sale.items[l.index].refunded_qty = round((sale.items[l.index].refunded_qty || 0) + l.qty, 4);
    });
    sale.refunded_total = round((sale.refunded_total || 0) + doc.total, 2);
    sale.refund_count = (sale.refund_count || 0) + 1;
    sale.refund_status = sale.items.every((i) => (i.qty || 0) - (i.refunded_qty || 0) < 1e-6) ? "full" : "partial";
    sale.markModified("items");
    await sale.save({ session });
    return doc;
  });
  if (r.error) return { error: r.error };
  return { refund: r.result };
}

// a shift sent by the POS (open, and again when closed) → upsert by device + shift_no
async function saveShift(device, s) {
  const no = String(s?.shift_no || "").trim();
  if (!no.startsWith(`${device.code}-`)) return { error: `លេខវេនត្រូវចាប់ផ្តើមដោយ ${device.code}-` };
  const opened = new Date(s.opened_at);
  if (Number.isNaN(opened.getTime())) return { error: "opened_at ខុស" };
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v) || 0);
  const closed = s.state === "closed";
  const before = await PosShiftModel.findOne({ device_id: device._id, shift_no: no }).select("state").lean();
  await PosShiftModel.updateOne(
    { device_id: device._id, shift_no: no },
    {
      $set: {
        warehouse_id: device.warehouse_id,
        state: closed ? "closed" : "open",
        opened_by: isId(s.opened_by) ? s.opened_by : null,
        opened_by_name: String(s.opened_by_name || "").slice(0, 80),
        opened_at: opened,
        opening_usd: Number(s.opening_usd) || 0,
        opening_khr: Math.round(Number(s.opening_khr) || 0),
        closed_by: closed && isId(s.closed_by) ? s.closed_by : null,
        closed_by_name: closed ? String(s.closed_by_name || "").slice(0, 80) : "",
        closed_at: closed && s.closed_at ? new Date(s.closed_at) : null,
        counted_usd: closed ? num(s.counted_usd) : null,
        counted_khr: closed ? num(s.counted_khr) : null,
        report: closed && s.report && typeof s.report === "object" ? s.report : null,
        note: String(s.note || "").slice(0, 300),
        received_at: new Date(),
      },
    },
    { upsert: true },
  );
  // Telegram: opened (first time we hear of it) / closed (state changed)
  if (!before || (closed && before.state !== "closed")) {
    const doc = await PosShiftModel.findOne({ device_id: device._id, shift_no: no }).lean();
    if (!before && !closed) telegram.shiftOpened(device, doc);
    if (closed) telegram.shiftClosed(device, doc);
  }
  return { ok: true };
}

// /api/admin/pos/device — POS computers (admin, central manager)
// /api/admin/pos-device/… — called BY a POS (API key + x-device-key; pairing only needs the code)
const route = (prop) => {
  const base = `/${prop.main_route}/pos/device`;
  const dev = `/${prop.main_route}/pos-device`;
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_stock];
  const devGuard = [prop.api_auth, device_auth];
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  };
  const log = (req, title) => logActivity({ title, description: `គណនី: ${req.user.email}`, categoryTitle: "setting", createdBy: req.session.user_id, req });
  const send = async (res, id, message, status = 200) => ok(res, await PosDeviceModel.findById(id).populate(POPULATE), message, status);

  // ===================================== ADMIN: devices ================================================
  prop.app.get(base, ...guard, wrap(async (req, res) => {
    const filter = { deleted: false };
    if (isId(req.query.warehouse_id)) filter.warehouse_id = req.query.warehouse_id;
    const data = await PosDeviceModel.find(filter).populate(POPULATE).sort({ code: 1 }).lean();
    const now = Date.now();
    data.forEach((d) => {
      d.paired = !!d.paired_at;
      d.pair_code_valid = !!(d.pair_code && d.pair_expires_at && new Date(d.pair_expires_at).getTime() > now);
      if (!d.pair_code_valid) d.pair_code = null;
    });
    ok(res, data);
  }));

  // { warehouse_id (a shop), name } → new device with a pairing code (valid 30 min)
  prop.app.post(base, ...guard, wrap(async (req, res) => {
    const b = req.body || {};
    const wh = isId(b.warehouse_id) ? await WarehouseModel.findOne({ _id: b.warehouse_id, deleted: false }).lean() : null;
    if (!wh) return bad(res, "សូមជ្រើសរើសហាង!");
    if (wh.type !== "shop") return bad(res, "POS ប្រើបានតែនៅហាង (មិនមែនឃ្លាំងកណ្តាល)");
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) return bad(res, "សូមបញ្ចូលឈ្មោះ POS!");
    const n = (await PosDeviceModel.countDocuments({ warehouse_id: wh._id })) + 1;
    let code = `${wh.code}-P${n}`;
    for (let k = n + 1; await PosDeviceModel.exists({ code }); k++) code = `${wh.code}-P${k}`;
    const doc = await PosDeviceModel.create({
      name,
      code,
      warehouse_id: wh._id,
      pair_code: newPairCode(),
      pair_expires_at: new Date(Date.now() + PAIR_MINUTES * 60 * 1000),
      note: String(b.note || "").slice(0, 200),
      created_by: req.session.user_id,
      updated_by: req.session.user_id,
    });
    await log(req, `POS ${code} (${name}) ត្រូវបានបង្កើត`);
    const out = (await PosDeviceModel.findById(doc._id).populate(POPULATE)).toJSON();
    ok(res, { ...out, pair_code_valid: true }, `បានបង្កើត POS ${code} — វាយលេខកូដ ${doc.pair_code} នៅលើ POS`, 201);
  }));

  prop.app.put(`${base}/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await PosDeviceModel.findOne({ _id: req.params.id, deleted: false });
    if (!doc) return bad(res, "មិនមាន POS នេះ", 404);
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = String(b.name || "").trim().slice(0, 60);
      if (!name) return bad(res, "សូមបញ្ចូលឈ្មោះ POS!");
      doc.name = name;
    }
    if (b.status !== undefined) doc.status = !!b.status;
    if (b.note !== undefined) doc.note = String(b.note || "").slice(0, 200);
    doc.updated_by = req.session.user_id;
    await doc.save();
    clearKeyCache();
    await log(req, `POS ${doc.code} ត្រូវបានកែប្រែ${b.status === false ? " (បិទ)" : ""}`);
    send(res, doc._id, "បានរក្សាទុក");
  }));

  // new pairing code: the old key stops at once (the POS must pair again)
  prop.app.put(`${base}/pair-code/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await PosDeviceModel.findOne({ _id: req.params.id, deleted: false });
    if (!doc) return bad(res, "មិនមាន POS នេះ", 404);
    doc.pair_code = newPairCode();
    doc.pair_expires_at = new Date(Date.now() + PAIR_MINUTES * 60 * 1000);
    doc.key_hash = null;
    doc.key_hint = null;
    doc.paired_at = null;
    doc.updated_by = req.session.user_id;
    await doc.save();
    clearKeyCache();
    await log(req, `POS ${doc.code}: លេខកូដភ្ជាប់ថ្មី (សោចាស់លែងប្រើ)`);
    const out = (await PosDeviceModel.findById(doc._id).populate(POPULATE)).toJSON();
    ok(res, { ...out, pair_code_valid: true }, `លេខកូដភ្ជាប់ថ្មី ${doc.pair_code}`);
  }));

  prop.app.delete(`${base}/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await PosDeviceModel.findOne({ _id: req.params.id, deleted: false });
    if (!doc) return bad(res, "មិនមាន POS នេះ", 404);
    doc.deleted = true;
    doc.status = false;
    doc.key_hash = null;
    doc.pair_code = null;
    doc.updated_by = req.session.user_id;
    await doc.save();
    clearKeyCache();
    await log(req, `POS ${doc.code} ត្រូវបានលុប`);
    ok(res, { _id: doc._id }, "បានលុប");
  }));

  // sales received from POS (admin / central: any shop · ?warehouse_id=&device_id=&from=&to=)
  prop.app.get(`/${prop.main_route}/pos/sale`, ...guard, wrap(async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const filter = {};
    if (isId(req.query.warehouse_id)) filter.warehouse_id = req.query.warehouse_id;
    if (isId(req.query.device_id)) filter.device_id = req.query.device_id;
    if (req.query.from || req.query.to) {
      filter.sold_at = {};
      if (req.query.from) filter.sold_at.$gte = new Date(req.query.from);
      if (req.query.to) filter.sold_at.$lte = new Date(req.query.to);
    }
    if (req.query.q) filter.invoice_no = { $regex: String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    const [data, total] = await Promise.all([
      SaleModel.find(filter).populate([{ path: "warehouse_id", select: "code name_kh name_en" }, { path: "device_id", select: "code name" }]).sort({ sold_at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SaleModel.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data, pagination: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
  }));

  // ===================================== POS DEVICE ================================================
  // { code: "123456", app_version } → { device_key (shown once), device, warehouse }
  prop.app.post(`${dev}/pair`, prop.api_auth, wrap(async (req, res) => {
    const code = String(req.body?.code || "").replace(/\D/g, "");
    if (code.length !== 6) return bad(res, "លេខកូដភ្ជាប់មាន 6 ខ្ទង់ / The pairing code has 6 digits");
    const doc = await PosDeviceModel.findOne({ pair_code: code, deleted: false, pair_expires_at: { $gt: new Date() } });
    if (!doc) return bad(res, "លេខកូដខុស ឬផុតកំណត់ / Wrong or expired pairing code", 404);
    if (!doc.status) return bad(res, "POS នេះត្រូវបានបិទ / This POS is turned off", 403);
    const secret = crypto.randomBytes(24).toString("base64url");
    doc.key_hash = sha(secret);
    doc.key_hint = secret.slice(-4);
    doc.pair_code = null;
    doc.pair_expires_at = null;
    doc.paired_at = new Date();
    doc.last_seen_at = new Date();
    doc.app_version = String(req.body?.app_version || "").slice(0, 30);
    await doc.save();
    clearKeyCache();
    const wh = await WarehouseModel.findById(doc.warehouse_id).select("code name_kh name_en").lean();
    ok(res, { device_key: `${doc._id}.${secret}`, device: { _id: doc._id, name: doc.name, code: doc.code }, warehouse: wh }, `បានភ្ជាប់ ${doc.code}`);
  }));

  prop.app.get(`${dev}/ping`, ...devGuard, wrap(async (req, res) => ok(res, { server_time: new Date(), device: { _id: req.device._id, code: req.device.code, name: req.device.name } })));

  prop.app.get(`${dev}/pull`, ...devGuard, wrap(async (req, res) => {
    const data = await snapshot(req.device);
    PosDeviceModel.updateOne({ _id: req.device._id }, { last_pull_at: new Date() }).catch(() => {});
    ok(res, data);
  }));

  // { invoices: [...] (≤ 100), shifts: [...] (≤ 50) }
  //   → { accepted: [uuid], duplicate: [uuid], failed: [{ uuid, error }], shifts: { saved: [shift_no], failed: [{ shift_no, error }] } }
  prop.app.post(`${dev}/push`, ...devGuard, wrap(async (req, res) => {
    const list = Array.isArray(req.body?.invoices) ? req.body.invoices : [];
    const shifts = Array.isArray(req.body?.shifts) ? req.body.shifts : [];
    const events = Array.isArray(req.body?.events) ? req.body.events : []; // login / logout
    const refunds = Array.isArray(req.body?.refunds) ? req.body.refunds : [];
    if (list.length > MAX_PUSH) return bad(res, `ច្រើនបំផុត ${MAX_PUSH} វិក្កយបត្រក្នុងមួយដង`);
    if (shifts.length > 50) return bad(res, "ច្រើនបំផុត 50 វេនក្នុងមួយដង");
    if (refunds.length > MAX_PUSH) return bad(res, `ច្រើនបំផុត ${MAX_PUSH} ការសងប្រាក់ក្នុងមួយដង`);
    const out = { accepted: [], duplicate: [], failed: [], shifts: { saved: [], failed: [] }, refunds: { accepted: [], duplicate: [], failed: [] }, events: { saved: [] } };
    for (const e of events.slice(0, 200)) {
      try {
        if (!e?.uuid || !["login", "logout"].includes(e.action)) continue;
        const at = new Date(e.at);
        if (Number.isNaN(at.getTime())) continue;
        if (await PosAttendanceModel.exists({ uuid: String(e.uuid) })) {
          out.events.saved.push(e.uuid);
          continue;
        }
        const a = await PosAttendanceModel.create({ uuid: String(e.uuid).slice(0, 64), device_id: req.device._id, warehouse_id: req.device.warehouse_id, user_id: isId(e.user_id) ? e.user_id : null, name: String(e.name || "").slice(0, 80), action: e.action, at });
        out.events.saved.push(e.uuid);
        telegram.posLogin(req.device, a);
      } catch (err) {
        if (err.code === 11000) out.events.saved.push(e.uuid);
      }
    }
    for (const s of shifts) {
      try {
        const r = await saveShift(req.device, s);
        if (r.error) out.shifts.failed.push({ shift_no: s?.shift_no, error: r.error });
        else out.shifts.saved.push(s.shift_no);
      } catch (err) {
        out.shifts.failed.push({ shift_no: s?.shift_no, error: err.message });
      }
    }
    for (const inv of list) {
      try {
        const r = await saveSale(req.device, inv);
        if (r.duplicate) out.duplicate.push(inv.uuid);
        else if (r.error) out.failed.push({ uuid: inv?.uuid, error: r.error });
        else {
          out.accepted.push(inv.uuid);
          telegram.saleReceived(req.device, r.sale);
        }
      } catch (err) {
        if (err.code === 11000) out.duplicate.push(inv?.uuid);
        else out.failed.push({ uuid: inv?.uuid, error: err.message });
      }
    }
    for (const rf of refunds) {
      try {
        const r = await saveRefund(req.device, rf);
        if (r.duplicate) out.refunds.duplicate.push(rf.uuid);
        else if (r.error) out.refunds.failed.push({ uuid: rf?.uuid, error: r.error });
        else {
          out.refunds.accepted.push(rf.uuid);
          telegram.refundReceived(req.device, r.refund);
        }
      } catch (err) {
        if (err.code === 11000) out.refunds.duplicate.push(rf?.uuid);
        else out.refunds.failed.push({ uuid: rf?.uuid, error: err.message });
      }
    }
    PosDeviceModel.updateOne({ _id: req.device._id }, { last_push_at: new Date() }).catch(() => {});
    ok(res, out);
  }));
};

module.exports = route;
module.exports.device_auth = device_auth;
