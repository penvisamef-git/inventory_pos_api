// Sample data and tests create / delete rows. They must never run against the real (production) database.
// Allowed only when MONGO_DB looks like a test database (uat, test, dev, sample, demo, staging),
// or when ALLOW_ANY_DB=yes is set on purpose for one run.
const SAFE = /(uat|test|dev|sample|demo|staging)/i;

function assertTestDb(what) {
  const db = process.env.MONGO_DB || "";
  if (SAFE.test(db) || process.env.ALLOW_ANY_DB === "yes") return;
  console.error(
    `\n⛔ ${what} stopped: MONGO_DB="${db}" does not look like a test database.\n` +
      `   It only runs on uat / test / dev / sample / demo / staging databases, so real shop data is never touched.\n` +
      `   (If you are sure: ALLOW_ANY_DB=yes ${process.argv.slice(1).join(" ")})\n`,
  );
  process.exit(1);
}

module.exports = { assertTestDb };
