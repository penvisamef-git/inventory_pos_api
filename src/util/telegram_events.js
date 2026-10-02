// Fixed list of Telegram events (like activity_log_type.js). A chat ticks which events it receives.
// Templates: {placeholders} filled from the event data; HTML (<b>, <i>) allowed. Admin can edit the text (TelegramTemplate).
// phase: when the event starts firing (3 = needs the POS).
const EVENTS = [
  // ---------- stock ----------
  { code: "transfer_requested", group: "stock", phase: 2, name_kh: "ហាងស្នើសុំស្តុក", name_en: "Shop requests stock",
    kh: "📝 <b>{to}</b> ស្នើសុំស្តុកពី {from}\n{doc_no} · {lines} មុខ\nដោយ {user}",
    en: "📝 <b>{to}</b> requests stock from {from}\n{doc_no} · {lines} item(s)\nby {user}" },
  { code: "transfer_dispatched", group: "stock", phase: 2, name_kh: "បញ្ជូនស្តុក", name_en: "Transfer dispatched",
    kh: "🚚 <b>{doc_no}</b> {from} → {to}\n{lines} មុខ · {qty} ឯកតា កំពុងដឹក\nដោយ {user}",
    en: "🚚 <b>{doc_no}</b> {from} → {to}\n{lines} item(s) · {qty} units on the way\nby {user}" },
  { code: "transfer_received", group: "stock", phase: 2, name_kh: "ទទួលស្តុកផ្ទេរ", name_en: "Transfer received",
    kh: "✅ <b>{to}</b> បានទទួល {doc_no} ពី {from}\n{lines} មុខ · {qty} ឯកតា\nដោយ {user}",
    en: "✅ <b>{to}</b> received {doc_no} from {from}\n{lines} item(s) · {qty} units\nby {user}" },
  { code: "transfer_shortage", group: "stock", phase: 2, name_kh: "ខ្វះពេលទទួលស្តុក", name_en: "Transfer shortage",
    kh: "⚠️ <b>ខ្វះស្តុក</b> {doc_no} {from} → {to}\nខ្វះ {shortage_qty} ឯកតា (ខាត {shortage_cost})\n{items}\nកំណត់សម្គាល់: {note}",
    en: "⚠️ <b>Shortage</b> {doc_no} {from} → {to}\n{shortage_qty} unit(s) missing (loss {shortage_cost})\n{items}\nNote: {note}" },
  { code: "adjustment_waiting", group: "stock", phase: 2, name_kh: "កែតម្រូវរង់ចាំអនុម័ត", name_en: "Adjustment waiting for approval",
    kh: "🗂 <b>{warehouse}</b> {reason} — រង់ចាំអនុម័ត\n{doc_no}\n{items}\nដោយ {user}",
    en: "🗂 <b>{warehouse}</b> {reason} — waiting for approval\n{doc_no}\n{items}\nby {user}" },
  { code: "adjustment_posted", group: "stock", phase: 2, name_kh: "កែតម្រូវស្តុកត្រូវបាន Post", name_en: "Adjustment posted",
    kh: "🗂 <b>{warehouse}</b> {reason} {doc_no} ត្រូវបាន Post\n{items}\nតម្លៃ {cost} · ដោយ {user}",
    en: "🗂 <b>{warehouse}</b> {reason} {doc_no} posted\n{items}\nValue {cost} · by {user}" },
  { code: "goods_received", group: "stock", phase: 2, name_kh: "ទទួលទំនិញពីអ្នកផ្គត់ផ្គង់", name_en: "Goods received",
    kh: "📦 <b>{doc_no}</b> {supplier} → {warehouse}\n{lines} មុខ · {qty} ឯកតា · {cost}\nដោយ {user}",
    en: "📦 <b>{doc_no}</b> {supplier} → {warehouse}\n{lines} item(s) · {qty} units · {cost}\nby {user}" },
  // ---------- product / staff ----------
  { code: "price_changed", group: "product", phase: 1, name_kh: "ប្តូរតម្លៃលក់", name_en: "Price changed",
    kh: "💲 តម្លៃលក់ថ្មី {count} ({scope}) ចាប់ពី {from_date}\n{items}\nដោយ {user}",
    en: "💲 {count} new sale price(s) ({scope}) from {from_date}\n{items}\nby {user}" },
  { code: "staff_changed", group: "staff", phase: 2, name_kh: "បុគ្គលិក (អ្នកគិតលុយ)", name_en: "Staff (cashiers)",
    kh: "👤 <b>{warehouse}</b> {action}: {name}\nដោយ {user}",
    en: "👤 <b>{warehouse}</b> {action}: {name}\nby {user}" },
  // ---------- POS (Phase 3) ----------
  { code: "pos_login", group: "pos", phase: 3, name_kh: "ចូល / ចេញ POS (វត្តមាន)", name_en: "POS login / logout (attendance)",
    kh: "🕘 <b>{warehouse}</b> {name} {action} POS · {time}", en: "🕘 <b>{warehouse}</b> {name} {action} the POS · {time}" },
  { code: "shift_open", group: "pos", phase: 3, name_kh: "បើកវេន", name_en: "Shift opened",
    kh: "🟢 <b>{warehouse}</b> {name} បើកវេន {shift_no}\nសាច់ប្រាក់ដើម {opening_cash}", en: "🟢 <b>{warehouse}</b> {name} opened shift {shift_no}\nOpening cash {opening_cash}" },
  { code: "shift_close", group: "pos", phase: 3, name_kh: "បិទវេន", name_en: "Shift closed",
    kh: "🔴 <b>{warehouse}</b> {name} បិទវេន {shift_no}\nលក់ {sales_total} · {invoice_count} វិក្កយបត្រ\nលម្អៀងសាច់ប្រាក់ {difference}", en: "🔴 <b>{warehouse}</b> {name} closed shift {shift_no}\nSales {sales_total} · {invoice_count} invoices\nCash difference {difference}" },
  { code: "invoice_void", group: "pos", phase: 3, name_kh: "លុប / ប្រគល់វិក្កយបត្រ", name_en: "Void / refund",
    kh: "↩️ <b>{warehouse}</b> {kind} {invoice_no} · {total}\n{items}\nដោយ {name} · អនុម័ត {approved_by}\nមូលហេតុ: {reason}", en: "↩️ <b>{warehouse}</b> {kind} {invoice_no} · {total}\n{items}\nby {name} · approved by {approved_by}\nreason: {reason}" },
  { code: "pos_sale", group: "pos", phase: 3, name_kh: "វិក្កយបត្រថ្មី (រាល់ការលក់)", name_en: "New sale (every invoice)",
    kh: "🧾 <b>{warehouse}</b> {invoice_no} · <b>{total}</b>\n{items}\n{payment} · {name}{flags}", en: "🧾 <b>{warehouse}</b> {invoice_no} · <b>{total}</b>\n{items}\n{payment} · {name}{flags}" },
  { code: "pos_offline", group: "pos", phase: 3, name_kh: "POS មិនបាន Sync យូរ", name_en: "POS not synced", kh: "📡 <b>{warehouse}</b> POS មិនបាន Sync {hours} ម៉ោង", en: "📡 <b>{warehouse}</b> POS has not synced for {hours} h" },
];

// Reports a chat can get on a schedule (any times / days) or with "Send now"
const REPORTS = [
  { code: "stock_summary", phase: 2, name_kh: "សង្ខេបស្តុក", name_en: "Stock summary" },
  { code: "low_stock", phase: 2, name_kh: "ស្តុកទាប", name_en: "Low stock" },
  { code: "near_expiry", phase: 2, name_kh: "ជិតផុតកំណត់", name_en: "Near expiry" },
  { code: "pending_work", phase: 2, name_kh: "ការងាររង់ចាំ (ផ្ទេរ / កែតម្រូវ)", name_en: "Pending work (transfers / adjustments)" },
  { code: "daily_sales", phase: 3, name_kh: "ការលក់ប្រចាំថ្ងៃ", name_en: "Daily sales" },
  { code: "attendance", phase: 3, name_kh: "វត្តមាន (ចូល / ចេញ POS)", name_en: "Attendance (POS login / logout)" },
];

const EVENT_CODES = EVENTS.map((e) => e.code);
const REPORT_CODES = REPORTS.map((r) => r.code);
module.exports = { EVENTS, REPORTS, EVENT_CODES, REPORT_CODES };
