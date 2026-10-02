// npm test                → every tests/*.test.js, one after another (they share one test database)
// npm test -- stock price → only files whose name contains "stock" or "price"
// Needs: .env with a TEST database (MONGO_DB = uat / test …) and the sample data (npm run seed:sample).
// Tip: stop `npm run dev` while testing, or set TELEGRAM_WORKER=off there — its Telegram sender may grab test messages.
// Each test creates its own rows (@local.test / ZZ codes) and deletes them at the end.
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
require("../scripts/lib/test_db_guard").assertTestDb("Tests");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const filters = process.argv.slice(2);
const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.js") && (!filters.length || filters.some((x) => f.includes(x))))
  .sort();
let failedFiles = 0;
const rows = [];
const t0 = Date.now();
for (const f of files) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: "utf8", env: { ...process.env, TELEGRAM_WORKER: "off" }, timeout: 10 * 60 * 1000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const fails = out.split("\n").filter((l) => l.startsWith("FAIL"));
  const summary = (out.match(/(\d+)\/(\d+) passed[^\n]*/g) || []).pop() || "no summary";
  const m = summary.match(/(\d+)\/(\d+)/);
  const ok = r.status === 0 && fails.length === 0 && m && m[1] === m[2];
  if (!ok) failedFiles += 1;
  rows.push(`${ok ? "✅" : "❌"} ${f.padEnd(28)} ${summary}  (${((Date.now() - t) / 1000).toFixed(0)} s)`);
  console.log(rows[rows.length - 1]);
  fails.forEach((l) => console.log("     " + l));
  if (!ok && !fails.length) console.log(out.split("\n").slice(-15).join("\n"));
}
console.log(`\n${files.length - failedFiles}/${files.length} test files passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(failedFiles ? 1 : 0);
