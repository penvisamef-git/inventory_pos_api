const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const UserModel = require("../user/user.model");
const WarehouseModel = require("../setup/warehouse/warehouse.model");
const SettingModel = require("../setup/setting/setting.model");
const ProductModel = require("../product/item/product.model");
const VariantModel = require("../product/item/variant.model");
const { StockBalanceModel, StockBatchBalanceModel } = require("../stock/balance.model");
const TransferModel = require("../stock/transfer/transfer.model");
const StockAdjustmentModel = require("../stock/adjustment/adjustment.model");
const { logActivity } = require("../../../util/log");
const { round } = require("../../../util/helper");
const { serverError, noIDFound } = require("../../../util/master_crud");
const { allow_roles, ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_SHOP_MANAGER, ROLE_CASHIER } = require("../../../util/permission");
const { warehouse_scope, canAccessWarehouse } = require("../../../util/warehouse_scope");

const telegram = require("../telegram/telegram.hooks");
const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const fullName = (u) => `${u.firstname || ""} ${u.lastname || ""}`.trim();
const PIN = /^\d{4,6}$/;

// Shop portal (/shop in the web): dashboard + staff of ONE warehouse.
// admin / central manager: any warehouse · shop manager: own shops only (agreed 1 Oct 2026)
const route = (prop) => {
  const base = `/${prop.main_route}/shop`;
  const can_use_portal = allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_SHOP_MANAGER);
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_use_portal, warehouse_scope];

  // ?warehouse_id= must be a warehouse this user may open
  async function warehouseOf(req, res, id) {
    if (!isId(id) || !canAccessWarehouse(req, id)) {
      res.status(403).json({ success: false, message: "អ្នកមិនមានសិទ្ធិលើឃ្លាំងនេះទេ!" });
      return null;
    }
    const wh = await WarehouseModel.findOne({ _id: id, deleted: false }).lean();
    if (!wh) res.status(404).json({ success: false, message: "មិនមានឃ្លាំងនៅក្នុងប្រព័ន្ធ!" });
    return wh;
  }

  // ===================================== DASHBOARD ================================================
  // GET /shop/summary?warehouse_id=  → stock, low / expiry / transfers / adjustments / staff (+ lists)
  prop.app.get(`${base}/summary`, ...guard, async (req, res) => {
    try {
      const wh = await warehouseOf(req, res, req.query.warehouse_id);
      if (!wh) return;
      const now = new Date();
      const setting = await SettingModel.getMain();
      const alertDays = setting?.expiry_alert_days || 30;

      // stock: every active variant of stock products (0 when no balance row)
      const products = await ProductModel.find({ deleted: false, track_stock: { $ne: false } }).select("code name_kh name_en min_stock image").lean();
      const pById = new Map(products.map((p) => [String(p._id), p]));
      const variants = await VariantModel.find({ deleted: false, status: true, product_id: { $in: products.map((p) => p._id) } }).select("product_id code name_kh name_en options min_stock").lean();
      const bals = await StockBalanceModel.find({ warehouse_id: wh._id }).lean();
      const bMap = new Map(bals.map((b) => [String(b.variant_id), b]));
      const rows = variants.map((v) => {
        const b = bMap.get(String(v._id));
        const p = pById.get(String(v.product_id));
        return { variant_id: v._id, sku: v.code, name_kh: v.name_kh, name_en: v.name_en, options: v.options, image: p?.image, qty: b?.qty || 0, value: b?.total_value || 0, min: v.min_stock ?? p?.min_stock ?? 0 };
      });
      const inStock = rows.filter((r) => r.qty > 0);
      const low = rows.filter((r) => r.min > 0 && r.qty > 0 && r.qty <= r.min); // carried here and running low
      const out = rows.filter((r) => r.qty <= 0 && bMap.has(String(r.variant_id))); // carried before, now empty
      const negative = rows.filter((r) => r.qty < 0);

      const expiring = await StockBatchBalanceModel.find({ warehouse_id: wh._id, qty: { $gt: 0 }, expiry_date: { $ne: null, $lte: new Date(now.getTime() + alertDays * 86400000) } })
        .sort({ expiry_date: 1 })
        .populate([{ path: "variant_id", select: "code name_kh name_en options" }, { path: "batch_id", select: "batch_no" }])
        .lean();

      const [incoming, requested, outgoing, adjDrafts, staff] = await Promise.all([
        TransferModel.find({ to_warehouse_id: wh._id, state: "dispatched" }).populate("warehouse_id", "code name_kh name_en").sort({ dispatched_at: -1 }).lean(),
        TransferModel.find({ to_warehouse_id: wh._id, state: { $in: ["requested", "draft"] } }).populate("warehouse_id", "code").sort({ created_date: -1 }).lean(),
        TransferModel.countDocuments({ warehouse_id: wh._id, state: { $in: ["requested", "draft"] } }),
        StockAdjustmentModel.countDocuments({ warehouse_id: wh._id, state: "draft" }),
        UserModel.find({ warehouse_ids: wh._id, deleted: false }).select("firstname lastname role status pos_pin").lean(),
      ]);
      const allScope = !req.warehouse_ids;
      res.status(200).json({
        success: true,
        data: {
          warehouse: { _id: wh._id, code: wh.code, name_kh: wh.name_kh, name_en: wh.name_en, type: wh.type },
          stock: {
            skus: inStock.length,
            qty: round(inStock.reduce((t, r) => t + r.qty, 0), 4),
            ...(allScope ? { value: round(rows.reduce((t, r) => t + r.value, 0), 2) } : {}),
            low: low.length,
            out: out.length,
            negative: negative.length,
          },
          expiry: { alert_days: alertDays, count: expiring.length, expired: expiring.filter((e) => e.expiry_date <= now).length },
          transfers: { incoming: incoming.length, requested: requested.length, outgoing_pending: outgoing },
          adjustments: { drafts: adjDrafts },
          staff: {
            total: staff.length,
            cashiers: staff.filter((u) => u.role === ROLE_CASHIER).length,
            active: staff.filter((u) => u.status !== false).length,
            no_pin: staff.filter((u) => u.role === ROLE_CASHIER && !u.pos_pin).length,
          },
          low_items: low.sort((a, b) => a.qty / a.min - b.qty / b.min).slice(0, 8).map(({ value, ...r }) => r),
          expiring_items: expiring.slice(0, 6).map((e) => ({ sku: e.variant_id?.code, name_kh: e.variant_id?.name_kh, name_en: e.variant_id?.name_en, batch_no: e.batch_id?.batch_no, expiry_date: e.expiry_date, qty: e.qty, days_left: Math.ceil((new Date(e.expiry_date) - now) / 86400000) })),
          incoming_transfers: incoming.slice(0, 5).map((t) => ({ _id: t._id, doc_no: t.doc_no, from: t.warehouse_id?.code, lines: t.items.length, dispatched_at: t.dispatched_at })),
          requested_transfers: requested.slice(0, 5).map((t) => ({ _id: t._id, doc_no: t.doc_no, state: t.state, lines: t.items.length, created_date: t.created_date })),
          sales: null, // Phase 3: today's sales, shifts, POS status
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== STAFF ================================================
  // Managers handle CASHIERS of their own shop; admin / central any shop. Other roles stay in the admin web.
  const staffPopulate = [{ path: "warehouse_ids", select: "code name_kh name_en" }];

  // the cashier must belong to a warehouse this user may manage
  async function cashierOf(req, res, id) {
    if (!isId(id)) {
      res.status(400).json({ success: false, message: noIDFound });
      return null;
    }
    const u = await UserModel.findOne({ _id: id, deleted: false, is_super_admin: false });
    if (!u) {
      res.status(404).json({ success: false, message: "មិនមានបុគ្គលិកនៅក្នុងប្រព័ន្ធ!" });
      return null;
    }
    if (u.role !== ROLE_CASHIER || !u.warehouse_ids.some((w) => canAccessWarehouse(req, w))) {
      res.status(403).json({ success: false, message: "អ្នកអាចគ្រប់គ្រងបានតែអ្នកគិតលុយនៃហាងរបស់អ្នកប៉ុណ្ណោះ!" });
      return null;
    }
    return u;
  }

  // GET /shop/staff?warehouse_id= → everyone linked to this warehouse (managers + cashiers)
  prop.app.get(`${base}/staff`, ...guard, async (req, res) => {
    try {
      const wh = await warehouseOf(req, res, req.query.warehouse_id);
      if (!wh) return;
      const data = await UserModel.find({ warehouse_ids: wh._id, deleted: false, is_super_admin: false }).populate(staffPopulate).sort({ role: 1, firstname: 1 });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // POST /shop/staff { warehouse_id (shop), firstname, lastname, email, contact, password (≥ 8), pos_pin? } → new CASHIER
  prop.app.post(`${base}/staff`, ...guard, async (req, res) => {
    try {
      const b = req.body || {};
      const wh = await warehouseOf(req, res, b.warehouse_id);
      if (!wh) return;
      if (wh.type !== "shop") return res.status(400).json({ success: false, message: "អ្នកគិតលុយភ្ជាប់បានតែហាង (មិនមែនឃ្លាំងកណ្តាល)!" });
      for (const [k, label] of [["firstname", "គោត្តនាម"], ["lastname", "នាម"], ["email", "សារអេឡិចត្រូនិច"], ["password", "ពាក្យសម្ងាត់"]]) {
        if (!String(b[k] || "").trim()) return res.status(400).json({ success: false, message: `សូមបញ្ចូល ${label}` });
      }
      if (String(b.password).length < 8) return res.status(400).json({ success: false, message: "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងហោចណាស់ 8 តួ!" });
      if (b.pos_pin && !PIN.test(String(b.pos_pin))) return res.status(400).json({ success: false, message: "PIN ត្រូវជាលេខ 4–6 ខ្ទង់!" });
      const email = String(b.email).trim().toLowerCase();
      if (await UserModel.exists({ email, deleted: false })) return res.status(409).json({ success: false, message: "អ៊ីមែលនេះមាននៅក្នុងប្រព័ន្ធរួចហើយ!" });
      const { user_id: userId } = req.session;
      const u = await UserModel.create({
        firstname: String(b.firstname).trim(),
        lastname: String(b.lastname).trim(),
        email,
        contact: b.contact || "",
        job_title: b.job_title || "Cashier",
        password: await bcrypt.hash(String(b.password), 10),
        pos_pin: b.pos_pin ? await bcrypt.hash(String(b.pos_pin), 10) : null,
        role: ROLE_CASHIER,
        warehouse_ids: [wh._id],
        is_super_admin: false,
        is_first_login: true,
        status: b.status !== false,
        deleted: false,
        created_by: userId,
        updated_by: userId,
      });
      await logActivity({ title: `អ្នកគិតលុយថ្មី ${fullName(u)} (${wh.code}) ត្រូវបានបង្កើត`, description: `បង្កើតដោយគណនី: ${req.user.email}`, categoryTitle: "user", createdBy: userId, req });
      telegram.staffChanged(u, wh._id, "created", req);
      res.status(201).json({ success: true, data: await UserModel.findById(u._id).populate(staffPopulate), message: "អ្នកគិតលុយថ្មីត្រូវបានរក្សាទុក!" });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // PUT /shop/staff/:id { firstname, lastname, contact, job_title, status } (cashier only)
  prop.app.put(`${base}/staff/:id`, ...guard, async (req, res) => {
    try {
      const u = await cashierOf(req, res, req.params.id);
      if (!u) return;
      const b = req.body || {};
      ["firstname", "lastname", "contact", "job_title"].forEach((k) => b[k] !== undefined && (u[k] = String(b[k]).trim()));
      const wasActive = u.status !== false;
      if (b.status !== undefined) u.status = b.status === true || b.status === "true";
      if (wasActive !== (u.status !== false)) telegram.staffChanged(u, u.warehouse_ids[0], u.status === false ? "disabled" : "enabled", req);
      if (!u.firstname || !u.lastname) return res.status(400).json({ success: false, message: "សូមបញ្ចូលឈ្មោះ" });
      u.updated_by = req.session.user_id;
      await u.save();
      await logActivity({ title: `អ្នកគិតលុយ ${fullName(u)} ត្រូវបានកែប្រែ${b.status === false ? " (បិទ)" : ""}`, description: `គណនី: ${req.user.email}`, categoryTitle: "user", createdBy: req.session.user_id, req });
      res.status(200).json({ success: true, data: await UserModel.findById(u._id).populate(staffPopulate), message: "បានរក្សាទុក!" });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // PUT /shop/staff/reset-password/:id { password }
  prop.app.put(`${base}/staff/reset-password/:id`, ...guard, async (req, res) => {
    try {
      const u = await cashierOf(req, res, req.params.id);
      if (!u) return;
      if (String(req.body?.password || "").length < 8) return res.status(400).json({ success: false, message: "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងហោចណាស់ 8 តួ!" });
      u.password = await bcrypt.hash(String(req.body.password), 10);
      u.is_first_login = true;
      u.updated_by = req.session.user_id;
      await u.save();
      await logActivity({ title: `ពាក្យសម្ងាត់អ្នកគិតលុយ ${fullName(u)} ត្រូវបានប្តូរ`, description: `គណនី: ${req.user.email}`, categoryTitle: "user", createdBy: req.session.user_id, req });
      res.status(200).json({ success: true, data: { _id: u._id }, message: "ពាក្យសម្ងាត់ត្រូវបានប្តូរ!" });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // PUT /shop/staff/pos-pin/:id { pos_pin: "1234" | null }
  prop.app.put(`${base}/staff/pos-pin/:id`, ...guard, async (req, res) => {
    try {
      const u = await cashierOf(req, res, req.params.id);
      if (!u) return;
      const pin = req.body?.pos_pin;
      const remove = pin === null || pin === "";
      if (!remove && !PIN.test(String(pin))) return res.status(400).json({ success: false, message: "PIN ត្រូវជាលេខ 4–6 ខ្ទង់!" });
      u.pos_pin = remove ? null : await bcrypt.hash(String(pin), 10);
      u.updated_by = req.session.user_id;
      await u.save();
      await logActivity({ title: `PIN អ្នកគិតលុយ ${fullName(u)} ត្រូវបាន${remove ? "ដកចេញ" : "កំណត់"}`, description: `គណនី: ${req.user.email}`, categoryTitle: "user", createdBy: req.session.user_id, req });
      res.status(200).json({ success: true, data: { _id: u._id, has_pos_pin: !remove }, message: remove ? "PIN ត្រូវបានដកចេញ!" : "PIN ត្រូវបានកំណត់!" });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
