const mongoose = require("mongoose");
const PromotionModel = require("./promotion.model");
const Counter = require("../counter/counter.model");
const { logActivity } = require("../../../util/log");
const { serverError } = require("../../../util/master_crud");
const { allow_roles, can_view_master, ROLE_ADMIN, ROLE_CENTRAL_MANAGER } = require("../../../util/permission");

// =============================================================================================
// Promotions (admin web) — the POS pulls the ones not ended yet and applies them by itself.
//   GET /promotion ?q= &state=active|upcoming|ended|off   · GET /promotion/:id
//   POST /promotion · PUT /promotion/:id · DELETE /promotion/:id   (admin, central manager)
// =============================================================================================
const { PROMO_TYPES, PROMO_SCOPES } = PromotionModel;
const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const ok = (res, data, extra = {}) => res.status(200).json({ success: true, data, ...extra });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(500).json({ success: false, message: serverError, error: err.message }));
const hhmm = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ""));
const ids = (a) => (Array.isArray(a) ? a.filter(isId) : []);
const POP = [
  { path: "warehouse_ids", select: "code name_kh" },
  { path: "category_ids", select: "code name_kh name_en" },
  { path: "brand_ids", select: "code name_kh name_en" },
  { path: "product_ids", select: "code name_kh name_en" },
  { path: "bundle_items.product_id", select: "code name_kh name_en" },
];

// → { error } | fields
function clean(b, partial) {
  const f = {};
  const set = (k, v) => (b[k] !== undefined || !partial) && (f[k] = v);
  if (b.name_kh !== undefined || !partial) {
    f.name_kh = String(b.name_kh || "").trim().slice(0, 120);
    if (!f.name_kh) return { error: "សូមបញ្ចូលឈ្មោះ / Name is required" };
  }
  set("name_en", String(b.name_en || "").trim().slice(0, 120));
  if (b.type !== undefined || !partial) {
    if (!PROMO_TYPES.includes(b.type)) return { error: "ប្រភេទប្រូម៉ូសិនខុស / Wrong promotion type" };
    f.type = b.type;
  }
  const num = (k, d = 0, max = Infinity) => {
    if (b[k] === undefined && partial) return;
    const n = b[k] === "" || b[k] === null || b[k] === undefined ? d : Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${k}: តម្លៃលេខខុស / wrong number`);
    f[k] = n;
  };
  try {
    num("value");
    num("buy_qty", 2, 1000);
    num("get_qty", 1, 1000);
    num("get_percent", 100, 100);
    num("bundle_price");
    num("min_qty");
    num("min_amount");
    num("priority", 0, 1000);
  } catch (e) {
    return { error: e.message };
  }
  if (["percent", "bill_percent"].includes(f.type) && f.value > 100) return { error: "ភាគរយលើស 100 / More than 100%" };
  if (b.scope !== undefined || !partial) f.scope = PROMO_SCOPES.includes(b.scope) ? b.scope : "all";
  ["category_ids", "brand_ids", "product_ids", "warehouse_ids"].forEach((k) => set(k, ids(b[k])));
  if (b.bundle_items !== undefined || !partial)
    f.bundle_items = (Array.isArray(b.bundle_items) ? b.bundle_items : [])
      .filter((i) => isId(i?.product_id) || isId(i?.variant_id))
      .slice(0, 20)
      .map((i) => ({ product_id: isId(i.product_id) ? i.product_id : null, variant_id: isId(i.variant_id) ? i.variant_id : null, qty: Math.max(1, Math.trunc(Number(i.qty) || 1)) }));
  for (const k of ["start_at", "end_at"]) {
    if (b[k] === undefined && partial) continue;
    if (!b[k]) f[k] = null;
    else {
      const d = new Date(b[k]);
      if (Number.isNaN(d.getTime())) return { error: `${k}: ថ្ងៃខែខុស / wrong date` };
      f[k] = d;
    }
  }
  if (f.start_at && f.end_at && f.end_at <= f.start_at) return { error: "ថ្ងៃបញ្ចប់ត្រូវក្រោយថ្ងៃចាប់ផ្តើម / The end must be after the start" };
  set("days", (Array.isArray(b.days) ? b.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  for (const k of ["time_from", "time_to"]) {
    if (b[k] === undefined && partial) continue;
    if (b[k] && !hhmm(b[k])) return { error: `${k}: ម៉ោងខុស (HH:mm) / wrong time` };
    f[k] = b[k] || "";
  }
  if ((f.time_from && !f.time_to) || (!f.time_from && f.time_to)) return { error: "សូមបញ្ចូលម៉ោងចាប់ផ្តើម និងបញ្ចប់ / Give both times" };
  if (b.member_only !== undefined || !partial) f.member_only = !!b.member_only;
  if (b.status !== undefined) f.status = !!b.status;
  set("note", String(b.note || "").slice(0, 300));
  return f;
}
// rules that need the whole document
function check(d) {
  if (d.type === "buy_x_get_y" && !(d.buy_qty >= 1 && d.get_qty >= 1)) return "ទិញ / ថែម ត្រូវ ≥ 1";
  if (d.type === "bundle" && !(d.bundle_items || []).length) return "សូមជ្រើសទំនិញក្នុងឈុត / Choose the bundle items";
  if (["percent", "amount_off", "bill_percent", "bill_amount"].includes(d.type) && !(d.value > 0)) return "សូមបញ្ចូលតម្លៃបញ្ចុះ / Enter the discount";
  if (["percent", "amount_off", "buy_x_get_y"].includes(d.type) && d.scope !== "all") {
    const list = { category: d.category_ids, brand: d.brand_ids, product: d.product_ids }[d.scope];
    if (!(list || []).length) return "សូមជ្រើសទំនិញ / ប្រភេទ / ម៉ាក / Choose what it applies to";
  }
  return null;
}

const route = (prop) => {
  const base = `/${prop.main_route}/promotion`;
  const auth = [prop.api_auth, prop.jwt_auth, prop.request_user];
  const viewGuard = [...auth, can_view_master];
  const editGuard = [...auth, allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER)];
  const log = (req, title) => logActivity({ title, description: `គណនី: ${req.user.email}`, categoryTitle: "promotion", createdBy: req.session.user_id, req }).catch(() => {});

  prop.app.get(base, ...viewGuard, wrap(async (req, res) => {
    const q = req.query;
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 200);
    const now = new Date();
    const f = { deleted: false };
    if (q.q) f.$or = [{ name_kh: { $regex: escapeRe(q.q), $options: "i" } }, { name_en: { $regex: escapeRe(q.q), $options: "i" } }, { code: { $regex: escapeRe(q.q), $options: "i" } }];
    if (PROMO_TYPES.includes(q.type)) f.type = q.type;
    if (q.state === "active") Object.assign(f, { status: true, $and: [{ $or: [{ start_at: null }, { start_at: { $lte: now } }] }, { $or: [{ end_at: null }, { end_at: { $gte: now } }] }] });
    if (q.state === "upcoming") Object.assign(f, { status: true, start_at: { $gt: now } });
    if (q.state === "ended") f.end_at = { $lt: now };
    if (q.state === "off") f.status = false;
    const [data, total] = await Promise.all([PromotionModel.find(f).populate(POP).sort({ status: -1, priority: -1, created_date: -1 }).skip((page - 1) * limit).limit(limit).lean(), PromotionModel.countDocuments(f)]);
    ok(res, data, { pagination: { total, totalPages: Math.ceil(total / limit) || 1, currentPage: page, pageSize: limit } });
  }));

  prop.app.get(`${base}/:id`, ...viewGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, "ID ខុស");
    const d = await PromotionModel.findOne({ _id: req.params.id, deleted: false }).populate(POP).lean();
    if (!d) return bad(res, "រកមិនឃើញ / Not found", 404);
    ok(res, d);
  }));

  prop.app.post(base, ...editGuard, wrap(async (req, res) => {
    const f = clean(req.body || {}, false);
    if (f.error) return bad(res, f.error);
    const err = check(f);
    if (err) return bad(res, err);
    const c = await Counter.findOneAndUpdate({ key: "PROMOTION" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
    const doc = await PromotionModel.create({ ...f, code: `PR${String(c.seq).padStart(4, "0")}`, created_by: req.session.user_id, updated_by: req.session.user_id });
    await log(req, `ប្រូម៉ូសិនថ្មី ${doc.name_kh} (${doc.code})`);
    res.status(201).json({ success: true, data: doc, message: "បានបង្កើតប្រូម៉ូសិន / Promotion added — the POS gets it at the next sync" });
  }));

  prop.app.put(`${base}/:id`, ...editGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, "ID ខុស");
    const cur = await PromotionModel.findOne({ _id: req.params.id, deleted: false }).lean();
    if (!cur) return bad(res, "រកមិនឃើញ / Not found", 404);
    const f = clean(req.body || {}, true);
    if (f.error) return bad(res, f.error);
    const err = check({ ...cur, ...f });
    if (err) return bad(res, err);
    const doc = await PromotionModel.findOneAndUpdate({ _id: cur._id }, { ...f, updated_by: req.session.user_id }, { returnDocument: "after", runValidators: true }).populate(POP);
    await log(req, `កែប្រូម៉ូសិន ${doc.name_kh} (${doc.code})`);
    ok(res, doc, { message: "បានរក្សាទុក / Saved — the POS gets it at the next sync" });
  }));

  prop.app.delete(`${base}/:id`, ...editGuard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, "ID ខុស");
    const doc = await PromotionModel.findOneAndUpdate({ _id: req.params.id, deleted: false }, { deleted: true, status: false, updated_by: req.session.user_id }, { returnDocument: "after" });
    if (!doc) return bad(res, "រកមិនឃើញ / Not found", 404);
    await log(req, `លុបប្រូម៉ូសិន ${doc.name_kh} (${doc.code})`);
    ok(res, null, { message: "បានលុប / Deleted" });
  }));
};

module.exports = route;
module.exports.forPos = async () => {
  const now = new Date();
  const rows = await PromotionModel.find({ deleted: false, status: true, $or: [{ end_at: null }, { end_at: { $gte: now } }] }).lean();
  return rows.map(({ created_by, updated_by, created_date, updated_date, deleted, __v, ...p }) => p);
};
