const mongoose = require("mongoose");
const SupplierModel = require("../supplier/supplier.model");
const GoodsReceiveModel = require("../../stock/receive/receive.model");
const SupplierPaymentModel = require("./supplier_payment.model");
const { nextNo } = require("../../../../util/counter");
const { logActivity } = require("../../../../util/log");
const { serverError } = require("../../../../util/master_crud");
const { allow_roles, ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_ACCOUNTANT } = require("../../../../util/permission");

// /api/admin/purchase/payable — what we owe each supplier (posted goods receives − payments)
// view + pay: admin, central manager, accountant · void a payment: admin
const DAY = 86400000;
const r2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const ok = (res, data, extra = {}) => res.status(200).json({ success: true, data, ...extra });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const billOf = (g) => r2(g.posted_cost ?? g.total_cost ?? 0);
const METHODS = ["cash", "bank", "cheque", "other"];

// pay the oldest bills first → what is still due on each bill, and how much of it is late
function allocate(receives, paidTotal, termDays, now = Date.now()) {
  let left = r2(paidTotal);
  return receives.map((g) => {
    const bill = billOf(g);
    const paid = r2(Math.min(bill, Math.max(0, left)));
    left = r2(left - paid);
    const due = r2(bill - paid);
    const dueDate = new Date(new Date(g.posted_at || g.doc_date).getTime() + (termDays || 0) * DAY);
    return { _id: g._id, doc_no: g.doc_no, doc_date: g.doc_date, posted_at: g.posted_at, supplier_invoice_no: g.supplier_invoice_no, bill, paid, due, due_date: dueDate, overdue: due > 0 && dueDate.getTime() < now, days_late: due > 0 ? Math.max(0, Math.floor((now - dueDate.getTime()) / DAY)) : 0 };
  });
}

async function summaryOf(supplierIds) {
  const match = { state: "posted" };
  if (supplierIds) match.supplier_id = { $in: supplierIds };
  const pm = { voided: false };
  if (supplierIds) pm.supplier_id = { $in: supplierIds };
  const [bills, pays] = await Promise.all([
    GoodsReceiveModel.find(match).select("supplier_id doc_no doc_date posted_at posted_cost total_cost supplier_invoice_no").sort({ posted_at: 1, doc_date: 1 }).lean(),
    SupplierPaymentModel.aggregate([{ $match: pm }, { $group: { _id: "$supplier_id", paid: { $sum: "$amount" }, count: { $sum: 1 }, last: { $max: "$paid_at" } } }]),
  ]);
  const billMap = new Map();
  bills.forEach((g) => {
    const k = String(g.supplier_id);
    if (!billMap.has(k)) billMap.set(k, []);
    billMap.get(k).push(g);
  });
  return { billMap, payMap: new Map(pays.map((p) => [String(p._id), p])) };
}

const route = (prop) => {
  const base = `/${prop.main_route}/purchase/payable`;
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_ACCOUNTANT)];
  const adminGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, allow_roles(ROLE_ADMIN)];
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  };

  // ?q= &open=1 (only suppliers we still owe) → rows + totals
  prop.app.get(base, ...guard, wrap(async (req, res) => {
    const f = { deleted: { $ne: true } };
    if (req.query.q) {
      const re = { $regex: String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
      f.$or = [{ name: re }, { code: re }, { phone: re }];
    }
    const sups = await SupplierModel.find(f).select("code name phone contact_name payment_term_days status").sort({ name: 1 }).lean();
    const { billMap, payMap } = await summaryOf(sups.map((s) => s._id));
    const now = Date.now();
    let rows = sups.map((s) => {
      const k = String(s._id);
      const p = payMap.get(k) || { paid: 0, count: 0, last: null };
      const docs = allocate(billMap.get(k) || [], p.paid, s.payment_term_days, now);
      const billed = r2(docs.reduce((t, d) => t + d.bill, 0));
      const open = docs.filter((d) => d.due > 0);
      return {
        supplier: s,
        billed,
        paid: r2(p.paid),
        balance: r2(billed - p.paid),
        overdue: r2(open.filter((d) => d.overdue).reduce((t, d) => t + d.due, 0)),
        open_bills: open.length,
        oldest_due_date: open[0]?.due_date || null,
        max_days_late: open.reduce((m, d) => Math.max(m, d.days_late), 0),
        last_paid_at: p.last,
        bills: docs.length,
      };
    });
    if (req.query.open === "1") rows = rows.filter((r) => r.balance > 0.004);
    rows.sort((a, b) => b.overdue - a.overdue || b.balance - a.balance);
    const totals = rows.reduce((t, r) => ({ billed: r2(t.billed + r.billed), paid: r2(t.paid + r.paid), balance: r2(t.balance + r.balance), overdue: r2(t.overdue + r.overdue), suppliers_owed: t.suppliers_owed + (r.balance > 0.004 ? 1 : 0) }), { billed: 0, paid: 0, balance: 0, overdue: 0, suppliers_owed: 0 });
    ok(res, rows, { totals });
  }));

  // one supplier: bills (oldest paid first) + payments
  prop.app.get(`${base}/:supplier_id`, ...guard, wrap(async (req, res) => {
    const id = req.params.supplier_id;
    if (!isId(id)) return bad(res, "Supplier?");
    const s = await SupplierModel.findById(id).select("code name phone contact_name payment_term_days").lean();
    if (!s) return bad(res, "រកមិនឃើញអ្នកផ្គត់ផ្គង់ / Supplier not found", 404);
    const [{ billMap, payMap }, payments] = await Promise.all([
      summaryOf([s._id]),
      SupplierPaymentModel.find({ supplier_id: s._id }).populate([{ path: "created_by", select: "firstname lastname email" }, { path: "voided_by", select: "firstname lastname email" }]).sort({ paid_at: -1 }).lean(),
    ]);
    const paid = payMap.get(String(s._id))?.paid || 0;
    const bills = allocate(billMap.get(String(s._id)) || [], paid, s.payment_term_days);
    const billed = r2(bills.reduce((t, d) => t + d.bill, 0));
    ok(res, { supplier: s, billed, paid: r2(paid), balance: r2(billed - paid), overdue: r2(bills.filter((d) => d.overdue).reduce((t, d) => t + d.due, 0)), bills: bills.reverse(), payments });
  }));

  // { supplier_id, amount, paid_at?, method, reference, note } — can't pay more than we owe
  prop.app.post(`${base}/payment`, ...guard, wrap(async (req, res) => {
    const b = req.body || {};
    if (!isId(b.supplier_id)) return bad(res, "សូមជ្រើសរើសអ្នកផ្គត់ផ្គង់ / Pick the supplier");
    const s = await SupplierModel.findById(b.supplier_id).select("name code").lean();
    if (!s) return bad(res, "រកមិនឃើញអ្នកផ្គត់ផ្គង់ / Supplier not found", 404);
    const amount = r2(b.amount);
    if (!(amount > 0)) return bad(res, "ចំនួនទឹកប្រាក់មិនត្រឹមត្រូវ / Wrong amount");
    const method = METHODS.includes(b.method) ? b.method : "bank";
    let paidAt = b.paid_at ? new Date(b.paid_at) : new Date();
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + DAY) return bad(res, "កាលបរិច្ឆេទមិនត្រឹមត្រូវ / Wrong date");
    const { billMap, payMap } = await summaryOf([s._id]);
    const balance = r2((billMap.get(String(s._id)) || []).reduce((t, g) => t + billOf(g), 0) - (payMap.get(String(s._id))?.paid || 0));
    if (amount > balance + 0.004) return bad(res, `លើសពីប្រាក់ជំពាក់ ($${balance.toFixed(2)}) / More than we owe ($${balance.toFixed(2)})`);
    const doc = await SupplierPaymentModel.create({
      doc_no: await nextNo("SP", { date: paidAt }),
      supplier_id: s._id,
      amount,
      paid_at: paidAt,
      method,
      reference: String(b.reference || "").trim().slice(0, 80),
      note: String(b.note || "").trim().slice(0, 300),
      created_by: req.session.user_id,
    });
    logActivity({ title: `បង់ប្រាក់អ្នកផ្គត់ផ្គង់ ${doc.doc_no}`, description: `${s.name} · $${amount.toFixed(2)} · ${req.user.email}`, categoryTitle: "supplier", createdBy: req.session.user_id, req });
    res.status(201).json({ success: true, data: doc, message: `${doc.doc_no} ត្រូវបានរក្សាទុក / saved` });
  }));

  // void a payment (admin) — { reason }
  prop.app.put(`${base}/payment/:id/void`, ...adminGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, "id?");
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    if (!reason) return bad(res, "សូមបញ្ចូលមូលហេតុ / Enter the reason");
    const doc = await SupplierPaymentModel.findOneAndUpdate({ _id: req.params.id, voided: false }, { voided: true, void_reason: reason, voided_by: req.session.user_id, voided_at: new Date() }, { returnDocument: "after" });
    if (!doc) return bad(res, "រកមិនឃើញ ឬបានលុបចោលរួច / Not found or already voided", 404);
    logActivity({ title: `លុបចោលការបង់ប្រាក់ ${doc.doc_no}`, description: `${reason} · ${req.user.email}`, categoryTitle: "supplier", createdBy: req.session.user_id, req });
    ok(res, doc, { message: `${doc.doc_no} ត្រូវបានលុបចោល / voided` });
  }));
};

module.exports = route;
module.exports.allocate = allocate;
