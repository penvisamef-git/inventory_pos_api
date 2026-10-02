const ActivityLog = require("../v1/admin/activity_log/activity_log.model");
const ActivityLogCategory = require("../v1/admin/activity_log_category/activity_log_category.model");
const helper = require("./helper");
const { activityLogType } = require("./activity_log_type");

// Super admins leave no activity log (agreed): their logins / changes are not written, and old rows are hidden in
// the list. The ids are kept 60 s so a log call costs no extra DB call.
let superIds = null;
let superAt = 0;
async function superAdminIds() {
  if (superIds && Date.now() - superAt < 60 * 1000) return superIds;
  const User = require("../v1/admin/user/user.model");
  const rows = await User.find({ is_super_admin: true }).select("_id").lean();
  superIds = new Set(rows.map((u) => String(u._id)));
  superAt = Date.now();
  return superIds;
}
const clearSuperAdminIds = () => {
  superIds = null;
};
async function isSuperAdmin(userId, req) {
  if (!userId) return false;
  if (req?.user && String(req.user._id) === String(userId) && req.user.is_super_admin !== undefined) return !!req.user.is_super_admin;
  return (await superAdminIds()).has(String(userId));
}

// Find or create the log category (unknown titles fall back to "other")
async function getCategory(categoryTitle) {
  const list = activityLogType();
  const category =
    list.find((cat) => cat.title.toLowerCase() === String(categoryTitle || "").toLowerCase()) ||
    list.find((cat) => cat.id === 0);

  let categoryDoc = await ActivityLogCategory.findOne({ title: category.title });
  if (!categoryDoc) {
    categoryDoc = await ActivityLogCategory.create({
      name: category.title,
      title: category.title,
      status: true,
    });
  }
  return categoryDoc;
}

async function logActivity({ title, description, categoryTitle, createdBy, req }) {
  try {
    if (await isSuperAdmin(createdBy, req)) return; // super admin: no log
    const categoryDoc = await getCategory(categoryTitle);

    await ActivityLog.create({
      title,
      description,
      activity_log_category_id: categoryDoc._id,
      create_by_id: createdBy,
      device: helper.extractDeviceInfo(req),
      time: helper.cambodiaDate(),
    });
  } catch (err) {
    console.error("Failed to log activity:", err.message);
    // Don't throw here to avoid crashing the main request flow
  }
}

module.exports = { logActivity, superAdminIds, clearSuperAdminIds };
