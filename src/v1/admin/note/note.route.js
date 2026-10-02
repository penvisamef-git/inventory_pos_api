const mongoose = require("mongoose");
const NoteModel = require("./note.model");
const UserModel = require("../user/user.model");
const { escapeRegex } = require("../../../util/helper");
const { serverError, noIDFound } = require("../../../util/master_crud");

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const ok = (res, data, message, status = 200) => res.status(status).json({ success: true, data, message });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const OWNER = { path: "user_id", select: "firstname lastname email" };
const NOT_FOUND = "មិនមានកំណត់ចំណាំនេះ";

// /api/admin/note — personal notes (every signed-in user)
//   GET    /note?q=&pinned=true&page=&limit=   own notes (super admin: everyone's · ?user_id= one owner)   pinned first, newest first
//   GET    /note/owners                         super admin: who has notes (+ count)
//   GET    /note/:id · POST /note { title, body, color, pinned } · PUT /note/:id (same, any part) · DELETE /note/:id
// A user can only reach their own notes (others' → 404); a super admin can read, edit and delete every note.
// Notes are private: nothing about them goes to the activity log.
const route = (prop) => {
  const base = `/${prop.main_route}/note`;
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user];
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  };
  const isSuper = (req) => !!req.user?.is_super_admin;
  const me = (req) => new mongoose.Types.ObjectId(String(req.user._id));
  const reach = (req, id) => NoteModel.findOne({ _id: id, deleted: false, ...(isSuper(req) ? {} : { user_id: me(req) }) });

  // title / body / color / pinned from the body (partial = only the fields sent)
  const fields = (b, partial) => {
    const out = {};
    if (!partial || b.title !== undefined) out.title = String(b.title ?? "").trim().slice(0, 200);
    if (!partial || b.body !== undefined) {
      const body = String(b.body ?? "");
      if (body.length > 20000) return { error: "កំណត់ចំណាំវែងពេក (អតិបរមា 20,000 តួអក្សរ)" };
      out.body = body;
    }
    if (b.color !== undefined) {
      if (!NoteModel.COLORS.includes(b.color)) return { error: "ពណ៌មិនត្រឹមត្រូវ" };
      out.color = b.color;
    }
    if (b.pinned !== undefined) out.pinned = !!b.pinned;
    return { data: out };
  };

  // ---------------- list ----------------
  prop.app.get(base, ...guard, wrap(async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const filter = { deleted: false };
    if (!isSuper(req)) filter.user_id = me(req);
    else if (isId(req.query.user_id)) filter.user_id = new mongoose.Types.ObjectId(req.query.user_id);
    if (req.query.pinned === "true") filter.pinned = true;
    const text = String(req.query.q || "").trim().slice(0, 100);
    if (text) filter.$or = [{ title: { $regex: escapeRegex(text), $options: "i" } }, { body: { $regex: escapeRegex(text), $options: "i" } }];
    const [data, total] = await Promise.all([
      NoteModel.find(filter).sort({ pinned: -1, updated_date: -1 }).skip((page - 1) * limit).limit(limit).populate(OWNER).lean(),
      NoteModel.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data, scope: isSuper(req) ? "all" : "own", pagination: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
  }));

  // ---------------- owners (super admin) ----------------
  prop.app.get(`${base}/owners`, ...guard, wrap(async (req, res) => {
    if (!isSuper(req)) return bad(res, "អ្នកមិនមានសិទ្ធិធ្វើសកម្មភាពនេះទេ!", 403);
    const rows = await NoteModel.aggregate([{ $match: { deleted: false } }, { $group: { _id: "$user_id", count: { $sum: 1 } } }]);
    const users = await UserModel.find({ _id: { $in: rows.map((r) => r._id) } }).select("firstname lastname email").lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    ok(res, rows.map((r) => ({ ...(byId.get(String(r._id)) || { _id: r._id, email: "?" }), count: r.count })).sort((a, b) => String(a.email).localeCompare(String(b.email))));
  }));

  prop.app.get(`${base}/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await reach(req, req.params.id).populate(OWNER);
    if (!doc) return bad(res, NOT_FOUND, 404);
    ok(res, doc);
  }));

  // ---------------- create (always the caller's own note) ----------------
  prop.app.post(base, ...guard, wrap(async (req, res) => {
    const f = fields(req.body || {}, false);
    if (f.error) return bad(res, f.error);
    if (!f.data.title && !f.data.body.trim()) return bad(res, "សូមសរសេរចំណងជើង ឬខ្លឹមសារ");
    const doc = await NoteModel.create({ ...f.data, user_id: me(req), created_by: me(req), updated_by: me(req) });
    ok(res, await NoteModel.findById(doc._id).populate(OWNER), "បានរក្សាទុកកំណត់ចំណាំ", 201);
  }));

  // ---------------- update ----------------
  prop.app.put(`${base}/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await reach(req, req.params.id);
    if (!doc) return bad(res, NOT_FOUND, 404);
    const f = fields(req.body || {}, true);
    if (f.error) return bad(res, f.error);
    const next = { title: doc.title, body: doc.body, ...f.data };
    if (!next.title && !String(next.body || "").trim()) return bad(res, "សូមសរសេរចំណងជើង ឬខ្លឹមសារ");
    Object.assign(doc, f.data, { updated_by: me(req) });
    await doc.save();
    ok(res, await NoteModel.findById(doc._id).populate(OWNER), "បានរក្សាទុក");
  }));

  // ---------------- delete ----------------
  prop.app.delete(`${base}/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const doc = await reach(req, req.params.id);
    if (!doc) return bad(res, NOT_FOUND, 404);
    doc.deleted = true;
    doc.updated_by = me(req);
    await doc.save();
    ok(res, { _id: doc._id }, "បានលុបកំណត់ចំណាំ");
  }));
};

module.exports = route;
