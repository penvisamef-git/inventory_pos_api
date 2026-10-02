const mongoose = require("mongoose");

// Personal notes (like the notes app on a phone): every user writes and sees only their own notes;
// a super admin sees and can edit everyone's. Notes are private: they are never written to the activity log.
const COLORS = ["default", "yellow", "green", "blue", "pink", "purple"];

const noteSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // owner
    title: { type: String, trim: true, default: "", maxlength: 200 },
    body: { type: String, default: "", maxlength: 20000 },
    color: { type: String, enum: COLORS, default: "default" },
    pinned: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);
noteSchema.index({ user_id: 1, deleted: 1, pinned: -1, updated_date: -1 });

const NoteModel = mongoose.model("Note", noteSchema);
NoteModel.COLORS = COLORS;
module.exports = NoteModel;
