const mongoose = require("mongoose");
const { CustomerModel, CustomerPointModel } = require("./customer.model");
const svc = require("./customer.service");
const { SaleModel } = require("../pos/pos.model");
const { logActivity } = require("../../../util/log");
const { serverError } = require("../../../util/master_crud");
const { warehouse_scope } = require("../../../util/warehouse_scope");
const { allow_roles, can_view_master, ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_SHOP_MANAGER } = require("../../../util/permission");

// =============================================================================================
// Customers + loyalty points (admin web). The POS adds customers too (push), see pos.route.js.
//   GET    /customer                 list ?q= (name / phone / code / child) &warehouse_id= &birthday_month=1-12 &sort=
//   GET    /customer/birthdays       children with a birthday in the next ?days= (default 7)
//   GET    /customer/:id             one customer + last invoices + points history
//   POST   /customer                 { name, phone, gender, kid_name, kid_birthday, kid_gender, address, warehouse_id, note }
//   PUT    /customer/:id             same fields, status
//   DELETE /customer/:id             soft delete
//   POST   /customer/:id/points      { points: +/-, note } — admin / central manager only
// =============================================================================================
const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const ok = (res, data, extra = {}) => res.status(200).json({ success: true, data, ...extra });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(500).json({ success: false, message: serverError, error: err.message }));
const POP = [{ path: "warehouse_id", select: "code name_kh name_en" }];

const route = (prop) => {
  const base = `/${prop.main_route}/customer`;
  const auth = [prop.api_auth, prop.jwt_auth, prop.request_user];
  const viewGuard = [...auth, can_view_master];
  const editGuard = [...auth, allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_SHOP_MANAGER), warehouse_scope];
  const pointsGuard = [...auth, allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER)];
  const log = (req, title) => logActivity({ title, description: `គណនី: ${req.user.email}`, categoryTitle: "customer", createdBy: req.session.user_id, req }).catch(() => {});

  prop.app.get(base, ...viewGuard, wrap(async (req, res) => {
    const q = req.query;
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 200);
    const f = { deleted: false };
    if (q.q) {
      const t = String(q.q).trim();
      const re = { $regex: escapeRe(t), $options: "i" };
      const digits = t.replace(/\D/g, "");
      f.$or = [{ name: re }, { code: re }, { kid_name: re }, ...(digits.length >= 3 ? [{ phone: { $regex: escapeRe(digits.replace(/^855/, "0")) } }] : [])];
    }
    if (isId(q.warehouse_id)) f.warehouse_id = q.warehouse_id;
    const m = parseInt(q.birthday_month, 10);
    if (m >= 1 && m <= 12) f.kid_birthday = { $regex: `^\\d{4}-${String(m).padStart(2, "0")}-` };
    if (q.status === "true" || q.status === "false") f.status = q.status === "true";
    const SORTS = { name: { name: 1 }, points: { points: -1 }, total_spent: { total_spent: -1 }, last_visit_at: { last_visit_at: -1 }, created_date: { created_date: -1 } };
    const sort = SORTS[q.sort] || { created_date: -1 };
    const [data, total, sums] = await Promise.all([
      CustomerModel.find(f).populate(POP).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      CustomerModel.countDocuments(f),
      CustomerModel.aggregate([{ $match: { deleted: false } }, { $group: { _id: null, customers: { $sum: 1 }, points: { $sum: "$points" }, spent: { $sum: "$total_spent" } } }]),
    ]);
    ok(res, data, { pagination: { total, totalPages: Math.ceil(total / limit) || 1, currentPage: page, pageSize: limit }, summary: sums[0] || { customers: 0, points: 0, spent: 0 }, loyalty: await svc.loyalty() });
  }));

  prop.app.get(`${base}/birthdays`, ...viewGuard, wrap(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 0), 60);
    const now = new Date(Date.now() + 7 * 3600e3);
    const mds = Array.from({ length: days + 1 }, (_, k) => new Date(now.getTime() + k * 86400000).toISOString().slice(5, 10));
    const rows = await CustomerModel.find({ deleted: false, status: true, kid_birthday: { $regex: `^\\d{4}-(${mds.join("|")})$` } }).populate(POP).lean();
    rows.forEach((c) => {
      c.days_left = mds.indexOf(c.kid_birthday.slice(5));
      c.turns = Number(now.toISOString().slice(0, 4)) - Number(c.kid_birthday.slice(0, 4));
    });
    ok(res, rows.sort((a, b) => a.days_left - b.days_left));
  }));

  prop.app.get(`${base}/:id`, ...viewGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, "ID ខុស");
    const c = await CustomerModel.findOne({ _id: req.params.id, deleted: false }).populate(POP).lean();
    if (!c) return bad(res, "រកមិនឃើញអតិថិជន / Customer not found", 404);
    const [sales, points] = await Promise.all([
      SaleModel.find({ customer_id: c._id }).select("invoice_no sold_at total warehouse_id points_earned points_redeemed refund_status").populate("warehouse_id", "code").sort({ sold_at: -1 }).limit(30).lean(),
      CustomerPointModel.find({ customer_id: c._id }).sort({ at: -1 }).limit(50).populate("created_by", "firstname lastname").lean(),
    ]);
    ok(res, { ...c, sales, point_history: points });
  }));

  prop.app.post(base, ...editGuard, wrap(async (req, res) => {
    const f = svc.cleanFields(req.body || {});
    if (f.error) return bad(res, f.error);
    if (await CustomerModel.exists({ phone: f.phone, deleted: false })) return bad(res, "លេខទូរស័ព្ទនេះមានរួចហើយ / This phone number is already a customer", 409);
    if (!f.warehouse_id && req.warehouse_ids?.length) f.warehouse_id = req.warehouse_ids[0];
    const doc = await CustomerModel.create({ ...f, code: await svc.nextCode(), created_by: req.session.user_id, updated_by: req.session.user_id });
    await log(req, `អតិថិជនថ្មី ${doc.name} (${doc.phone})`);
    res.status(201).json({ success: true, data: doc, message: "បានបង្កើតអតិថិជន / Customer added" });
  }));

  prop.app.put(`${base}/:id`, ...editGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, "ID ខុស");
    const f = svc.cleanFields(req.body || {}, { partial: true });
    if (f.error) return bad(res, f.error);
    if (f.phone && (await CustomerModel.exists({ phone: f.phone, deleted: false, _id: { $ne: req.params.id } }))) return bad(res, "លេខទូរស័ព្ទនេះមានរួចហើយ / This phone number is already a customer", 409);
    const doc = await CustomerModel.findOneAndUpdate({ _id: req.params.id, deleted: false }, { ...f, updated_by: req.session.user_id }, { returnDocument: "after", runValidators: true }).populate(POP);
    if (!doc) return bad(res, "រកមិនឃើញអតិថិជន / Customer not found", 404);
    await log(req, `កែប្រែអតិថិជន ${doc.name} (${doc.phone})`);
    ok(res, doc, { message: "បានរក្សាទុក / Saved" });
  }));

  prop.app.delete(`${base}/:id`, ...editGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, "ID ខុស");
    const doc = await CustomerModel.findOneAndUpdate({ _id: req.params.id, deleted: false }, { deleted: true, updated_by: req.session.user_id }, { returnDocument: "after" });
    if (!doc) return bad(res, "រកមិនឃើញអតិថិជន / Customer not found", 404);
    await log(req, `លុបអតិថិជន ${doc.name} (${doc.phone})`);
    ok(res, null, { message: "បានលុប / Deleted" });
  }));

  prop.app.post(`${base}/:id/points`, ...pointsGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, "ID ខុស");
    const p = Math.trunc(Number(req.body?.points) || 0);
    const note = String(req.body?.note || "").trim().slice(0, 200);
    if (!p) return bad(res, "សូមបញ្ចូលពិន្ទុ / Points are required");
    if (!note) return bad(res, "សូមបញ្ចូលមូលហេតុ / A reason is required");
    const c = await CustomerModel.findOne({ _id: req.params.id, deleted: false }).lean();
    if (!c) return bad(res, "រកមិនឃើញអតិថិជន / Customer not found", 404);
    if (c.points + p < 0) return bad(res, `ពិន្ទុមិនគ្រប់ (មាន ${c.points}) / Not enough points (has ${c.points})`);
    const balance = await svc.addPoints(c._id, p, { type: "adjust", note, created_by: req.session.user_id });
    await log(req, `កែពិន្ទុ ${c.name}: ${p > 0 ? "+" : ""}${p} (${note})`);
    ok(res, { points: balance }, { message: "បានកែពិន្ទុ / Points changed" });
  }));
};

module.exports = route;
