// Activity log categories (title is used as categoryTitle in logActivity)
function activityLogType() {
  return [
    { id: 0, title: "other" },
    { id: 1, title: "auth" },
    { id: 2, title: "user" },
    // ---- Setup ----
    { id: 10, title: "setting" },
    { id: 11, title: "exchange_rate" },
    { id: 12, title: "payment_method" },
    { id: 13, title: "warehouse" },
    // ---- Product ----
    { id: 20, title: "unit" },
    { id: 21, title: "category" },
    { id: 22, title: "attribute" },
    { id: 23, title: "brand" },
    { id: 24, title: "product" },
    { id: 25, title: "price" },
    { id: 26, title: "promotion" },
    // ---- Partner ----
    { id: 30, title: "supplier" },
    // ---- Stock ----
    { id: 40, title: "stock_opening" },
    { id: 41, title: "goods_receive" },
    { id: 42, title: "transfer" },
    { id: 43, title: "stock_adjustment" },
  ];
}

module.exports = {
  activityLogType,
};
