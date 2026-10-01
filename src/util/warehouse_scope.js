const mongoose = require("mongoose");
const { roleScope } = require("./user_roles");

// Use after request_user (put it in the route's guard array).
// Central roles (scope "all") see every warehouse; shop roles (scope "own") only user.warehouse_ids.
// Sets:
//   req.warehouse_scope  = "all" | "own"
//   req.warehouse_ids    = null (all) | [ObjectId, ...]
//   req.warehouse_filter = {} | { warehouse_id: { $in: [...] } }   → pass to getFilteredMongoDB additionalFilter
function warehouse_scope(req, res, next) {
  if (roleScope(req.user) === "all") {
    req.warehouse_scope = "all";
    req.warehouse_ids = null;
    req.warehouse_filter = {};
    return next();
  }

  const ids = (req.user?.warehouse_ids || [])
    .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  if (ids.length === 0) {
    return res.status(403).json({
      success: false,
      message: "គណនីនេះមិនទាន់បានភ្ជាប់ទៅឃ្លាំងណាមួយទេ!",
    });
  }

  req.warehouse_scope = "own";
  req.warehouse_ids = ids;
  req.warehouse_filter = { warehouse_id: { $in: ids } };
  next();
}

// Filter for another field name, e.g.
//   scopeFilter(req, "_id")                                    → the Warehouse list itself
//   scopeFilter(req, ["from_warehouse_id", "to_warehouse_id"]) → transfers (either side)
function scopeFilter(req, field = "warehouse_id") {
  if (!req.warehouse_ids) return {};
  const fields = Array.isArray(field) ? field : [field];
  if (fields.length === 1) return { [fields[0]]: { $in: req.warehouse_ids } };
  return { $or: fields.map((f) => ({ [f]: { $in: req.warehouse_ids } })) };
}

// true when this user may see / use the warehouse (for get / update by id)
function canAccessWarehouse(req, warehouseId) {
  if (!req.warehouse_ids) return true;
  if (!warehouseId) return false;
  const id = String(warehouseId?._id || warehouseId);
  return req.warehouse_ids.some((w) => String(w) === id);
}

module.exports = { warehouse_scope, scopeFilter, canAccessWarehouse };
