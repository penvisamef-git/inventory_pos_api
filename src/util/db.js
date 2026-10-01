const mongoose = require("mongoose");
const dns = require("dns");
require("dotenv").config();

dns.setServers(["1.1.1.1", "1.0.0.1"]);
const uri = `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@cluster0.ynmhasx.mongodb.net/${process.env.MONGO_DB}?retryWrites=true&w=majority`;

const connectDB = async () => {
  try {
    await mongoose.connect(uri);
    console.log("✅ Connected to MongoDB Atlas successfully!");
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB Atlas:", err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
