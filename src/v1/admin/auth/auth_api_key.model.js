const mongoose = require("mongoose");
const userSchema = new mongoose.Schema({
  api_auth_key: String,
});
module.exports = mongoose.model("AuthKey", userSchema);
