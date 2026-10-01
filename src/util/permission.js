const { USER_ROLES } = require("./user_roles");

const [ROLE_ADMIN, ROLE_MENU_MANAGER, ROLE_STAFF] = USER_ROLES;

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

// Shortcuts
const can_manage_users = allow_roles(ROLE_ADMIN);
const can_manage_menu = allow_roles(ROLE_ADMIN, ROLE_MENU_MANAGER);

module.exports = {
  allow_roles,
  can_manage_users,
  can_manage_menu,
  ROLE_ADMIN,
  ROLE_MENU_MANAGER,
  ROLE_STAFF,
};
