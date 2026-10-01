const Counter = require("../v1/admin/counter/counter.model");

// "2610" (yy + mm) in Cambodia time
function yymm(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Phnom_Penh",
    year: "2-digit",
    month: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  return `${y}${m}`;
}

// Next document number, e.g. nextNo("TR") → "TR-2610-0001" (restarts every month)
// Atomic ($inc + upsert), safe when two users save at the same time.
// options: { date, pad = 4, session } — pass a session when used inside a transaction
async function nextNo(prefix, { date, pad = 4, session } = {}) {
  const key = `${prefix}-${yymm(date)}`;
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, session },
  );
  return `${key}-${String(doc.seq).padStart(pad, "0")}`;
}

module.exports = { nextNo, yymm };
