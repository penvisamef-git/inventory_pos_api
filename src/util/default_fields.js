const mongoose = require("mongoose");

// >>>>>> Default <<<<< fields used by every master-data schema
//   const schema = new mongoose.Schema({ ...fields, ...defaultFields }, schemaOptions)
const defaultFields = {
  note: String,
  status: { type: Boolean, default: true },
  deleted: { type: Boolean, default: false },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
};

const schemaOptions = {
  timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
};

module.exports = { defaultFields, schemaOptions };
