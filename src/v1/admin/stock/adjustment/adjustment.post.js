const { postMovements, getBatch, allocateFefo, StockError } = require("../stock.engine");

// Post an adjustment: + rows in (at the given cost or the average), − rows out (batch given or FEFO incl. expired)
async function postAdjustment(doc, { session, userId }) {
  const lines = [];
  for (const it of doc.items) {
    const base = { warehouse_id: doc.warehouse_id, product_id: it.product_id, variant_id: it.variant_id, label: it.sku, note: it.note };
    if (it.base_qty > 0) {
      let batchId = null;
      if (it.track_batch) {
        const batch = await getBatch({ ...it.toObject(), cost: it.base_unit_cost, source: { type: "adjustment", id: doc._id, no: doc.doc_no }, session, userId });
        batchId = batch._id;
        it.batch_id = batchId;
      }
      lines.push({ ...base, batch_id: batchId, type: "adjust_in", qty: it.base_qty, unit_cost: it.base_unit_cost });
    } else if (it.track_batch) {
      const need = -it.base_qty;
      let allocs;
      if (it.batch_id) allocs = [{ batch_id: it.batch_id, batch_no: it.batch_no, expiry_date: it.expiry_date, qty: need }];
      else {
        const f = await allocateFefo(doc.warehouse_id, it.variant_id, need, { session, includeExpired: true });
        if (f.short > 0) throw new StockError(`Batch មិនគ្រប់គ្រាន់សម្រាប់ ${it.sku} (ខ្វះ ${f.short})`);
        allocs = f.allocations;
      }
      it.batches = allocs;
      allocs.forEach((a) => lines.push({ ...base, batch_id: a.batch_id, type: "adjust_out", qty: -a.qty }));
    } else {
      lines.push({ ...base, type: "adjust_out", qty: it.base_qty });
    }
  }
  return postMovements(lines, { session, userId, date: new Date(), ref_type: "stock_adjustment", ref_id: doc._id, ref_no: doc.doc_no });
}

module.exports = { postAdjustment };
