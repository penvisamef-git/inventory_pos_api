// Bakong (NBC) — check a KHQR payment by the md5 of the QR text.
// Needs BAKONG_TOKEN (from https://api-bakong.nbc.gov.kh/register). Without it the POS just shows the QR
// and the cashier confirms by hand. BAKONG_API_URL can point at a relay if the Bakong API refuses the server's region.
const URL_BASE = () => (process.env.BAKONG_API_URL || "https://api-bakong.nbc.gov.kh").replace(/\/+$/, "");
const cache = new Map(); // md5 → paid result (a paid md5 never changes)

const ready = () => !!process.env.BAKONG_TOKEN;

async function checkMd5(md5) {
  if (!ready()) return { ready: false, paid: false };
  if (cache.has(md5)) return cache.get(md5);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${URL_BASE()}/v1/check_transaction_by_md5`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.BAKONG_TOKEN}` },
      body: JSON.stringify({ md5 }),
      signal: ctrl.signal,
    });
    if (r.status === 401 || r.status === 403) return { ready: true, paid: false, error: "token" };
    const j = await r.json().catch(() => ({}));
    if (j?.responseCode === 0 && j.data) {
      const out = { ready: true, paid: true, hash: j.data.hash || null, amount: Number(j.data.amount) || 0, currency: j.data.currency || null, from: j.data.fromAccountId || null, at: j.data.acknowledgedDateMs || j.data.createdDateMs || null };
      if (cache.size > 5000) cache.clear();
      cache.set(md5, out);
      return out;
    }
    return { ready: true, paid: false };
  } catch (e) {
    return { ready: true, paid: false, error: e.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ready, checkMd5 };
