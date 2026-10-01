const mongoose = require("mongoose");
const StockMovementModel = require("./movement.model");
const BatchModel = require("./batch.model");
const { StockBalanceModel, StockBatchBalanceModel } = require("./balance.model");
const { round } = require("../../../util/helper");

const EPS = 1e-9;

// Error with a Khmer message → route answers 400 (the transaction is rolled back)
class StockError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.isStockError = true;
    this.status = status;
  }
}

// Run fn(session) in a transaction. StockError → { error, status }, other errors are thrown.
async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return { result };
  } catch (err) {
    if (err.isStockError) return { error: err.message, status: err.status };
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Write ledger rows and update the cached balances (call inside inTransaction).
 * lines: [{ warehouse_id, product_id, variant_id, batch_id?, type, qty (signed, base unit),
 *           unit_cost? (per base unit; IN rows — default = current average), allow_negative?, label?, note? }]
 * ctx:   { session, userId, date, ref_type, ref_id, ref_no }
 *
 * IN  : average = (qty × avg + in_qty × in_cost) / (qty + in_qty); when stock ≤ 0 the average becomes the in cost.
 * OUT : always at the current average; cannot go below 0 unless allow_negative (POS sales in a shop).
 * → movement docs
 */
async function postMovements(lines, ctx) {
  const { session, userId, ref_type, ref_id, ref_no } = ctx;
  const date = ctx.date || new Date();
  const out = [];
  for (const l of lines) {
    const qty = round(l.qty, 4);
    if (Math.abs(qty) < EPS) continue;
    const key = { warehouse_id: l.warehouse_id, variant_id: l.variant_id };
    const bal = (await StockBalanceModel.findOne(key).session(session)) || new StockBalanceModel({ ...key, product_id: l.product_id, qty: 0, avg_cost: 0 });

    let unitCost;
    let avg = bal.avg_cost;
    const newQty = round(bal.qty + qty, 4);
    if (qty > 0) {
      unitCost = l.unit_cost === undefined || l.unit_cost === null ? bal.avg_cost : Number(l.unit_cost);
      avg = bal.qty <= EPS ? unitCost : (bal.qty * bal.avg_cost + qty * unitCost) / (bal.qty + qty);
    } else {
      unitCost = bal.avg_cost;
      if (newQty < -EPS && !l.allow_negative) {
        throw new StockError(`ស្តុកមិនគ្រប់គ្រាន់: ${l.label || "ទំនិញ"} មាន ${round(bal.qty, 4)} តែត្រូវការ ${round(-qty, 4)}`);
      }
    }
    avg = round(avg, 6);
    bal.qty = newQty;
    bal.avg_cost = avg;
    bal.total_value = round(newQty * avg, 4);
    bal.last_movement_at = date;
    await bal.save({ session });

    if (l.batch_id) {
      const bkey = { ...key, batch_id: l.batch_id };
      const bb = await StockBatchBalanceModel.findOne(bkey).session(session);
      const bQty = round((bb?.qty || 0) + qty, 4);
      if (qty < 0 && bQty < -EPS && !l.allow_negative) {
        throw new StockError(`Batch មិនគ្រប់គ្រាន់: ${l.label || "ទំនិញ"} មាន ${round(bb?.qty || 0, 4)} តែត្រូវការ ${round(-qty, 4)}`);
      }
      if (bb) {
        bb.qty = bQty;
        await bb.save({ session });
      } else {
        const batch = await BatchModel.findById(l.batch_id).session(session);
        await StockBatchBalanceModel.create([{ ...bkey, product_id: l.product_id, qty: bQty, expiry_date: batch?.expiry_date || null }], { session });
      }
    }

    const [mv] = await StockMovementModel.create(
      [
        {
          movement_date: date,
          warehouse_id: l.warehouse_id,
          product_id: l.product_id,
          variant_id: l.variant_id,
          batch_id: l.batch_id || null,
          type: l.type,
          qty,
          unit_cost: round(unitCost, 6),
          total_cost: round(qty * unitCost, 4),
          balance_after: newQty,
          avg_cost_after: avg,
          ref_type,
          ref_id,
          ref_no,
          note: l.note || "",
          created_by: userId,
        },
      ],
      { session },
    );
    out.push(mv);
  }
  return out;
}

/**
 * FEFO: take baseQty from the batches of a variant in a warehouse, nearest expiry first
 * (no expiry → last; expired batches skipped unless includeExpired).
 * → { allocations: [{ batch_id, batch_no, expiry_date, qty }], short }  (short > 0 = not enough)
 */
async function allocateFefo(warehouseId, variantId, baseQty, { session, at = new Date(), includeExpired = false } = {}) {
  const rows = await StockBatchBalanceModel.find({ warehouse_id: warehouseId, variant_id: variantId, qty: { $gt: EPS } })
    .populate("batch_id", "batch_no expiry_date")
    .session(session || null)
    .lean();
  rows.sort((a, b) => {
    const ea = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity;
    const eb = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
    return ea - eb;
  });
  let left = round(baseQty, 4);
  const allocations = [];
  for (const r of rows) {
    if (left <= EPS) break;
    if (!includeExpired && r.expiry_date && new Date(r.expiry_date) <= at) continue;
    const take = round(Math.min(left, r.qty), 4);
    allocations.push({ batch_id: r.batch_id._id, batch_no: r.batch_id.batch_no, expiry_date: r.batch_id.expiry_date, qty: take });
    left = round(left - take, 4);
  }
  return { allocations, short: Math.max(0, left) };
}

// Find or create a batch (same variant + batch_no must have the same expiry)
async function getBatch({ product_id, variant_id, batch_no, expiry_date, mfg_date, cost, source, session, userId }) {
  const no = String(batch_no).trim().toUpperCase();
  const existing = await BatchModel.findOne({ variant_id, batch_no: no }).session(session);
  if (existing) {
    const a = existing.expiry_date ? existing.expiry_date.toISOString().slice(0, 10) : null;
    const b = expiry_date ? new Date(expiry_date).toISOString().slice(0, 10) : null;
    if (a !== b) throw new StockError(`Batch ${no} មានរួចហើយ ដែលផុតកំណត់ ${a || "-"} (មិនមែន ${b || "-"})`);
    return existing;
  }
  const [batch] = await BatchModel.create(
    [
      {
        product_id,
        variant_id,
        batch_no: no,
        expiry_date: expiry_date || null,
        mfg_date: mfg_date || null,
        receive_cost: cost ?? null,
        source_type: source?.type || null,
        source_id: source?.id || null,
        source_no: source?.no || null,
        created_by: userId,
      },
    ],
    { session },
  );
  return batch;
}

// Current qty (base unit) per variant in a warehouse → Map(variantId → { qty, avg_cost })
async function balancesOf(warehouseId, variantIds, session) {
  const rows = await StockBalanceModel.find({ warehouse_id: warehouseId, variant_id: { $in: variantIds } }).session(session || null).lean();
  return new Map(rows.map((r) => [String(r.variant_id), r]));
}

module.exports = { StockError, inTransaction, postMovements, allocateFefo, getBatch, balancesOf, EPS };
