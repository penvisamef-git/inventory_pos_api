const mongoose = require("mongoose");
const ItemModel = require("./model");
const { PRICE_TYPES } = require("./model");
const CategoryModel = require("../category/model");
const SectionModel = require("../section/model");
const BookModel = require("../book/model");
const getFilteredMongoDB = require("../../../../util/mongo_db/mongoDB_Queries");
const { logActivity } = require("../../../../util/log");
const { checkValidtion, pick, removeEmpty } = require("../../../../util/helper");
const { saveSortOrder } = require("../../../../util/sort_order");
const { can_manage_menu } = require("../../../../util/permission");
const { image_upload } = require("../../../../util/upload_image");
const { uploadBuffer, deleteFile } = require("../../../../util/cloudinary");
const baseRoute = "menu/item";
const imageFolder = "menu";

const FIELDS = [
  "code",
  "category_id",
  "section_id",
  "name_en",
  "name_kh",
  "name_cn",
  "desc_en",
  "desc_kh",
  "desc_cn",
  "book_ids",
  "image",
  "price_type",
  "price",
  "sizes",
  "is_featured",
  "is_available",
  "sort_order",
  "note",
  "status",
];

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  // Log
  const logTitle = "menu_item";
  // Error Content
  const document = "ម្ហូប";

  function updatedText(name) {
    return `${document} ${name} ត្រូវបានកែប្រែ និងរក្សារទុក!`;
  }
  function deletedText(name) {
    return `${document} ${name} ត្រូវបានលុបចេញពីប្រព័ន្ធ!`;
  }
  const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
  const existsText = `កូដ${document}នេះ មាននៅក្នុងប្រព័ន្ធរួចហើយ!`;
  const noDataFound = `មិនមាន${document}នៅក្នុងប្រព័ន្ធ!`;
  const newSave = `${document} ថ្មីត្រូវបានរក្សារទុក!`;
  const noIDFound = "មិនមាន ID ត្រឹមត្រូវ!";
  const noDataUpdate = "មិនមានទិន្នន័យដើម្បីកែប្រែ!";
  const categoryNotFound = "រកមិនឃើញប្រភេទម្ហូប!";
  const sectionNotFound = "រកមិនឃើញផ្នែកម៉ឺនុយនៅក្នុងប្រភេទនេះ!";
  const nameRequired = "សូមបញ្ចូលឈ្មោះ (ខ្មែរ អង់គ្លេស ឬចិន)";
  const bookNotFound = "រកមិនឃើញសៀវភៅម៉ឺនុយ!";
  const priceTypeInvalid = `ប្រភេទតម្លៃមិនត្រឹមត្រូវ! (${PRICE_TYPES.join(" | ")})`;
  const priceInvalid = "សូមបញ្ចូលតម្លៃឱ្យបានត្រឹមត្រូវ!";
  const sizesInvalid = "សូមបញ្ចូលទំហំ និងតម្លៃ ឧ. [{ label: \"S\", price: 8 }]";

  const guardRead = [prop.api_auth, prop.jwt_auth, prop.request_user];
  const guardWrite = [...guardRead, can_manage_menu];

  const displayName = (item) => item.name_en || item.name_kh || item.name_cn || item.code;

  // ******************** Helper ****************************
  const isPrice = (v) => v !== "" && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0;

  // Normalizes price fields in `data` (merged with `current` on update). Returns error text or null.
  function normalizePrice(data, current = {}) {
    const priceType = data.price_type ?? current.price_type ?? "single";
    if (!PRICE_TYPES.includes(priceType)) return priceTypeInvalid;
    data.price_type = priceType;

    if (priceType === "single") {
      const price = data.price !== undefined ? data.price : current.price;
      if (!isPrice(price)) return priceInvalid;
      data.price = Number(price);
      data.sizes = [];
    } else {
      const sizes = data.sizes !== undefined ? data.sizes : current.sizes;
      if (!Array.isArray(sizes) || sizes.length === 0) return sizesInvalid;
      for (const s of sizes) {
        if (!s || !String(s.label || "").trim() || !isPrice(s.price)) return sizesInvalid;
      }
      data.sizes = sizes.map((s) => ({ label: String(s.label).trim(), price: Number(s.price) }));
      data.price = null;
    }
    return null;
  }

  // Checks category + section (section must be inside the category). Returns {status,message} or null.
  async function checkCategoryAndSection(category_id, section_id) {
    if (!mongoose.Types.ObjectId.isValid(category_id)) return { status: 400, message: noIDFound };
    if (!(await CategoryModel.exists({ _id: category_id, deleted: false }))) {
      return { status: 404, message: categoryNotFound };
    }
    if (section_id) {
      if (!mongoose.Types.ObjectId.isValid(section_id)) return { status: 400, message: noIDFound };
      const ok = await SectionModel.exists({ _id: section_id, category_id, deleted: false });
      if (!ok) return { status: 404, message: sectionNotFound };
    }
    return null;
  }

  // book_ids: array of ids (or one id / JSON text) → clean unique ObjectId list. Returns { ids } or { error }.
  async function checkBooks(value) {
    let list = value;
    if (list === null || list === "") list = [];
    if (typeof list === "string") {
      try {
        list = JSON.parse(list);
      } catch {
        list = list.split(",");
      }
    }
    if (!Array.isArray(list)) list = [list];
    const ids = [...new Set(list.map((v) => String(v?._id || v).trim()).filter(Boolean))];
    if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) return { error: { status: 400, message: noIDFound } };
    if (ids.length) {
      const found = await BookModel.countDocuments({ _id: { $in: ids }, deleted: false });
      if (found !== ids.length) return { error: { status: 404, message: bookNotFound } };
    }
    return { ids };
  }

  // Delete an old Cloudinary image (never blocks the response)
  async function removeImage(image) {
    try {
      const baseFolder = process.env.CLOUDINARY_FOLDER || "le_blend";
      if (image?.public_id && String(image.public_id).startsWith(`${baseFolder}/`)) {
        await deleteFile(image.public_id, "image");
      }
    } catch (err) {
      console.error("Failed to delete old image:", err.message);
    }
  }

  const populate = [
    { path: "category_id", select: "code name_en name_kh name_cn type" },
    { path: "section_id", select: "name_en name_kh name_cn style" },
    { path: "book_ids", select: "code name_en name_kh name_cn" },
  ];

  // ===================================== CREATE ================================================
  // JSON body, or form-data with file field "image" (+ the other fields as text, sizes as JSON text)
  prop.app.post(`${urlAPI}`, ...guardWrite, image_upload("image"), async (req, res) => {
    try {
      const requiredFields = [
        { key: "code", label: "កូដម្ហូប (ឧ. 001)" },
        { key: "category_id", label: "ប្រភេទម្ហូប" },
      ];
      if (!checkValidtion(res, req, requiredFields)) return;

      const body = pick(req.body, FIELDS);
      const { user_id: userId } = req.session;

      if (!body.name_en && !body.name_kh && !body.name_cn) {
        return res.status(400).json({ success: false, message: nameRequired });
      }
      if (body.section_id === "") body.section_id = null;

      const priceError = normalizePrice(body);
      if (priceError) return res.status(400).json({ success: false, message: priceError });

      const refError = await checkCategoryAndSection(body.category_id, body.section_id);
      if (refError) return res.status(refError.status).json({ success: false, message: refError.message });

      // ✅ Menu books (optional, many)
      if (body.book_ids !== undefined) {
        const books = await checkBooks(body.book_ids);
        if (books.error) return res.status(books.error.status).json({ success: false, message: books.error.message });
        body.book_ids = books.ids;
      }

      body.code = String(body.code).trim().toUpperCase();
      if (await ItemModel.exists({ code: body.code, deleted: false })) {
        return res.status(409).json({ success: false, message: existsText });
      }

      if (body.sort_order === undefined) {
        body.sort_order = await ItemModel.countDocuments({ category_id: body.category_id, deleted: false });
      }

      // ✅ Upload image last (after all checks, so no orphan images)
      if (req.file) body.image = await uploadBuffer(req.file, imageFolder);
      else if (!body.image?.url) delete body.image;

      const saveData = await ItemModel.create({
        ...body,
        deleted: false,
        created_by: userId,
        updated_by: userId,
      });

      await logActivity({
        title: `${document}ថ្មី ${body.code} ${displayName(saveData)} ត្រូវបានបង្កើត!`,
        description: `បង្កើតដោយគណនី: ${req.user.email}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(201).json({ success: true, data: saveData, message: newSave });
    } catch (err) {
      if (err?.isCloudinary) return res.status(err.status).json({ success: false, message: err.message, error: err.detail });
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET LIST (with filter + pagination) ================================================
  // Extra: ?category_id=<id> &section_id=<id> &book_id=<id> &is_available=true|false &is_featured=true
  // Search: ?q=kuy&q_key=["name_en","name_kh","code"]
  prop.app.get(`${urlAPI}`, ...guardRead, async (req, res) => {
    try {
      const extra = [];
      const { category_id, section_id, book_id, is_available, is_featured } = req.query;
      if (mongoose.Types.ObjectId.isValid(book_id)) {
        extra.push({ book_ids: new mongoose.Types.ObjectId(String(book_id)) });
      }
      if (mongoose.Types.ObjectId.isValid(category_id)) {
        extra.push({ category_id: new mongoose.Types.ObjectId(String(category_id)) });
      }
      if (mongoose.Types.ObjectId.isValid(section_id)) {
        extra.push({ section_id: new mongoose.Types.ObjectId(String(section_id)) });
      }
      if (is_available === "true" || is_available === "false") extra.push({ is_available: is_available === "true" });
      if (is_featured === "true" || is_featured === "false") extra.push({ is_featured: is_featured === "true" });

      const query = { sort: "sort_order", order: "asc", ...req.query };
      const result = await getFilteredMongoDB(query, ItemModel, populate, extra);

      res.status(200).json({ success: true, data: result.data, pagination: result.pagination });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===================================== GET ALL ================================================
  // ?category_id=<id>
  prop.app.get(`${urlAPI}-all`, ...guardRead, async (req, res) => {
    try {
      const filter = { deleted: false };
      if (mongoose.Types.ObjectId.isValid(req.query.category_id)) filter.category_id = req.query.category_id;
      if (mongoose.Types.ObjectId.isValid(req.query.book_id)) filter.book_ids = req.query.book_id;

      const result = await ItemModel.find(filter).sort({ sort_order: 1, created_date: 1 });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
  });

  // ===================================== SORT (drag & drop) ================================================
  prop.app.put(`${urlAPI}-sort`, ...guardWrite, async (req, res) => {
    try {
      const result = await saveSortOrder(ItemModel, req.body?.items, req.session.user_id);
      if (!result.ok) return res.status(400).json({ success: false, message: result.message });
      res.status(200).json({ success: true, data: result, message: "លំដាប់ត្រូវបានរក្សារទុក!" });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== GET BY ID ================================================
  prop.app.get(`${urlAPI}/:id`, ...guardRead, async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const data = await ItemModel.findOne({ _id: id, deleted: false }).populate(populate);
      if (!data) return res.status(404).json({ success: false, message: noDataFound });

      return res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: "Internal Error", error: err.message });
    }
  });

  // ===================================== AVAILABILITY (quick sold-out toggle) ================================================
  // body: { is_available: true | false }
  prop.app.put(`${urlAPI}/availability/:id`, ...guardWrite, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }
      if (typeof req.body?.is_available !== "boolean") {
        return res.status(400).json({ success: false, message: "សូមបញ្ចូល is_available (true | false)" });
      }

      const updatedData = await ItemModel.findOneAndUpdate(
        { _id: id, deleted: false },
        { is_available: req.body.is_available, updated_by: userId },
        { returnDocument: "after" },
      );
      if (!updatedData) return res.status(404).json({ success: false, message: noDataFound });

      await logActivity({
        title: `${document} ${displayName(updatedData)} ${updatedData.is_available ? "មានលក់" : "អស់ពីស្តុក"}`,
        description: `គណនី: ${req.user.email}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: updatedData, message: updatedText(displayName(updatedData)) });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== UPDATE ================================================
  // JSON body, or form-data with a new file in "image" (old image is deleted from Cloudinary)
  // Remove image: send image = "" or null
  prop.app.put(`${urlAPI}/:id`, ...guardWrite, image_upload("image"), async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const body = pick(req.body, FIELDS);
      const clearSection = body.section_id === "" || body.section_id === null;
      const clearImage = !req.file && (body.image === "" || body.image === null);
      if (body.image !== undefined && !body.image?.url) delete body.image;
      const updateFields = removeEmpty({ ...body, updated_by: userId });
      if (clearSection) updateFields.section_id = null;
      if (clearImage) updateFields.image = null;
      if (req.file) updateFields.image = "(new file)"; // placeholder so the empty-update check passes

      if (Object.keys(updateFields).length === 1) {
        return res.status(400).json({ success: false, message: noDataUpdate });
      }

      const current = await ItemModel.findOne({ _id: id, deleted: false });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });

      // ✅ Name: keep at least one
      const nameEn = updateFields.name_en !== undefined ? updateFields.name_en : current.name_en;
      const nameKh = updateFields.name_kh !== undefined ? updateFields.name_kh : current.name_kh;
      const nameCn = updateFields.name_cn !== undefined ? updateFields.name_cn : current.name_cn;
      if (!nameEn && !nameKh && !nameCn) return res.status(400).json({ success: false, message: nameRequired });

      // ✅ Price (only when price fields are sent)
      if (["price_type", "price", "sizes"].some((k) => updateFields[k] !== undefined)) {
        const priceError = normalizePrice(updateFields, current);
        if (priceError) return res.status(400).json({ success: false, message: priceError });
      }

      // ✅ Menu books ([] or "" removes the item from every book)
      if (body.book_ids !== undefined) {
        const books = await checkBooks(body.book_ids);
        if (books.error) return res.status(books.error.status).json({ success: false, message: books.error.message });
        updateFields.book_ids = books.ids;
      }

      // ✅ Category / section
      if (updateFields.category_id !== undefined || updateFields.section_id !== undefined) {
        const categoryId = updateFields.category_id ?? current.category_id;
        let sectionId = updateFields.section_id !== undefined ? updateFields.section_id : current.section_id;
        // Moving to another category without a new section → drop the old section
        if (
          updateFields.category_id !== undefined &&
          updateFields.section_id === undefined &&
          String(categoryId) !== String(current.category_id)
        ) {
          sectionId = null;
          updateFields.section_id = null;
        }
        const refError = await checkCategoryAndSection(categoryId, sectionId);
        if (refError) return res.status(refError.status).json({ success: false, message: refError.message });
      }

      // ✅ Code
      if (updateFields.code !== undefined) {
        updateFields.code = String(updateFields.code).trim().toUpperCase();
        const exists = await ItemModel.exists({ code: updateFields.code, deleted: false, _id: { $ne: id } });
        if (exists) return res.status(409).json({ success: false, message: existsText });
      }

      // ✅ Upload the new image last (after all checks)
      if (req.file) updateFields.image = await uploadBuffer(req.file, imageFolder);

      const updatedData = await ItemModel.findOneAndUpdate({ _id: id, deleted: false }, updateFields, {
        returnDocument: "after",
        runValidators: true,
      });

      // ✅ Old image replaced or removed → delete it from Cloudinary
      const imageChanged = updateFields.image !== undefined && current.image?.public_id !== updatedData.image?.public_id;
      if (imageChanged) await removeImage(current.image);

      delete updateFields.updated_by;
      await logActivity({
        title: `${document} ${displayName(updatedData)} ត្រូវបានកែប្រែ!`,
        description: `គណនី: ${req.user.email} បានកែប្រែព័ត៌មានដូចជា : ${JSON.stringify(updateFields)}`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: updatedData, message: updatedText(displayName(updatedData)) });
    } catch (err) {
      if (err?.isCloudinary) return res.status(err.status).json({ success: false, message: err.message, error: err.detail });
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== SOFT DELETE ================================================
  prop.app.delete(`${urlAPI}/:id`, ...guardWrite, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const updatedData = await ItemModel.findOneAndUpdate(
        { _id: id, deleted: false },
        { deleted: true, updated_by: userId },
        { returnDocument: "after" },
      );
      if (!updatedData) return res.status(404).json({ success: false, message: noDataFound });

      await logActivity({
        title: `${document} ${displayName(updatedData)} ត្រូវបានលុប!`,
        description: `គណនី: ${req.user.email} បានលុបទិន្នន័យចេញពីប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({
        success: true,
        data: `${document} ${displayName(updatedData)} បានលុប`,
        message: deletedText(displayName(updatedData)),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== RESTORE ================================================
  prop.app.put(`${urlAPI}/restore/:id`, ...guardWrite, async (req, res) => {
    try {
      const { id } = req.params;
      const { user_id: userId } = req.session;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: noIDFound });
      }

      const current = await ItemModel.findOne({ _id: id, deleted: true });
      if (!current) return res.status(404).json({ success: false, message: noDataFound });

      if (await ItemModel.exists({ code: current.code, deleted: false })) {
        return res.status(409).json({ success: false, message: existsText });
      }
      const refError = await checkCategoryAndSection(current.category_id, current.section_id);
      if (refError) return res.status(refError.status).json({ success: false, message: refError.message });

      current.deleted = false;
      current.updated_by = userId;
      await current.save();

      await logActivity({
        title: `${document} ${displayName(current)} ត្រូវបានស្តារឡើងវិញ!`,
        description: `គណនី: ${req.user.email} បានស្តារទិន្នន័យចូលក្នុងប្រព័ន្ធ។`,
        categoryTitle: logTitle,
        createdBy: userId,
        req,
      });

      res.status(200).json({ success: true, data: current, message: `${document} ${displayName(current)} បានស្តារឡើងវិញ!` });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
