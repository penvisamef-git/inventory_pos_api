require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// must load before any model: counts DB calls per request (Server-Timing / slow log)
const { reqStore } = require("./src/util/db_timing");
const connectDB = require("./src/util/db");
const { api_auth } = require("./src/util/api_auth");
const { jwt_auth } = require("./src/util/jwt_auth");
const request_user = require("./src/util/request_user");
const adminAPI_V1 = require("./src/v1/admin/index.route");

const PORT = process.env.api_port || 8086;
const app = express();

// ================= Middleware =================
// CORS: only our admin web may call the API from a browser.
// Extra sites (new domain, POS app …): CORS_ORIGINS="https://a.com,https://b.com" in .env / Vercel ("*" = any, not recommended).
// Calls without an Origin header (Postman, server-to-server, uptime checks) are not affected.
const CORS_DEFAULT = [
  "https://inventory-pos-kh.web.app",
  "https://inventory-pos-kh.firebaseapp.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
];
const corsOrigins = new Set([
  ...CORS_DEFAULT,
  ...String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
]);
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || corsOrigins.has("*") || corsOrigins.has(origin)),
    exposedHeaders: ["Server-Timing", "Retry-After"],
    maxAge: 86400, // browsers cache the preflight for a day → fewer OPTIONS calls
  }),
);
app.use(helmet());
app.use(compression());

// Timing: every response gets "Server-Timing: app;dur=… , db;desc=\"N calls\"" (browser DevTools → Network → Timing)
// and slow requests (> 500 ms) are logged with their DB call count.
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  const store = { db: 0 };
  const ms = () => Number(process.hrtime.bigint() - start) / 1e6;
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    if (!res.headersSent) {
      res.setHeader("Server-Timing", `app;dur=${ms().toFixed(0)}, db;desc="${store.db} calls"`);
      res.setHeader("Timing-Allow-Origin", "*");
    }
    return writeHead.apply(this, args);
  };
  res.on("finish", () => {
    const t = ms();
    if (t > 500) console.log(`[slow] ${req.method} ${req.originalUrl} ${res.statusCode} ${t.toFixed(0)}ms · ${store.db} db calls`);
  });
  reqStore.run(store, next);
});

app.use(express.json({ limit: "2mb" }));

// ================= Connection =================
connectDB();

// Keep-awake / uptime check (no key needed, no data): an uptime service can call it every 5 min
// so the Vercel function stays warm and the DB connection stays open.
app.get("/health", async (req, res) => {
  const t = Date.now();
  let db = "down";
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().command({ ping: 1 });
      db = "ok";
    }
  } catch {
    db = "error";
  }
  res.set("Cache-Control", "no-store").json({ ok: db === "ok", db, ms: Date.now() - t });
});

app.get("/", api_auth, (req, res) => {
  res.send({
    success: true,
    message: "Inventory POS API Connected",
  });
});

// ================= Routes =================
const prop = { app, jwt, api_auth, jwt_auth, request_user };
adminAPI_V1(prop);

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// Invalid JSON body and other unhandled errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid JSON body" });
  }
  console.error(err);
  res.status(500).json({ success: false, message: "Internal Server Error" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on ${PORT}`);
  });
  // Telegram: send queued messages + scheduled reports (only in the real server, not in scripts / tests)
  require("./src/v1/admin/telegram/telegram.service").startWorker();
}

// 🧼 Gracefully handle shutdown
process.on("SIGINT", async () => {
  await mongoose.connection.close();
  console.log("🛑 MongoDB disconnected cleanly");
  process.exit(0);
});

module.exports = app;
