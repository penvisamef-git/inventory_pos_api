const mongoose = require("mongoose");
const { defaultFields, schemaOptions } = require("../../../util/default_fields");
const { EVENT_CODES, REPORT_CODES } = require("../../../util/telegram_events");

const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model });
const LANGS = ["kh", "en", "both"];

// Bot from @BotFather. token_enc is AES-GCM encrypted and never returned by the API.
const botSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, default: "" }, // from getMe
    tg_bot_id: { type: Number, default: null },
    token_enc: { type: String, required: true, select: false },
    token_hint: { type: String, default: "" }, // 123456:AAE••••xyz
    is_default: { type: Boolean, default: false },
    last_update_id: { type: Number, default: 0 }, // getUpdates offset ("Find chats")
    last_check_at: { type: Date, default: null },
    last_error: { type: String, default: "" },
    ...defaultFields,
  },
  schemaOptions,
);

// Group / supergroup / channel / private chat that receives messages from ONE bot
const chatSchema = new mongoose.Schema(
  {
    bot_id: { ...ref("TelegramBot"), required: true },
    chat_id: { type: String, required: true, trim: true }, // -1001234567890
    title: { type: String, required: true, trim: true },
    type: { type: String, enum: ["group", "supergroup", "channel", "private"], default: "group" },
    language: { type: String, enum: LANGS, default: "both" },
    warehouse_ids: [ref("Warehouse")], // empty = all warehouses
    event_codes: { type: [{ type: String, enum: EVENT_CODES }], default: [] },
    last_sent_at: { type: Date, default: null },
    ...defaultFields,
  },
  schemaOptions,
);
chatSchema.index({ bot_id: 1, chat_id: 1 });

// Edited text of an event (missing = built-in default)
const templateSchema = new mongoose.Schema(
  {
    event_code: { type: String, enum: EVENT_CODES, required: true },
    template_kh: { type: String, default: "" },
    template_en: { type: String, default: "" },
    updated_by: ref("User"),
  },
  schemaOptions,
);
templateSchema.index({ event_code: 1 }, { unique: true });

// Report sent to a chat at fixed times (Cambodia time) + "Send now"
const scheduleSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    chat_ids: [{ ...ref("TelegramChat") }],
    report_codes: { type: [{ type: String, enum: REPORT_CODES }], default: [] },
    warehouse_ids: [ref("Warehouse")], // empty = the chat's warehouses (or all)
    times: { type: [String], default: ["08:00"] }, // "HH:mm"
    days: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0 = Sunday
    last_run_key: { type: String, default: "" }, // "2026-10-01 08:00"
    last_run_at: { type: Date, default: null },
    ...defaultFields,
  },
  schemaOptions,
);

// Queue + log of every message (sent by the worker, retried on failure)
const messageSchema = new mongoose.Schema(
  {
    bot_id: ref("TelegramBot"),
    chat_ref: ref("TelegramChat"),
    chat_id: { type: String, required: true },
    kind: { type: String, enum: ["event", "report", "test", "message"], default: "event" },
    code: { type: String, required: true }, // event or report code
    text: { type: String, required: true },
    warehouse_id: ref("Warehouse"),
    ref_type: { type: String, default: null },
    ref_id: { type: mongoose.Schema.Types.ObjectId, default: null },
    happened_at: { type: Date, default: Date.now },
    state: { type: String, enum: ["pending", "sent", "failed"], default: "pending" },
    attempts: { type: Number, default: 0 },
    next_try_at: { type: Date, default: Date.now },
    last_error: { type: String, default: "" },
    sent_at: { type: Date, default: null },
    tg_message_id: { type: Number, default: null },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
messageSchema.index({ state: 1, next_try_at: 1 });
messageSchema.index({ created_date: -1 });

module.exports = {
  TelegramBotModel: mongoose.model("TelegramBot", botSchema),
  TelegramChatModel: mongoose.model("TelegramChat", chatSchema),
  TelegramTemplateModel: mongoose.model("TelegramTemplate", templateSchema),
  TelegramScheduleModel: mongoose.model("TelegramSchedule", scheduleSchema),
  TelegramMessageModel: mongoose.model("TelegramMessage", messageSchema),
  LANGS,
};
