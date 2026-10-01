// Fixed user roles. `value` is what is saved in user.role (Khmer text).
// scope: "all" → sees every warehouse
//        "own" → sees only the warehouses in user.warehouse_ids
const ROLES = {
  ADMIN: { value: "អ្នកគ្រប់គ្រងប្រព័ន្ធ", label_en: "Admin", scope: "all" },
  CENTRAL_MANAGER: { value: "អ្នកគ្រប់គ្រងឃ្លាំងកណ្តាល", label_en: "Central warehouse manager", scope: "all" },
  ACCOUNTANT: { value: "គណនេយ្យករ", label_en: "Accountant", scope: "all" },
  SHOP_MANAGER: { value: "អ្នកគ្រប់គ្រងហាង", label_en: "Shop manager", scope: "own" },
  CASHIER: { value: "អ្នកគិតលុយ", label_en: "Cashier", scope: "own" },
};

// [{ value, label_kh, label_en, scope }] — for dropdowns
const ROLE_LIST = Object.values(ROLES).map((r) => ({ ...r, label_kh: r.value }));

// ["អ្នកគ្រប់គ្រងប្រព័ន្ធ", ...] — for validation / model enum
const USER_ROLES = ROLE_LIST.map((r) => r.value);

// "all" | "own" for a user (super admin always "all"; unknown role → "own", the safe side)
function roleScope(user) {
  if (!user) return "own";
  if (user.is_super_admin) return "all";
  const role = ROLE_LIST.find((r) => r.value === user.role);
  return role ? role.scope : "own";
}

module.exports = { ROLES, ROLE_LIST, USER_ROLES, roleScope };
