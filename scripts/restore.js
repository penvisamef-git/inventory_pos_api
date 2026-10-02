// Restore a backup made by scripts/backup.js.
//   npm run restore -- <backup folder> --to <database name> [--only coll1,coll2] [--replace] --yes
// Safety:
//   - --to is required and must be typed out (no default), --yes is required.
//   - Without --replace it refuses when a target collection already has data (restore into an empty / new database).
//   - With --replace the target collection is emptied first — that data is gone.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const mongoose = require("mongoose");

const { EJSON } = mongoose.mongo.BSON;
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const dir = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
const target = arg("--to");
const only = (arg("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);
const replace = args.includes("--replace");

(async () => {
  if (!dir || !fs.existsSync(path.join(dir, "manifest.json"))) throw new Error("give the backup folder (it has a manifest.json)");
  if (!target) throw new Error("say which database to restore into: --to <database name>");
  if (!args.includes("--yes")) throw new Error(`add --yes to restore into "${target}"${replace ? " (its data will be REPLACED)" : ""}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const names = Object.keys(manifest.collections).filter((n) => !only.length || only.includes(n));

  process.env.MONGO_DB = target; // connect to the target database
  await require("../src/util/db")();
  const db = mongoose.connection.db;
  if (!replace) {
    for (const n of names) {
      if (await db.collection(n).estimatedDocumentCount()) throw new Error(`"${target}.${n}" already has data — use an empty database, or --replace`);
    }
  }
  console.log(`Restoring backup of "${manifest.database}" (${manifest.created_at}) into "${target}"…`);
  for (const n of names) {
    const docs = EJSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, `${n}.json.gz`))).toString("utf8"), { relaxed: false });
    if (replace) await db.collection(n).deleteMany({});
    if (docs.length) await db.collection(n).insertMany(docs, { ordered: false });
    console.log(`  ${n.padEnd(28)} ${String(docs.length).padStart(7)} rows`);
  }
  console.log("✅ Restore done. Indexes are rebuilt by the API when it starts.");
  await mongoose.connection.close();
  process.exit(0);
})().catch((err) => {
  console.error("❌ Restore stopped:", err.message);
  process.exit(1);
});
