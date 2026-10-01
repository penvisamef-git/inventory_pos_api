function activityLogType() {
  return [
    { id: 0, title: "other" },
    { id: 1, title: "auth" },
    { id: 2, title: "user" },
    { id: 3, title: "category" },
    { id: 4, title: "menu_section" },
    { id: 5, title: "menu_item" },
    { id: 6, title: "banner" },
    { id: 7, title: "setting" },
    { id: 8, title: "menu_book" },
  ];
}

module.exports = {
  activityLogType,
};
