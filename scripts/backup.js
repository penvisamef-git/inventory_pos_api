// Full database backup: every collection → <folder>/<collection>.json.gz (Extended JSON, keeps ObjectId / Date types)
//   npm run backup                     → backups/<MONGO_DB>/<YYYY-MM-DD_HHmm>/
//   npm run backup -- --out /some/dir  → another folder
//   BACKUP_KEEP=14 (default) keeps the newest 14 backups of this database in the default folder.
// Read-only: never changes the database. Restore with scripts/restore.js.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const mongoose = require("mongoose");
const connectDB = require("../src/util/db");

const { EJSON } = mongoose.mongo.BSON;
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};

(async () => {
  const db = process.env.MONGO_DB;
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Phnom_Penh" }).replace(" ", "_").replace(/:/g, "").slice(0, 15);
  const root = arg("--out") || path.join(__dirname, "..", "backups", db);
  const dir = arg("--out") ? root : path.join(root, stamp);
  fs.mkdirSync(dir, { recursive: true });

  await connectDB();
  const started = Date.now();
  const cols = (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();
  const manifest = { database: db, created_at: new Date().toISOString(), collections: {} };
  for (const name of cols) {
    const docs = await mongoose.connection.db.collection(name).find({}).toArray();
    const file = path.join(dir, `${name}.json.gz`);
    fs.writeFileSync(file, zlib.gzipSync(EJSON.stringify(docs, { relaxed: false })));
    manifest.collections[name] = docs.length;
    console.log(`  ${name.padEnd(28)} ${String(docs.length).padStart(7)} rows`);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const total = Object.values(manifest.collections).reduce((a, b) => a + b, 0);
  console.log(`✅ Backup of "${db}": ${cols.length} collections, ${total} rows → ${dir} (${((Date.now() - started) / 1000).toFixed(1)} s)`);

  // keep only the newest N backups (default folder only)
  if (!arg("--out")) {
    const keep = Number(process.env.BACKUP_KEEP || 14);
    const old = fs.readdirSync(root).filter((f) => /^\d{4}-\d\d-\d\d_\d{4}$/.test(f)).sort().slice(0, -keep);
    old.forEach((f) => fs.rmSync(path.join(root, f), { recursive: true, force: true }));
    if (old.length) console.log(`🧹 removed ${old.length} old backup(s), keeping ${keep}`);
  }
  await mongoose.connection.close();
  process.exit(0);
})().catch(async (err) => {
  console.error("❌ Backup failed:", err.message);
  process.exit(1);
});
