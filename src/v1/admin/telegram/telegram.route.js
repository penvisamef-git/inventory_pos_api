const mongoose = require("mongoose");
const { TelegramBotModel, TelegramChatModel, TelegramTemplateModel, TelegramScheduleModel, TelegramMessageModel, LANGS } = require("./telegram.model");
const WarehouseModel = require("../setup/warehouse/warehouse.model");
const getFilteredMongoDB = require("../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../util/log");
const { encrypt, maskToken } = require("../../../util/crypto");
const { serverError, noIDFound } = require("../../../util/master_crud");
const { can_manage_setup, can_manage_stock } = require("../../../util/permission");
const { EVENTS, REPORTS, EVENT_CODES, REPORT_CODES } = require("../../../util/telegram_events");
const { tgCall, tokenOf, sendPending, queueSchedule, queueText, buildReport, pickText, render, esc, templatesOf, timeText } = require("./telegram.service");

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ok = (res, data, message, status = 200) => res.status(status).json({ success: true, data, message });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

// /api/admin/telegram — bots, chats, templates, report schedules, message log (admin only; tokens stay in the cloud)
const route = (prop) => {
  const base = `/${prop.main_route}/telegram`;
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_setup];
  // one-click "Send to Telegram" from the stock screens: admin + central manager
  const sendGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_stock];
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  };
  const log = (req, title) => logActivity({ title, description: `គណនី: ${req.user.email}`, categoryTitle: "setting", createdBy: req.session.user_id, req });
  const validWarehouses = async (ids) => {
    const list = (Array.isArray(ids) ? ids : []).filter(isId);
    if (!list.length) return [];
    const found = await WarehouseModel.find({ _id: { $in: list }, deleted: false }).select("_id").lean();
    return found.map((w) => w._id);
  };

  // ===================================== EVENTS / REPORTS (lists for the web) ================================================
  prop.app.get(`${base}/events`, ...guard, wrap(async (req, res) => ok(res, { events: EVENTS.map(({ kh, en, ...e }) => e), reports: REPORTS, languages: LANGS })));

  // ===================================== BOTS ================================================
  // POST { name, token, is_default, note } → token checked with getMe, then stored encrypted
  prop.app.post(`${base}/bot`, ...guard, wrap(async (req, res) => {
    const { name, token, is_default, note } = req.body || {};
    if (!String(name || "").trim()) return bad(res, "សូមបញ្ចូលឈ្មោះ Bot");
    const tok = String(token || "").trim();
    if (!TOKEN.test(tok)) return bad(res, "Token មិនត្រឹមត្រូវ (ទម្រង់: 123456789:AA…) — យកពី @BotFather");
    let me;
    try {
      me = await tgCall(tok, "getMe");
    } catch (err) {
      return bad(res, `Telegram បដិសេធ Token: ${err.message}`);
    }
    if (await TelegramBotModel.exists({ tg_bot_id: me.id, deleted: false })) return bad(res, `Bot @${me.username} មានរួចហើយ`, 409);
    const userId = req.session.user_id;
    if (is_default) await TelegramBotModel.updateMany({}, { is_default: false });
    const bot = await TelegramBotModel.create({
      name: String(name).trim(), username: me.username, tg_bot_id: me.id, token_enc: encrypt(tok), token_hint: maskToken(tok),
      is_default: !!is_default || !(await TelegramBotModel.exists({ deleted: false })), last_check_at: new Date(), note, created_by: userId, updated_by: userId,
    });
    await log(req, `Telegram Bot @${me.username} ត្រូវបានបន្ថែម`);
    ok(res, await TelegramBotModel.findById(bot._id), `Bot @${me.username} ត្រូវបានរក្សាទុក!`, 201);
  }));

  prop.app.get(`${base}/bot`, ...guard, wrap(async (req, res) => {
    const bots = await TelegramBotModel.find({ deleted: false }).sort({ is_default: -1, created_date: 1 }).lean();
    const counts = await TelegramChatModel.aggregate([{ $match: { deleted: false } }, { $group: { _id: "$bot_id", n: { $sum: 1 } } }]);
    const map = new Map(counts.map((c) => [String(c._id), c.n]));
    ok(res, bots.map((b) => ({ ...b, chat_count: map.get(String(b._id)) || 0 })));
  }));

  // PUT { name, token? (replace), is_default, status, note }
  prop.app.put(`${base}/bot/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const bot = await TelegramBotModel.findOne({ _id: req.params.id, deleted: false });
    if (!bot) return bad(res, "មិនមាន Bot", 404);
    const b = req.body || {};
    if (b.name !== undefined) bot.name = String(b.name).trim() || bot.name;
    if (b.note !== undefined) bot.note = b.note;
    if (b.status !== undefined) bot.status = !!b.status;
    if (b.token) {
      const tok = String(b.token).trim();
      if (!TOKEN.test(tok)) return bad(res, "Token មិនត្រឹមត្រូវ");
      let me;
      try {
        me = await tgCall(tok, "getMe");
      } catch (err) {
        return bad(res, `Telegram បដិសេធ Token: ${err.message}`);
      }
      if (bot.tg_bot_id && me.id !== bot.tg_bot_id) return bad(res, `Token នេះជារបស់ Bot ផ្សេង (@${me.username})`);
      bot.token_enc = encrypt(tok);
      bot.token_hint = maskToken(tok);
      bot.username = me.username;
      bot.tg_bot_id = me.id;
    }
    if (b.is_default) {
      await TelegramBotModel.updateMany({ _id: { $ne: bot._id } }, { is_default: false });
      bot.is_default = true;
    }
    bot.updated_by = req.session.user_id;
    await bot.save();
    await log(req, `Telegram Bot @${bot.username} ត្រូវបានកែប្រែ`);
    ok(res, await TelegramBotModel.findById(bot._id), "បានរក្សាទុក!");
  }));

  prop.app.delete(`${base}/bot/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    if (await TelegramChatModel.exists({ bot_id: req.params.id, deleted: false })) return bad(res, "មិនអាចលុបបានទេ ព្រោះនៅមានក្រុម / Chat ភ្ជាប់ជាមួយ Bot នេះ!");
    const bot = await TelegramBotModel.findOneAndUpdate({ _id: req.params.id, deleted: false }, { deleted: true, updated_by: req.session.user_id });
    if (!bot) return bad(res, "មិនមាន Bot", 404);
    await log(req, `Telegram Bot @${bot.username} ត្រូវបានលុប`);
    ok(res, req.params.id, "Bot ត្រូវបានលុប!");
  }));

  // POST /bot/test/:id → getMe
  prop.app.post(`${base}/bot/test/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const { bot, token } = await tokenOf(req.params.id);
    try {
      const me = await tgCall(token, "getMe");
      bot.last_check_at = new Date();
      bot.last_error = "";
      bot.username = me.username;
      await bot.save();
      ok(res, { username: me.username, name: me.first_name, can_join_groups: me.can_join_groups }, `Bot @${me.username} ដំណើរការល្អ ✅`);
    } catch (err) {
      bot.last_error = err.message;
      await bot.save();
      bad(res, `Bot មិនដំណើរការ: ${err.message}`);
    }
  }));

  // GET /bot/chats/:id → groups / channels / users that wrote to the bot recently ("Find chats")
  prop.app.get(`${base}/bot/chats/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const { token } = await tokenOf(req.params.id);
    let updates;
    try {
      updates = await tgCall(token, "getUpdates", { limit: 100, timeout: 0, allowed_updates: ["message", "channel_post", "my_chat_member"] });
    } catch (err) {
      return bad(res, `មិនអាចអាន Chat បាន: ${err.message}`);
    }
    const found = new Map();
    for (const u of updates || []) {
      const c = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
      if (!c) continue;
      found.set(String(c.id), { chat_id: String(c.id), title: c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id), type: c.type, username: c.username || null });
    }
    const added = new Set((await TelegramChatModel.find({ bot_id: req.params.id, deleted: false }).select("chat_id").lean()).map((c) => c.chat_id));
    const data = [...found.values()].map((c) => ({ ...c, already_added: added.has(c.chat_id) }));
    ok(res, data, data.length ? undefined : "មិនទាន់មាន Chat — បន្ថែម Bot ចូលក្រុម ហើយផ្ញើសារមួយក្នុងក្រុម រួចចុចម្តងទៀត");
  }));

  // ===================================== CHATS ================================================
  const chatPopulate = [{ path: "bot_id", select: "name username status" }, { path: "warehouse_ids", select: "code name_kh name_en" }];
  async function chatFields(b, current) {
    const f = {};
    const botId = b.bot_id?._id || b.bot_id;
    if (!current || b.bot_id !== undefined) {
      if (!isId(botId) || !(await TelegramBotModel.exists({ _id: botId, deleted: false }))) return { error: "សូមជ្រើសរើស Bot" };
      f.bot_id = botId;
    }
    if (!current || b.chat_id !== undefined) {
      const id = String(b.chat_id || "").trim();
      if (!/^-?\d{3,20}$/.test(id) && !/^@\w{4,}$/.test(id)) return { error: "Chat ID មិនត្រឹមត្រូវ (ឧ. -1001234567890 ឬ @channelname)" };
      f.chat_id = id;
    }
    if (!current || b.title !== undefined) {
      f.title = String(b.title || "").trim();
      if (!f.title) return { error: "សូមបញ្ចូលឈ្មោះក្រុម" };
    }
    if (b.type !== undefined) f.type = ["group", "supergroup", "channel", "private"].includes(b.type) ? b.type : "group";
    if (b.language !== undefined) {
      if (!LANGS.includes(b.language)) return { error: "ភាសាមិនត្រឹមត្រូវ (kh | en | both)" };
      f.language = b.language;
    }
    if (b.warehouse_ids !== undefined) f.warehouse_ids = await validWarehouses(b.warehouse_ids.map?.((w) => w?._id || w));
    if (b.event_codes !== undefined) f.event_codes = (Array.isArray(b.event_codes) ? b.event_codes : []).filter((c) => EVENT_CODES.includes(c));
    if (b.status !== undefined) f.status = !!b.status;
    if (b.note !== undefined) f.note = b.note;
    const botFinal = f.bot_id || current?.bot_id;
    const chatFinal = f.chat_id || current?.chat_id;
    if (await TelegramChatModel.exists({ bot_id: botFinal, chat_id: chatFinal, deleted: false, ...(current ? { _id: { $ne: current._id } } : {}) }))
      return { error: "Chat នេះត្រូវបានបន្ថែមជាមួយ Bot នេះរួចហើយ", status: 409 };
    return f;
  }

  prop.app.post(`${base}/chat`, ...guard, wrap(async (req, res) => {
    const f = await chatFields(req.body || {}, null);
    if (f.error) return bad(res, f.error, f.status);
    const chat = await TelegramChatModel.create({ ...f, created_by: req.session.user_id, updated_by: req.session.user_id });
    await log(req, `Telegram Chat ${chat.title} ត្រូវបានបន្ថែម`);
    ok(res, await TelegramChatModel.findById(chat._id).populate(chatPopulate), "Chat ត្រូវបានរក្សាទុក!", 201);
  }));
  prop.app.get(`${base}/chat`, ...guard, wrap(async (req, res) => {
    const extra = isId(req.query.bot_id) ? [{ bot_id: new mongoose.Types.ObjectId(req.query.bot_id) }] : [];
    const { bot_id, ...rest } = req.query;
    const r = await getFilteredMongoDB({ limit: 100, sort: "created_date", order: "asc", ...rest }, TelegramChatModel, chatPopulate, extra);
    res.status(200).json({ success: true, data: r.data, pagination: r.pagination });
  }));
  prop.app.get(`${base}/chat-all`, ...guard, wrap(async (req, res) => ok(res, await TelegramChatModel.find({ deleted: false }).populate(chatPopulate).sort({ title: 1 }))));
  prop.app.put(`${base}/chat/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const current = await TelegramChatModel.findOne({ _id: req.params.id, deleted: false });
    if (!current) return bad(res, "មិនមាន Chat", 404);
    const f = await chatFields(req.body || {}, current);
    if (f.error) return bad(res, f.error, f.status);
    await TelegramChatModel.updateOne({ _id: current._id }, { ...f, updated_by: req.session.user_id });
    await log(req, `Telegram Chat ${current.title} ត្រូវបានកែប្រែ`);
    ok(res, await TelegramChatModel.findById(current._id).populate(chatPopulate), "បានរក្សាទុក!");
  }));
  prop.app.delete(`${base}/chat/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const chat = await TelegramChatModel.findOneAndUpdate({ _id: req.params.id, deleted: false }, { deleted: true, updated_by: req.session.user_id });
    if (!chat) return bad(res, "មិនមាន Chat", 404);
    await TelegramScheduleModel.updateMany({ chat_ids: chat._id }, { $pull: { chat_ids: chat._id } });
    await log(req, `Telegram Chat ${chat.title} ត្រូវបានលុប`);
    ok(res, req.params.id, "Chat ត្រូវបានលុប!");
  }));

  // POST /chat/test/:id → send a test message now (not queued)
  prop.app.post(`${base}/chat/test/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const chat = await TelegramChatModel.findOne({ _id: req.params.id, deleted: false });
    if (!chat) return bad(res, "មិនមាន Chat", 404);
    const { token } = await tokenOf(chat.bot_id);
    const text = pickText(chat.language, `✅ សារសាកល្បងពី Inventory POS\n${timeText()}`, `✅ Test message from Inventory POS\n${timeText()}`);
    try {
      await tgCall(token, "sendMessage", { chat_id: chat.chat_id, text, parse_mode: "HTML" });
      await TelegramMessageModel.create({ bot_id: chat.bot_id, chat_ref: chat._id, chat_id: chat.chat_id, kind: "test", code: "test", text, state: "sent", attempts: 1, sent_at: new Date() });
      await TelegramChatModel.updateOne({ _id: chat._id }, { last_sent_at: new Date() });
      ok(res, true, "សារសាកល្បងត្រូវបានផ្ញើ ✅");
    } catch (err) {
      bad(res, `ផ្ញើមិនបាន: ${err.message} (Bot ត្រូវនៅក្នុងក្រុម និងមានសិទ្ធិផ្ញើសារ)`);
    }
  }));

  // ===================================== TEMPLATES ================================================
  // GET → every event with default + current text (custom = edited)
  prop.app.get(`${base}/template`, ...guard, wrap(async (req, res) => {
    const saved = new Map((await TelegramTemplateModel.find().lean()).map((t) => [t.event_code, t]));
    ok(res, EVENTS.map((e) => {
      const s = saved.get(e.code);
      const placeholders = [...new Set([...(e.kh + e.en).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
      return { code: e.code, group: e.group, phase: e.phase, name_kh: e.name_kh, name_en: e.name_en, default_kh: e.kh, default_en: e.en, template_kh: s?.template_kh || e.kh, template_en: s?.template_en || e.en, custom: !!s, placeholders };
    }));
  }));
  prop.app.put(`${base}/template/:code`, ...guard, wrap(async (req, res) => {
    if (!EVENT_CODES.includes(req.params.code)) return bad(res, "Event មិនត្រឹមត្រូវ");
    const kh = String(req.body?.template_kh || "").trim();
    const en = String(req.body?.template_en || "").trim();
    if (!kh) return bad(res, "សូមបញ្ចូលអត្ថបទ (ខ្មែរ)");
    await TelegramTemplateModel.updateOne({ event_code: req.params.code }, { template_kh: kh.slice(0, 2000), template_en: en.slice(0, 2000), updated_by: req.session.user_id }, { upsert: true });
    ok(res, await templatesOf(req.params.code), "អត្ថបទត្រូវបានរក្សាទុក!");
  }));
  prop.app.delete(`${base}/template/:code`, ...guard, wrap(async (req, res) => {
    await TelegramTemplateModel.deleteOne({ event_code: req.params.code });
    ok(res, await templatesOf(req.params.code), "ត្រឡប់ទៅអត្ថបទដើមវិញ!");
  }));
  // POST /template/preview { template_kh, template_en } → filled with sample data
  prop.app.post(`${base}/template/preview`, ...guard, wrap(async (req, res) => {
    const sample = { doc_no: "TR-2610-0001", from: "WH01", to: "PP01", warehouse: "PP01", lines: 3, qty: 24, user: req.user.firstname || "Admin", supplier: "Mekong Diapers", cost: "$120.00", reason: "ខូចខាត", shortage_qty: 1, shortage_cost: "$7.45", note: "-", count: 5, scope: "default", from_date: timeText(), name: "Nita Ros", action: "បានបង្កើត", time: timeText(), shift_no: "PP01-S0042", opening_cash: "$50", sales_total: "$812.40", invoice_count: 64, difference: "$0.00", kind: "Void", invoice_no: "PP01-000153", total: "$13.50", hours: 6, __raw: { items: "• DIAPANT01-M × 1" } };
    ok(res, { kh: render(req.body?.template_kh, sample), en: render(req.body?.template_en, sample) });
  }));

  // ===================================== REPORT SCHEDULES ================================================
  const schedPopulate = [{ path: "chat_ids", select: "title chat_id language" }, { path: "warehouse_ids", select: "code name_kh name_en" }];
  async function schedFields(b) {
    const f = {};
    if (b.name !== undefined) f.name = String(b.name).trim();
    if (b.chat_ids !== undefined) {
      const ids = (b.chat_ids || []).map((c) => c?._id || c).filter(isId);
      f.chat_ids = (await TelegramChatModel.find({ _id: { $in: ids }, deleted: false }).select("_id").lean()).map((c) => c._id);
      if (!f.chat_ids.length) return { error: "សូមជ្រើសរើស Chat យ៉ាងហោចណាស់ ១" };
    }
    if (b.report_codes !== undefined) {
      f.report_codes = (b.report_codes || []).filter((c) => REPORT_CODES.includes(c));
      if (!f.report_codes.length) return { error: "សូមជ្រើសរើសរបាយការណ៍យ៉ាងហោចណាស់ ១" };
    }
    if (b.times !== undefined) {
      f.times = [...new Set((b.times || []).map((t) => String(t).trim()).filter(Boolean))].sort();
      if (!f.times.length || f.times.some((t) => !TIME.test(t))) return { error: "ម៉ោងមិនត្រឹមត្រូវ (HH:mm ឧ. 08:00)" };
    }
    if (b.days !== undefined) {
      f.days = [...new Set((b.days || []).map(Number).filter((d) => d >= 0 && d <= 6))];
      if (!f.days.length) return { error: "សូមជ្រើសរើសថ្ងៃ" };
    }
    if (b.warehouse_ids !== undefined) f.warehouse_ids = await validWarehouses((b.warehouse_ids || []).map((w) => w?._id || w));
    if (b.status !== undefined) f.status = !!b.status;
    if (b.note !== undefined) f.note = b.note;
    return f;
  }
  prop.app.post(`${base}/schedule`, ...guard, wrap(async (req, res) => {
    const b = { times: ["08:00"], days: [0, 1, 2, 3, 4, 5, 6], ...(req.body || {}) };
    if (!b.chat_ids || !b.report_codes) return bad(res, "សូមជ្រើសរើស Chat និងរបាយការណ៍");
    const f = await schedFields(b);
    if (f.error) return bad(res, f.error);
    const s = await TelegramScheduleModel.create({ ...f, created_by: req.session.user_id, updated_by: req.session.user_id });
    await log(req, `Telegram របាយការណ៍ ${s.name || s.report_codes.join(", ")} ត្រូវបានបង្កើត`);
    ok(res, await TelegramScheduleModel.findById(s._id).populate(schedPopulate), "កាលវិភាគត្រូវបានរក្សាទុក!", 201);
  }));
  prop.app.get(`${base}/schedule`, ...guard, wrap(async (req, res) => ok(res, await TelegramScheduleModel.find({ deleted: false }).populate(schedPopulate).sort({ created_date: 1 }))));
  prop.app.put(`${base}/schedule/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const f = await schedFields(req.body || {});
    if (f.error) return bad(res, f.error);
    const s = await TelegramScheduleModel.findOneAndUpdate({ _id: req.params.id, deleted: false }, { ...f, updated_by: req.session.user_id }, { returnDocument: "after" }).populate(schedPopulate);
    if (!s) return bad(res, "មិនមានកាលវិភាគ", 404);
    ok(res, s, "បានរក្សាទុក!");
  }));
  prop.app.delete(`${base}/schedule/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const s = await TelegramScheduleModel.findOneAndUpdate({ _id: req.params.id, deleted: false }, { deleted: true, updated_by: req.session.user_id });
    if (!s) return bad(res, "មិនមានកាលវិភាគ", 404);
    ok(res, req.params.id, "កាលវិភាគត្រូវបានលុប!");
  }));
  // POST /schedule/send/:id → "Send now"
  prop.app.post(`${base}/schedule/send/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const s = await TelegramScheduleModel.findOne({ _id: req.params.id, deleted: false });
    if (!s) return bad(res, "មិនមានកាលវិភាគ", 404);
    const queued = await queueSchedule(s);
    const r = await sendPending(50);
    ok(res, { queued, sent: r.sent }, `បានផ្ញើ ${r.sent} / ${queued}`);
  }));
  // GET /report/preview?code=&warehouse_ids=a,b&language=&category_id=&days=&limit= → the text a report would send now
  prop.app.get(`${base}/report/preview`, ...sendGuard, wrap(async (req, res) => {
    if (!REPORT_CODES.includes(req.query.code)) return bad(res, "របាយការណ៍មិនត្រឹមត្រូវ");
    const ids = String(req.query.warehouse_ids || "").split(",").filter(isId);
    const r = await buildReport(req.query.code, ids, { category_id: isId(req.query.category_id) ? req.query.category_id : null, limit: req.query.limit, days: req.query.days });
    ok(res, { text: pickText(LANGS.includes(req.query.language) ? req.query.language : "both", r.kh, r.en) });
  }));

  // ===================================== ONE-CLICK SEND (admin, central manager) ================================================
  // GET /targets → active chats (with an active bot) for the "Send to Telegram" box + report list
  prop.app.get(`${base}/targets`, ...sendGuard, wrap(async (req, res) => {
    const bots = await TelegramBotModel.find({ deleted: false, status: true }).select("_id username").lean();
    const botMap = new Map(bots.map((b) => [String(b._id), b.username]));
    const chats = await TelegramChatModel.find({ deleted: false, status: true, bot_id: { $in: bots.map((b) => b._id) } })
      .select("title type language warehouse_ids bot_id")
      .populate("warehouse_ids", "code")
      .sort({ title: 1 })
      .lean();
    ok(res, { chats: chats.map((c) => ({ _id: c._id, title: c.title, type: c.type, language: c.language, warehouses: (c.warehouse_ids || []).map((w) => w.code), bot: botMap.get(String(c.bot_id)) })), reports: REPORTS });
  }));

  // POST /send { chat_ids, report_codes: [], warehouse_ids: [] ([] = each chat's), category_id?, days? (near expiry), limit? (default 50), text? (own message) }
  //   → queued + sent right away → { queued, sent, failed }
  prop.app.post(`${base}/send`, ...sendGuard, wrap(async (req, res) => {
    const b = req.body || {};
    const chatIds = (Array.isArray(b.chat_ids) ? b.chat_ids : []).filter(isId);
    const chats = await TelegramChatModel.find({ _id: { $in: chatIds }, deleted: false, status: true }).lean();
    const activeBots = new Set((await TelegramBotModel.find({ _id: { $in: chats.map((c) => c.bot_id) }, deleted: false, status: true }).select("_id").lean()).map((x) => String(x._id)));
    const targets = chats.filter((c) => activeBots.has(String(c.bot_id)));
    if (!targets.length) return bad(res, "សូមជ្រើសរើសក្រុម Telegram យ៉ាងហោចណាស់ ១");
    const codes = (Array.isArray(b.report_codes) ? b.report_codes : []).filter((c) => REPORT_CODES.includes(c));
    const text = String(b.text || "").trim().slice(0, 3500);
    if (!codes.length && !text) return bad(res, "សូមជ្រើសរើសរបាយការណ៍ ឬសរសេរសារ");
    const whIds = await validWarehouses(b.warehouse_ids);
    const opts = { category_id: isId(b.category_id) ? b.category_id : null, limit: b.limit || 50, days: b.days };
    const sender = [req.user.firstname, req.user.lastname].filter(Boolean).join(" ") || req.user.email;
    const cache = new Map(); // same report + warehouses → build once
    let queued = 0;
    for (const chat of targets) {
      const ids = whIds.length ? whIds : chat.warehouse_ids || [];
      if (text) queued += await queueText(chat, { kind: "message", code: "message", text: `✉️ ${esc(text)}\n— <i>${esc(sender)}</i>` });
      for (const code of codes) {
        const key = `${code}|${ids.map(String).sort().join(",")}`;
        if (!cache.has(key)) cache.set(key, await buildReport(code, ids, opts));
        const r = cache.get(key);
        queued += await queueText(chat, { kind: "report", code, text: `${pickText(chat.language, r.kh, r.en)}\n— <i>${esc(sender)}</i>`, warehouse_id: ids[0] || null });
      }
    }
    const r = await sendPending(Math.max(queued, 1) + 10);
    await logActivity({ title: `ផ្ញើទៅ Telegram: ${[...codes, text ? "សារ" : null].filter(Boolean).join(", ")} → ${targets.map((c) => c.title).join(", ")}`, description: `គណនី: ${req.user.email}`, categoryTitle: "setting", createdBy: req.session.user_id, req });
    const failed = queued - r.sent;
    ok(res, { queued, sent: r.sent, failed }, failed > 0 ? `បានផ្ញើ ${r.sent} / ${queued} — សារខ្លះនឹងព្យាយាមម្តងទៀត (មើល «សារដែលបានផ្ញើ»)` : `បានផ្ញើ ${r.sent} សារទៅ Telegram ✅`);
  }));

  // ===================================== MESSAGE LOG ================================================
  // ?state=pending|sent|failed&code=&chat_ref=
  prop.app.get(`${base}/message`, ...guard, wrap(async (req, res) => {
    const { state, code, chat_ref, ...rest } = req.query;
    const extra = [];
    if (state) extra.push({ state });
    if (code) extra.push({ code });
    if (isId(chat_ref)) extra.push({ chat_ref: new mongoose.Types.ObjectId(chat_ref) });
    const r = await getFilteredMongoDB({ sort: "created_date", order: "desc", ...rest, includeDeleted: "true" }, TelegramMessageModel, [{ path: "chat_ref", select: "title" }, { path: "bot_id", select: "username" }], extra);
    const counts = Object.fromEntries((await TelegramMessageModel.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }])).map((c) => [c._id, c.n]));
    res.status(200).json({ success: true, data: r.data, pagination: r.pagination, counts });
  }));
  // PUT /message/retry/:id → back to the queue
  prop.app.put(`${base}/message/retry/:id`, ...guard, wrap(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, noIDFound);
    const m = await TelegramMessageModel.findOneAndUpdate({ _id: req.params.id, state: { $ne: "sent" } }, { state: "pending", next_try_at: new Date(), attempts: 0 }, { returnDocument: "after" });
    if (!m) return bad(res, "សារនេះបានផ្ញើរួចហើយ ឬមិនមាន", 404);
    await sendPending(10);
    ok(res, await TelegramMessageModel.findById(m._id), "បានព្យាយាមផ្ញើម្តងទៀត");
  }));
};

module.exports = route;
