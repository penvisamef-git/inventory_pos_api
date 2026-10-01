const mongoose = require("mongoose");
const { USER_ROLES } = require("../../../util/user_roles");

const userSchema = new mongoose.Schema(
  {
    firstname: { type: String, required: true, trim: true },
    lastname: { type: String, required: true, trim: true },
    contact: { type: String, required: false, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    job_title: { type: String, required: false },
    password: { type: String, required: true, select: true },

    // Role (fixed list, see src/util/user_roles.js)
    role: {
      type: String,
      enum: [...USER_ROLES, null],
      default: null,
    },

    // Must change password after the first login / after an admin reset
    is_first_login: {
      type: Boolean,
      default: true,
    },

    is_super_admin: {
      type: Boolean,
      default: false,
    },

    // POS quick login (4–6 digits, bcrypt hash). Never returned by the API → see has_pos_pin
    pos_pin: { type: String, default: null },

    // Warehouses / shops this user works in (required for shop manager + cashier: scope "own")
    warehouse_ids: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Warehouse",
      },
    ],

    // >>>>>> Default <<<<< //
    note: String,
    status: {
      type: Boolean,
      default: true,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: { createdAt: "created_date", updatedAt: "updated_date" },
  },
);

userSchema.index({ email: 1 });
userSchema.index({ warehouse_ids: 1 });

// Never send the password / PIN hash back to the client
userSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.has_pos_pin = !!ret.pos_pin;
    delete ret.password;
    delete ret.pos_pin;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
