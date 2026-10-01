const { ROLES } = require("./user_roles");

const ROLE_ADMIN = ROLES.ADMIN.value;
const ROLE_CENTRAL_MANAGER = ROLES.CENTRAL_MANAGER.value;
const ROLE_ACCOUNTANT = ROLES.ACCOUNTANT.value;
const ROLE_SHOP_MANAGER = ROLES.SHOP_MANAGER.value;
const ROLE_CASHIER = ROLES.CASHIER.value;

// Use after request_user.  Super admin always passes.
// Example: prop.app.post(url, prop.api_auth, prop.jwt_auth, prop.request_user, allow_roles(ROLE_ADMIN), handler)
function allow_roles(...roles) {
  return (req, res, next) => {
    const user = req.user || {};
    if (user.is_super_admin || roles.includes(user.role)) return next();
    return res.status(403).json({
      success: false,
      message: "អ្នកមិនមានសិទ្ធិធ្វើសកម្មភាពនេះទេ!",
    });
  };
}

// ================= Shortcuts =================
// Users, sessions, activity log
const can_manage_users = allow_roles(ROLE_ADMIN);
// Setting, exchange rate, payment method, warehouse
const can_manage_setup = allow_roles(ROLE_ADMIN);
// Unit, category, attribute, brand, product, price, promotion, supplier, upload
const can_manage_product = allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER);
// Read master data in the admin web (cashier has no admin web access)
const can_view_master = allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_ACCOUNTANT, ROLE_SHOP_MANAGER);
// Stock: opening, goods receive, post adjustments, dispatch from central
const can_manage_stock = allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER);
// Stock work in a shop: request transfers, receive transfers, draft adjustments (own shop)
const can_work_stock = allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_SHOP_MANAGER);
// Central roles only (all warehouses)
const can_view_all = allow_roles(ROLE_ADMIN, ROLE_CENTRAL_MANAGER, ROLE_ACCOUNTANT);

module.exports = {
  allow_roles,
  can_manage_users,
  can_manage_setup,
  can_manage_product,
  can_view_master,
  can_view_all,
  can_manage_stock,
  can_work_stock,
  ROLE_ADMIN,
  ROLE_CENTRAL_MANAGER,
  ROLE_ACCOUNTANT,
  ROLE_SHOP_MANAGER,
  ROLE_CASHIER,
};
