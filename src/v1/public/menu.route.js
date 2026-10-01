const SettingModel = require("../admin/menu/setting/model");
const CategoryModel = require("../admin/menu/category/model");
const SectionModel = require("../admin/menu/section/model");
const ItemModel = require("../admin/menu/item/model");
const BannerModel = require("../admin/menu/banner/model");
const BookModel = require("../admin/menu/book/model");

// Only these fields leave the server (no notes, no user ids)
const SETTING_FIELDS =
  "restaurant_name tagline logo address phone email website facebook telegram map_url currency currency_symbol exchange_rate_khr opening_hours copyright";
const BOOK_FIELDS = "code name_en name_kh name_cn location format serve_from serve_to cover sort_order";
const CATEGORY_FIELDS = "code name_en name_kh name_cn type icon serve_from serve_to intro_en intro_kh intro_cn sort_order";
const SECTION_FIELDS = "category_id name_en name_kh name_cn subtitle style sort_order";
const ITEM_FIELDS =
  "code category_id section_id book_ids name_en name_kh name_cn desc_en desc_kh desc_cn image price_type price sizes is_featured is_available sort_order";
const BANNER_FIELDS = "type title subtitle image category_id menu_item_id link_url sort_order";

const route = (prop) => {
  const urlAPI = `/${prop.public_route}/menu`;

  const invalidLink = "តំណម៉ឺនុយនេះមិនត្រឹមត្រូវ ឬត្រូវបានប្តូរហើយ!";
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";

  // ===================================== FULL MENU ================================================
  // GET /api/public/menu/:token  → { setting, books, categories, sections, items, banners }
  // Riel price = price × setting.exchange_rate_khr (the client shows it)
  // Only active (status = true) and not deleted rows. Sold-out items are included (is_available = false).
  prop.app.get(`${urlAPI}/:token`, async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();
      if (!token || token.length < 8) {
        return res.status(404).json({ success: false, message: invalidLink });
      }

      const setting = await SettingModel.findOne({ key: "main", public_token: token }).select(SETTING_FIELDS).lean();
      if (!setting) return res.status(404).json({ success: false, message: invalidLink });

      const active = { status: { $ne: false }, deleted: false };
      const bySort = { sort_order: 1, created_date: 1 };
      const now = new Date();

      const [books, categories, sections, items, banners] = await Promise.all([
        BookModel.find(active).select(BOOK_FIELDS).sort(bySort).lean(),
        CategoryModel.find(active).select(CATEGORY_FIELDS).sort(bySort).lean(),
        SectionModel.find(active).select(SECTION_FIELDS).sort(bySort).lean(),
        ItemModel.find(active).select(ITEM_FIELDS).sort(bySort).lean(),
        BannerModel.find({
          ...active,
          $and: [
            { $or: [{ start_date: null }, { start_date: { $exists: false } }, { start_date: { $lte: now } }] },
            { $or: [{ end_date: null }, { end_date: { $exists: false } }, { end_date: { $gte: now } }] },
          ],
        })
          .select(BANNER_FIELDS)
          .sort(bySort)
          .lean(),
      ]);

      // hide sections / items whose category is hidden or deleted
      const categoryIds = new Set(categories.map((c) => String(c._id)));
      const visibleSections = sections.filter((s) => categoryIds.has(String(s.category_id)));
      const sectionIds = new Set(visibleSections.map((s) => String(s._id)));
      const bookIds = new Set(books.map((b) => String(b._id)));
      const visibleItems = items
        .filter((i) => categoryIds.has(String(i.category_id)))
        .map((i) => ({ ...i, book_ids: (i.book_ids || []).filter((b) => bookIds.has(String(b))) }))
        .map((i) => (i.section_id && !sectionIds.has(String(i.section_id)) ? { ...i, section_id: null } : i));

      delete setting._id;
      res.set("Cache-Control", "public, max-age=30");
      res.status(200).json({
        success: true,
        data: {
          setting,
          books,
          categories,
          sections: visibleSections,
          items: visibleItems,
          banners,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
