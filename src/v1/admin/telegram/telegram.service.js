const { TelegramBotModel, TelegramChatModel, TelegramTemplateModel, TelegramScheduleModel, TelegramMessageModel } = require("./telegram.model");
const WarehouseModel = require("../setup/warehouse/warehouse.model");
const { EVENTS, REPORTS } = require("../../../util/telegram_events");
const { decrypt } = require("../../../util/crypto");

const MAX_ATTEMPTS = 6;
const TZ = "Asia/Phnom_Penh";
const apiBase = () => process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

// ---------------- Telegram Bot API ----------------
// → result | throws Error(description)
async function tgCall(token, method, params = {}) {
  const res = await fetch(`${apiBase()}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const err = new Error(json.description || `Telegram HTTP ${res.status}`);
    err.retryAfter = json.parameters?.retry_after;
    err.permanent = res.status === 400 || res.status === 403 || res.status === 401; // chat not found, bot kicked, bad token
    throw err;
  }
  return json.result;
}

async function tokenOf(botId) {
  const bot = await TelegramBotModel.findById(botId).select("+token_enc");
  if (!bot) throw new Error("bot not found");
  return { bot, token: decrypt(bot.token_enc) };
}

// ---------------- text ----------------
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// "{a} {b}" — values are HTML-escaped; missing → "-"; values in data.__raw are inserted as-is (already built HTML)
function render(template, data = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, k) => {
    if (data.__raw && data.__raw[k] !== undefined) return data.__raw[k];
    const v = data[k];
    return v === undefined || v === null || v === "" ? "-" : esc(v);
  });
}

async function templatesOf(code) {
  const def = EVENTS.find((e) => e.code === code);
  const saved = await TelegramTemplateModel.findOne({ event_code: code }).lean();
  return { kh: saved?.template_kh || def?.kh || code, en: saved?.template_en || def?.en || code };
}

// language: kh | en | both → final text
function pickText(lang, kh, en) {
  if (lang === "kh") return kh;
  if (lang === "en") return en;
  return kh === en ? kh : `${kh}\n\n${en}`;
}

const timeText = (d = new Date()) =>
  new Date(d).toLocaleString("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

// ---------------- events ----------------
/**
 * Queue an event for every active chat that ticked it and covers one of the warehouses.
 *   notify("transfer_dispatched", { warehouse_ids: [from, to], data: { doc_no, … }, ref: { type, id } })
 * Never throws (Telegram must never block a stock action).
 */
async function notify(code, { warehouse_ids = [], data = {}, ref = null, happened_at = new Date() } = {}) {
  try {
    const whIds = warehouse_ids.filter(Boolean).map(String);
    const chats = await TelegramChatModel.find({ deleted: false, status: true, event_codes: code }).lean();
    const matching = chats.filter((c) => !c.warehouse_ids?.length || !whIds.length || c.warehouse_ids.some((w) => whIds.includes(String(w))));
    if (!matching.length) return 0;
    const activeBots = new Set((await TelegramBotModel.find({ _id: { $in: matching.map((c) => c.bot_id) }, deleted: false, status: true }).select("_id").lean()).map((b) => String(b._id)));
    const t = await templatesOf(code);
    const kh = render(t.kh, data);
    const en = render(t.en, { ...data, ...(data.__en || {}) });
    const rows = matching
      .filter((c) => activeBots.has(String(c.bot_id)))
      .map((c) => ({
        bot_id: c.bot_id,
        chat_ref: c._id,
        chat_id: c.chat_id,
        kind: "event",
        code,
        text: pickText(c.language, kh, en),
        warehouse_id: whIds[0] || null,
        ref_type: ref?.type || null,
        ref_id: ref?.id || null,
        happened_at,
      }));
    if (rows.length) await TelegramMessageModel.insertMany(rows);
    return rows.length;
  } catch (err) {
    console.error("telegram notify failed:", err.message);
    return 0;
  }
}

// ---------------- sender (worker) ----------------
// Send due messages (oldest first). Failure → retry with back-off (30s, 1m, 2m, 4m …), max 6 tries; 400/403 → failed at once.
async function sendPending(limit = 20) {
  const due = await TelegramMessageModel.find({ state: "pending", next_try_at: { $lte: new Date() } }).sort({ created_date: 1 }).limit(limit);
  let sent = 0;
  const tokens = new Map();
  for (const m of due) {
    m.attempts += 1;
    try {
      if (!tokens.has(String(m.bot_id))) tokens.set(String(m.bot_id), (await tokenOf(m.bot_id)).token);
      const r = await tgCall(tokens.get(String(m.bot_id)), "sendMessage", { chat_id: m.chat_id, text: m.text.slice(0, 4096), parse_mode: "HTML", disable_web_page_preview: true });
      m.state = "sent";
      m.sent_at = new Date();
      m.tg_message_id = r?.message_id || null;
      m.last_error = "";
      sent += 1;
      if (m.chat_ref) await TelegramChatModel.updateOne({ _id: m.chat_ref }, { last_sent_at: m.sent_at });
    } catch (err) {
      m.last_error = String(err.message || err).slice(0, 300);
      if (err.permanent || m.attempts >= MAX_ATTEMPTS) m.state = "failed";
      else m.next_try_at = new Date(Date.now() + (err.retryAfter ? err.retryAfter * 1000 : 30000 * 2 ** (m.attempts - 1)));
    }
    await m.save();
  }
  return { due: due.length, sent };
}

// ---------------- reports ----------------
const REPORT_TITLE = Object.fromEntries(REPORTS.map((r) => [r.code, r]));

// opts: { limit (lines per warehouse, default 15), category_id (stock reports: that category + sub-categories), days (near expiry; default = setting) }
async function buildReport(code, warehouseIds, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 15, 1), 100);
  const { StockBalanceModel, StockBatchBalanceModel } = require("../stock/balance.model");
  const VariantModel = require("../product/item/variant.model");
  const ProductModel = require("../product/item/product.model");
  const TransferModel = require("../stock/transfer/transfer.model");
  const StockAdjustmentModel = require("../stock/adjustment/adjustment.model");
  const SettingModel = require("../setup/setting/setting.model");
  const whFilter = { deleted: false, ...(warehouseIds?.length ? { _id: { $in: warehouseIds } } : {}) };
  const whs = await WarehouseModel.find(whFilter).sort({ sort_order: 1 }).lean();
  const now = new Date();
  const head = (kh, en) => ({ kh: `📊 <b>${kh}</b> · ${timeText(now)}`, en: `📊 <b>${en}</b> · ${timeText(now)}` });
  const t = REPORT_TITLE[code];
  const out = head(t?.name_kh || code, t?.name_en || code);
  const add = (kh, en = kh) => {
    out.kh += `\n${kh}`;
    out.en += `\n${en}`;
  };

  if (code === "stock_summary" || code === "low_stock") {
    const pFilter = { deleted: false, track_stock: { $ne: false } };
    if (opts.category_id) {
      const { categoryWithChildren } = require("../product/item/product.service");
      pFilter.category_id = { $in: await categoryWithChildren(opts.category_id) };
    }
    const products = await ProductModel.find(pFilter).select("min_stock").lean();
    const pMin = new Map(products.map((p) => [String(p._id), p.min_stock || 0]));
    const variants = await VariantModel.find({ deleted: false, status: true, product_id: { $in: products.map((p) => p._id) } }).select("code name_kh name_en min_stock product_id").lean();
    for (const w of whs) {
      const bals = new Map((await StockBalanceModel.find({ warehouse_id: w._id }).lean()).map((b) => [String(b.variant_id), b.qty]));
      const rows = variants.map((v) => ({ sku: v.code, kh: v.name_kh, en: v.name_en || v.name_kh, qty: bals.get(String(v._id)) || 0, min: v.min_stock ?? pMin.get(String(v.product_id)) ?? 0, carried: bals.has(String(v._id)) }));
      const low = rows.filter((r) => r.carried && r.min > 0 && r.qty <= r.min).sort((a, b) => a.qty / a.min - b.qty / b.min);
      if (code === "stock_summary") {
        const inStock = rows.filter((r) => r.qty > 0);
        add(`\n<b>${esc(w.code)}</b> ${esc(w.name_kh)}: ${inStock.length} មុខ · ${inStock.reduce((t2, r) => t2 + r.qty, 0)} ឯកតា · ស្តុកទាប ${low.length}`,
          `\n<b>${esc(w.code)}</b> ${esc(w.name_en || w.name_kh)}: ${inStock.length} items · ${inStock.reduce((t2, r) => t2 + r.qty, 0)} units · low ${low.length}`);
      } else if (low.length) {
        add(`\n<b>${esc(w.code)}</b> (${low.length})`, `\n<b>${esc(w.code)}</b> (${low.length})`);
        low.slice(0, limit).forEach((r) => add(`• ${esc(r.kh)} <code>${esc(r.sku)}</code>: <b>${r.qty}</b> / ${r.min}`, `• ${esc(r.en)} <code>${esc(r.sku)}</code>: <b>${r.qty}</b> / ${r.min}`));
        if (low.length > limit) add(`… +${low.length - limit}`);
      }
    }
    if (code === "low_stock" && !out.kh.includes("•")) add("\n✅ គ្មានស្តុកទាប", "\n✅ Nothing is low");
  }

  if (code === "near_expiry") {
    const setting = await SettingModel.getMain();
    const days = Math.min(Number(opts.days) || setting?.expiry_alert_days || 30, 730);
    const rows = await StockBatchBalanceModel.find({ warehouse_id: { $in: whs.map((w) => w._id) }, qty: { $gt: 0 }, expiry_date: { $ne: null, $lte: new Date(now.getTime() + days * 86400000) } })
      .sort({ expiry_date: 1 })
      .limit(limit * Math.max(whs.length, 1))
      .populate([{ path: "variant_id", select: "code name_kh name_en" }, { path: "batch_id", select: "batch_no" }, { path: "warehouse_id", select: "code" }])
      .lean();
    if (!rows.length) add(`\n✅ គ្មាន Batch ផុតកំណត់ក្នុង ${days} ថ្ងៃ`, `\n✅ No batch expires within ${days} days`);
    rows.forEach((r) => {
      const left = Math.ceil((new Date(r.expiry_date) - now) / 86400000);
      const v = r.variant_id || {};
      add(`• <b>${esc(r.warehouse_id?.code)}</b> ${esc(v.name_kh || v.code)} <code>${esc(v.code)}</code> [${esc(r.batch_id?.batch_no)}] ${r.qty} · ${left <= 0 ? "ផុតកំណត់ហើយ" : `${left} ថ្ងៃ`}`,
        `• <b>${esc(r.warehouse_id?.code)}</b> ${esc(v.name_en || v.name_kh || v.code)} <code>${esc(v.code)}</code> [${esc(r.batch_id?.batch_no)}] ${r.qty} · ${left <= 0 ? "expired" : `${left} d`}`);
    });
  }

  if (code === "pending_work") {
    const ids = whs.map((w) => w._id);
    const [transit, requested, adj] = await Promise.all([
      TransferModel.find({ to_warehouse_id: { $in: ids }, state: "dispatched" }).populate("warehouse_id to_warehouse_id", "code").lean(),
      TransferModel.find({ to_warehouse_id: { $in: ids }, state: "requested" }).populate("to_warehouse_id", "code").lean(),
      StockAdjustmentModel.find({ warehouse_id: { $in: ids }, state: "draft" }).populate("warehouse_id", "code").lean(),
    ]);
    add(`\n🚚 កំពុងដឹក: ${transit.length}`, `\n🚚 In transit: ${transit.length}`);
    transit.forEach((t2) => add(`• ${t2.doc_no} ${t2.warehouse_id?.code} → ${t2.to_warehouse_id?.code}`));
    add(`📝 សំណើរង់ចាំ: ${requested.length}`, `📝 Requests waiting: ${requested.length}`);
    requested.forEach((t2) => add(`• ${t2.doc_no} → ${t2.to_warehouse_id?.code}`));
    add(`🗂 កែតម្រូវរង់ចាំអនុម័ត: ${adj.length}`, `🗂 Adjustments waiting: ${adj.length}`);
    adj.forEach((a) => add(`• ${a.doc_no} ${a.warehouse_id?.code}`));
  }

  // ---------- POS: today's sales / attendance (Phnom Penh day) ----------
  if (code === "daily_sales" || code === "attendance") {
    const { SaleModel, RefundModel, PosAttendanceModel } = require("../pos/pos.model");
    const ymd = new Date(now.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
    const from = new Date(`${ymd}T00:00:00+07:00`);
    const shops = whs.filter((w) => w.type !== "central");
    const money = (v) => `$${Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (code === "daily_sales") {
      const match = { warehouse_id: { $in: shops.map((w) => w._id) }, state: "paid", sold_at: { $gte: from, $lte: now } };
      const [bySale, byRefund, byMethod, top] = await Promise.all([
        SaleModel.aggregate([{ $match: match }, { $group: { _id: "$warehouse_id", count: { $sum: 1 }, total: { $sum: "$total" }, discount: { $sum: "$discount_total" } } }]),
        RefundModel.aggregate([{ $match: { warehouse_id: match.warehouse_id, refunded_at: match.sold_at } }, { $group: { _id: "$warehouse_id", count: { $sum: 1 }, total: { $sum: "$total" } } }]),
        SaleModel.aggregate([{ $match: match }, { $unwind: "$payments" }, { $group: { _id: { w: "$warehouse_id", m: "$payments.name_en" }, usd: { $sum: "$payments.amount_usd" } } }]),
        SaleModel.aggregate([{ $match: match }, { $unwind: "$items" }, { $group: { _id: { w: "$warehouse_id", v: "$items.variant_id" }, name: { $first: "$items.name_kh" }, sku: { $first: "$items.sku" }, qty: { $sum: "$items.qty" }, total: { $sum: "$items.line_total" } } }, { $sort: { total: -1 } }]),
      ]);
      let all = 0;
      let allNet = 0;
      for (const w of shops) {
        const s = bySale.find((x) => String(x._id) === String(w._id)) || { count: 0, total: 0, discount: 0 };
        const r = byRefund.find((x) => String(x._id) === String(w._id)) || { count: 0, total: 0 };
        all += s.total;
        allNet += s.total - r.total;
        add(`\n<b>${esc(w.code)}</b> ${esc(w.name_kh)}: <b>${money(s.total)}</b> · ${s.count} វិក្កយបត្រ`, `\n<b>${esc(w.code)}</b> ${esc(w.name_en || w.name_kh)}: <b>${money(s.total)}</b> · ${s.count} invoices`);
        if (!s.count) continue;
        add(`មធ្យម ${money(s.total / s.count)}${s.discount ? ` · បញ្ចុះ ${money(s.discount)}` : ""}${r.count ? ` · សង ${r.count} (−${money(r.total)}) · សុទ្ធ ${money(s.total - r.total)}` : ""}`,
          `avg ${money(s.total / s.count)}${s.discount ? ` · discounts ${money(s.discount)}` : ""}${r.count ? ` · refunds ${r.count} (−${money(r.total)}) · net ${money(s.total - r.total)}` : ""}`);
        const ms = byMethod.filter((x) => String(x._id.w) === String(w._id)).sort((a, b) => b.usd - a.usd);
        if (ms.length) add(ms.map((m) => `${esc(m._id.m)} ${money(m.usd)}`).join(" · "));
        top.filter((x) => String(x._id.w) === String(w._id)).slice(0, Math.min(limit, 5)).forEach((i) => add(`• ${esc(i.name || i.sku)} × ${i.qty} · ${money(i.total)}`));
      }
      if (shops.length > 1) add(`\nសរុប: <b>${money(all)}</b> · សុទ្ធ ${money(allNet)}`, `\nAll shops: <b>${money(all)}</b> · net ${money(allNet)}`);
    } else {
      const rows = await PosAttendanceModel.find({ warehouse_id: { $in: shops.map((w) => w._id) }, at: { $gte: from, $lte: now } }).sort({ at: 1 }).lean();
      const hm = (d) => new Date(d).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
      for (const w of shops) {
        const mine = rows.filter((r) => String(r.warehouse_id) === String(w._id));
        add(`\n<b>${esc(w.code)}</b> ${esc(w.name_kh)}`, `\n<b>${esc(w.code)}</b> ${esc(w.name_en || w.name_kh)}`);
        if (!mine.length) add("គ្មានអ្នកចូល POS ថ្ងៃនេះ", "Nobody logged in today");
        const people = [...new Set(mine.map((r) => r.name))];
        people.forEach((p) => {
          const ins = mine.filter((r) => r.name === p && r.action === "login");
          const outs = mine.filter((r) => r.name === p && r.action === "logout");
          add(`• ${esc(p)}: ចូល ${ins.length ? hm(ins[0].at) : "-"} · ចេញ ${outs.length ? hm(outs[outs.length - 1].at) : "នៅធ្វើការ"}`, `• ${esc(p)}: in ${ins.length ? hm(ins[0].at) : "-"} · out ${outs.length ? hm(outs[outs.length - 1].at) : "still working"}`);
        });
      }
    }
  }
  return out;
}

// Telegram allows 4096 characters per message → split on line breaks (never inside a line / tag)
function splitText(text, max = 3800) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > max) {
      parts.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur) parts.push(cur);
  return parts;
}

// queue one text for one chat (split when long) → number of messages
async function queueText(chat, { kind, code, text, warehouse_id = null }) {
  const parts = splitText(text);
  await TelegramMessageModel.insertMany(
    parts.map((t, i) => ({ bot_id: chat.bot_id, chat_ref: chat._id, chat_id: chat.chat_id, kind, code, text: parts.length > 1 ? `${t}\n<i>(${i + 1}/${parts.length})</i>` : t, warehouse_id })),
  );
  return parts.length;
}

// queue a schedule's reports for its chats (also "Send now")
async function queueSchedule(schedule) {
  const chats = await TelegramChatModel.find({ _id: { $in: schedule.chat_ids }, deleted: false, status: true }).lean();
  let n = 0;
  for (const chat of chats) {
    const whIds = schedule.warehouse_ids?.length ? schedule.warehouse_ids : chat.warehouse_ids || [];
    for (const code of schedule.report_codes) {
      const r = await buildReport(code, whIds);
      n += await queueText(chat, { kind: "report", code, text: pickText(chat.language, r.kh, r.en), warehouse_id: whIds[0] || null });
    }
  }
  return n;
}

// every minute: schedules whose time (Cambodia) and weekday match now
async function runSchedules(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hhmm = `${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  const key = `${p.year}-${p.month}-${p.day} ${hhmm}`;
  const due = await TelegramScheduleModel.find({ deleted: false, status: true, times: hhmm, days: day, last_run_key: { $ne: key } });
  let queued = 0;
  for (const s of due) {
    s.last_run_key = key;
    s.last_run_at = now;
    await s.save();
    queued += await queueSchedule(s);
  }
  return { due: due.length, queued };
}

// Background worker (started by index.js when the server runs): send every 10 s, schedules every minute
let timers = null;
function startWorker() {
  if (timers || process.env.TELEGRAM_WORKER === "off") return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await sendPending();
    } catch (err) {
      console.error("telegram send:", err.message);
    } finally {
      busy = false;
    }
  };
  // a POS that has not called the cloud for POS_OFFLINE_HOURS (default 2) during shop hours (8:00–21:00) → one alert
  const offlineCheck = async () => {
    const hour = Number(new Date().toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }));
    if (hour < 8 || hour >= 21) return;
    const { PosDeviceModel } = require("../pos/pos.model");
    const hooks = require("./telegram.hooks");
    const hours = Number(process.env.POS_OFFLINE_HOURS || 2);
    const devs = await PosDeviceModel.find({ deleted: false, status: true, paired_at: { $ne: null }, offline_alerted_at: null, last_seen_at: { $lt: new Date(Date.now() - hours * 3600e3) } }).lean();
    for (const d of devs) {
      hooks.posOffline(d, Math.floor((Date.now() - new Date(d.last_seen_at)) / 3600e3));
      await PosDeviceModel.updateOne({ _id: d._id }, { offline_alerted_at: new Date() });
    }
  };
  timers = [
    setInterval(() => offlineCheck().catch((err) => console.error("telegram pos offline:", err.message)), 10 * 60000),
    setInterval(tick, 10000),
    setInterval(() => runSchedules().catch((err) => console.error("telegram schedule:", err.message)), 60000),
  ];
  console.log("📨 Telegram worker started");
}

module.exports = { tgCall, tokenOf, render, esc, templatesOf, pickText, notify, sendPending, buildReport, splitText, queueText, queueSchedule, runSchedules, startWorker, timeText };
