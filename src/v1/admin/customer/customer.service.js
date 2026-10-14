const mongoose = require("mongoose");
const { CustomerModel, CustomerPointModel } = require("./customer.model");
const SettingModel = require("../setup/setting/setting.model");
const Counter = require("../counter/counter.model");

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

// "+855 12 345 678" / "012-345-678" → "012345678" (digits, Cambodian 0-prefix). null when not a phone.
function phoneOf(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("855")) d = `0${d.slice(3)}`;
  if (d && !d.startsWith("0")) d = `0${d}`;
  return d.length >= 8 && d.length <= 11 ? d : null;
}
const ymdOk = (s) => !s || /^\d{4}-\d{2}-\d{2}$/.test(String(s));

async function nextCode() {
  const c = await Counter.findOneAndUpdate({ key: "CUSTOMER" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return `C${String(c.seq).padStart(6, "0")}`;
}

async function loyalty() {
  const s = await SettingModel.getMain();
  return {
    enabled: s?.loyalty_enabled !== false,
    points_per_usd: Number(s?.points_per_usd ?? 1),
    point_value_usd: Number(s?.point_value_usd ?? 0.01),
    min_redeem_points: Number(s?.min_redeem_points ?? 100),
  };
}

// + / − points with a ledger row (balance after)
async function addPoints(customerId, points, row = {}) {
  const p = Math.trunc(Number(points) || 0);
  if (!p) return null;
  const c = await CustomerModel.findOneAndUpdate({ _id: customerId }, { $inc: { points: p } }, { returnDocument: "after" });
  if (!c) return null;
  await CustomerPointModel.create({ customer_id: customerId, points: p, balance: c.points, at: new Date(), ...row });
  return c.points;
}

// clean the editable fields (admin form or POS). → { error } | fields
function cleanFields(b, { partial = false } = {}) {
  const f = {};
  if (b.name !== undefined || !partial) {
    f.name = String(b.name || "").trim().slice(0, 80);
    if (!f.name) return { error: "សូមបញ្ចូលឈ្មោះអតិថិជន / Customer name is required" };
  }
  if (b.phone !== undefined || !partial) {
    f.phone = phoneOf(b.phone);
    if (!f.phone) return { error: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ / Wrong phone number" };
  }
  ["kid_name", "address", "note"].forEach((k) => b[k] !== undefined && (f[k] = String(b[k] || "").trim().slice(0, k === "note" ? 300 : 120)));
  if (b.gender !== undefined) f.gender = ["male", "female"].includes(b.gender) ? b.gender : "";
  if (b.kid_gender !== undefined) f.kid_gender = ["boy", "girl"].includes(b.kid_gender) ? b.kid_gender : "";
  if (b.kid_birthday !== undefined) {
    const d = String(b.kid_birthday || "").slice(0, 10);
    if (!ymdOk(d)) return { error: "ថ្ងៃខែឆ្នាំកំណើតមិនត្រឹមត្រូវ / Wrong birthday (YYYY-MM-DD)" };
    f.kid_birthday = d;
  }
  if (b.warehouse_id !== undefined) f.warehouse_id = isId(b.warehouse_id) ? b.warehouse_id : null;
  if (b.status !== undefined) f.status = !!b.status;
  return f;
}

// a customer made on a POS (maybe offline) → the cloud customer (same uuid, or the same phone number)
async function fromPos(device, c) {
  if (!c || typeof c.uuid !== "string" || c.uuid.length < 8 || c.uuid.length > 64) return { error: "uuid ខុស" };
  const byUuid = await CustomerModel.findOne({ uuid: c.uuid, deleted: false });
  if (byUuid) return { customer: byUuid };
  const f = cleanFields(c);
  if (f.error) return f;
  const byPhone = await CustomerModel.findOne({ phone: f.phone, deleted: false });
  if (byPhone) return { customer: byPhone, merged: true }; // two counters added the same parent offline
  try {
    const doc = await CustomerModel.create({ ...f, uuid: c.uuid, code: await nextCode(), warehouse_id: device.warehouse_id, created_device_id: device._id });
    return { customer: doc, created: true };
  } catch (err) {
    if (err.code === 11000) {
      const again = await CustomerModel.findOne({ $or: [{ uuid: c.uuid }, { phone: f.phone, deleted: false }] });
      if (again) return { customer: again };
    }
    throw err;
  }
}

async function resolve(inv) {
  if (isId(inv.customer_id)) {
    const c = await CustomerModel.findOne({ _id: inv.customer_id, deleted: false });
    if (c) return c;
  }
  if (inv.customer_uuid) return CustomerModel.findOne({ uuid: String(inv.customer_uuid), deleted: false });
  return null;
}

// after an invoice is saved: link the customer, points earned / used, total spent
async function onSale(sale, inv) {
  if (!inv.customer_id && !inv.customer_uuid) return null;
  const c = await resolve(inv);
  if (!c) return null;
  const L = await loyalty();
  const redeemed = Math.max(0, Math.trunc(Number(inv.points_redeemed) || 0));
  const redeemUsd = r2(sale.payments.filter((p) => p.code === "points").reduce((t, p) => t + (p.amount_usd || 0), 0));
  const computed = L.enabled ? Math.floor(Math.max(0, sale.total - redeemUsd) * L.points_per_usd + 1e-9) : 0;
  const earned = Math.max(0, Math.min(computed, Math.trunc(Number(inv.points_earned ?? computed) || 0)));
  sale.customer_id = c._id;
  sale.customer_uuid = c.uuid || String(inv.customer_uuid || "") || null;
  sale.customer_name = c.name;
  sale.customer_phone = c.phone;
  sale.points_earned = earned;
  sale.points_redeemed = redeemed;
  await sale.save();
  const row = { sale_id: sale._id, invoice_no: sale.invoice_no, warehouse_id: sale.warehouse_id };
  if (redeemed) await addPoints(c._id, -redeemed, { ...row, type: "redeem" });
  if (earned) await addPoints(c._id, earned, { ...row, type: "earn" });
  await CustomerModel.updateOne({ _id: c._id }, { $inc: { total_spent: r2(sale.total), visits: 1 }, $max: { last_visit_at: sale.sold_at } });
  return c._id;
}

// after a refund / void: take back the points earned on the refunded part, give back the points used for it
// (rf.points_back from the POS: the part of the refund the customer had paid with points)
async function onRefund(refund, sale, rf = {}) {
  if (!sale?.customer_id) return;
  const row = { sale_id: sale._id, invoice_no: sale.invoice_no, refund_no: refund.refund_no, warehouse_id: sale.warehouse_id, type: "refund" };
  const done = await CustomerPointModel.aggregate([{ $match: { sale_id: sale._id, type: "refund" } }, { $group: { _id: { $gt: ["$points", 0] }, p: { $sum: "$points" } } }]);
  const takenBack = -(done.find((d) => d._id === false)?.p || 0);
  const givenBack = done.find((d) => d._id === true)?.p || 0;
  const value = Number(refund.total) + Number(rf.points_back_usd || 0); // value of the items given back
  const take = Math.min(sale.total > 0 ? Math.round(((sale.points_earned || 0) * value) / sale.total) : 0, (sale.points_earned || 0) - takenBack);
  if (take > 0) await addPoints(sale.customer_id, -take, { ...row, note: "refund" });
  const back = Math.min(Math.max(0, Math.trunc(Number(rf.points_back) || 0)), (sale.points_redeemed || 0) - givenBack);
  if (back > 0) await addPoints(sale.customer_id, back, { ...row, note: "points used given back" });
  await CustomerModel.updateOne({ _id: sale.customer_id }, { $inc: { total_spent: -r2(value) } });
}

// the POS's copy: active customers (small fields)
async function forPos() {
  const rows = await CustomerModel.find({ deleted: false, status: true }).select("code uuid name phone kid_name kid_birthday kid_gender points warehouse_id").sort({ name: 1 }).limit(50000).lean();
  return rows.map((c) => ({ _id: c._id, code: c.code, uuid: c.uuid || null, name: c.name, phone: c.phone, kid_name: c.kid_name, kid_birthday: c.kid_birthday, kid_gender: c.kid_gender, points: c.points, warehouse_id: c.warehouse_id }));
}

module.exports = { phoneOf, nextCode, loyalty, addPoints, cleanFields, fromPos, onSale, onRefund, forPos };
