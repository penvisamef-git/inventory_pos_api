# Inventory POS API (Cloud)

Node.js + Express + MongoDB (Mongoose) + Cloudinary.
Cloud API for the Inventory + Warehouse + POS system (baby & kid products).
Same structure as the SDMS / Le Blend API.

- **Cloud API (this repo)** — master data, warehouses, stock, purchase, transfer, reports, POS sync.
- **Local POS API (later)** — runs on each shop PC, sells offline, syncs with this API.

## Setup

```bash
npm install
# .env: MONGO_*, API_AUTH_KEY, JWT_SECRET, CLOUDINARY_*, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD
npm run seed              # API key, first super admin, setting, payment methods, first rate (safe to run again)
npm run dev               # http://localhost:8086
node scripts/cloudinary-check.js   # test Cloudinary
```

## Headers

Every request:

```
x-api-key: <API_AUTH_KEY>
```

Every request after login:

```
Authorization: Bearer <access_token>
```

## Response format

```json
{ "success": true, "data": {}, "message": "...", "pagination": { "total": 0, "totalPages": 0, "currentPage": 1, "pageSize": 10 } }
```

Errors: `{ "success": false, "message": "<Khmer>", "error": "..." }` — 400 validation · 401 login · 403 permission · 404 not found · 409 duplicate · 500 server.

## List query (all `GET /x` list routes)

| Param | Example | Meaning |
|---|---|---|
| `page`, `limit` | `page=1&limit=20` | Pagination (max 200) |
| `sort`, `order` | `sort=sort_order&order=asc` | Sorting |
| `q`, `q_key` | `q=romper&q_key=["name_en","name_kh","code"]` | Keyword search |
| `q_id`, `q_key_id` | `q_id=["<id>"]&q_key_id=["category_id"]` | Filter by ids |
| `includeDeleted` | `true` | Include soft-deleted rows |

## Standard routes per module

`POST /x` create · `GET /x` list · `GET /x-all` dropdown · `GET /x/:id` · `PUT /x/:id` · `DELETE /x/:id` (soft) · `PUT /x/restore/:id` · `PUT /x-sort` (drag & drop, where it has `sort_order`)

## Roles & data scope

| Role (`user.role`) | Scope | Can do |
|---|---|---|
| Super admin (`is_super_admin`) | all | Everything |
| `អ្នកគ្រប់គ្រងប្រព័ន្ធ` (admin) | all | Everything: users, setup, Telegram, all warehouses |
| `អ្នកគ្រប់គ្រងឃ្លាំងកណ្តាល` (central warehouse manager) | all | Products, prices, purchase, transfers, stock, all reports |
| `គណនេយ្យករ` (accountant) | all | View sales, cost, stock value |
| `អ្នកគ្រប់គ្រងហាង` (shop manager) | own | Own shop: dashboard, sales, shifts, stock, receive transfer |
| `អ្នកគិតលុយ` (cashier) | own | POS only (no admin web) |

Scope `own` = only the warehouses in `user.warehouse_ids`, applied by `src/util/warehouse_scope.js`.

## Code structure

```
index.js                         Express app, middleware, 404 / error handler
src/util/                        shared helpers
  api_auth.js  jwt_auth.js  request_user.js   → guard: [api_auth, jwt_auth, request_user, <permission>]
  permission.js                  allow_roles(...), can_manage_users / setup / product, can_view_master / all
  user_roles.js                  fixed roles + scope
  warehouse_scope.js             req.warehouse_filter, scopeFilter(), canAccessWarehouse()
  counter.js                     nextNo("TR") → TR-2610-0001
  helper.js                      checkValidtion, sanitizeUpdate, removeEmpty, round, codeExists, cambodiaDate
  log.js + activity_log_type.js  logActivity({ title, description, categoryTitle, createdBy, req })
  mongo_db/mongoDB_Queries.js    getFilteredMongoDB(query, Model, populate, additionalFilter)
  cloudinary.js  upload_image.js  image.schema.js  sort_order.js
src/v1/admin/<module>/           <module>.route.js + <module>.model.js
```

## Endpoints — `/api/admin`

### Auth
| Method | Path | Body |
|---|---|---|
| POST | `/auth/login` | `{ email, password }` → `data.access_token`, `data.is_first_login` |
| GET | `/auth/me` | |
| POST | `/auth/logout` | |
| PUT | `/auth/change-password` | `{ old_password, new_password }` |

### Users (admin)
`POST /users`, `GET /users`, `GET /users-all`, `GET /users-roles`, `GET /users/:id`, `PUT /users/:id`,
`PUT /users/reset-password/:id` `{ password }`, `PUT /users/pos-pin/:id` `{ pos_pin: "1234" | null }`, `DELETE /users/:id`, `PUT /users/restore/:id`

Create body: `{ firstname, lastname, email, password, role, warehouse_ids?, contact?, job_title?, note?, status? }`
- `GET /users-roles` → `[{ value, label_kh, label_en, scope }]`.
- Shop manager / cashier (scope `own`): `warehouse_ids` required, 1+ **shop** warehouses. Central roles: saved as `[]`.
- List filters: `?warehouse_id=&role=`. Rows include `warehouse_ids` (code, name) and `has_pos_pin`.
- `pos_pin`: 4–6 digits, bcrypt hash, never returned (login, me, users all hide it).

### Session / Activity log (admin)
`GET /session`, `DELETE /session/:id` (force logout), `GET /activity_log?category=product`, `GET /activity_log/category-all`

- **Who sees the activity log** (`GET /activity_log`, any signed-in user): super admin → every row · admin → every row except super admins' · any other role → only their own rows (`scope: "own"` in the answer). Sessions stay admin only.
- **Super admins leave no trace here:** their logins and changes are not written to the activity log, older rows of theirs are hidden from the list, their sessions are not listed and can't be force-logged-out (super admin ids are cached 60 s).

### Upload (admin, central warehouse manager)
| Method | Path | Body |
|---|---|---|
| POST | `/upload` | form-data: `files` (1–10 images, 4MB each), `folder` = `product` \| `category` \| `brand` \| `setting` \| `others` |
| GET | `/upload/signature?folder=product` | Signed direct upload from the browser |
| DELETE | `/upload` | `{ public_id }` |

The upload returns image objects `{ url, public_id, width, height, ... }` → save one as `image` / `logo`.

### Warehouse — `/setup/warehouse`
View: admin, central manager, accountant, shop manager (own shops only) · Edit: admin.
`POST`, `GET` (list, `?type=central|shop`), `GET -all`, `PUT -sort`, `GET /:id`, `PUT /:id`, `DELETE /:id`, `PUT /restore/:id`

```json
{ "code": "PP01", "name_kh": "ហាង ភ្នំពេញ ០១", "name_en": "Phnom Penh Shop 01", "type": "shop",
  "address": "ភ្នំពេញ", "phone": "012345678", "manager_id": "<user id>", "allow_negative_stock": true }
```
- `code` is saved UPPERCASE and is also the POS receipt prefix.
- `allow_negative_stock` defaults: shop `true`, central `false`. `manager_id: null` removes the manager.
- Delete is blocked while users are linked (later also while it has stock or a POS device).

### Setting — `/setup/setting` (view: all web roles · edit: admin)
`GET`, `PUT` `{ company_name_kh, company_name_en, logo, address, phone, email, vat_no, khr_rounding, tax_mode: none|inclusive|exclusive, tax_rate, tax_name, receipt_header, receipt_footer, low_stock_default, expiry_alert_days }`

Setting also has `ui_theme`: `forest | ocean | candy | navy` (admin web look for everyone). `GET /setup/theme` → `{ ui_theme }` needs only the API key (login page).

### Exchange rate — `/setup/exchange-rate` (view: all web roles · edit: admin)
`POST { rate, effective_from, note }`, `GET` (history, rows have `state: current|upcoming|past`), `GET /current`, `GET /:id`, `PUT /:id`, `DELETE /:id`
- Active rate = newest `effective_from` ≤ now. Past date on create = starts now.
- Only **upcoming** rates can be edited / deleted. Started rates are locked (old invoices use them).

### Payment method — `/setup/payment-method` (view: all web roles · edit: admin)
Standard routes + `-all`, `-sort`. `{ code, name_kh, name_en, type: cash|qr|card|bank, currency: USD|KHR|any, requires_reference, online_mode, icon, sort_order }`
- `code`: a-z 0-9 _ (saved lowercase). Seeded: `cash_usd`, `cash_khr`, `khqr`, `aba`.

### Unit — `/product/unit` (view: all web roles · edit: admin, central manager)
Standard routes + `-all`, `-sort`. `{ code, name_kh, name_en, note, status }`
- `code`: a-z 0-9 _ (1–20, saved lowercase), e.g. `pcs`, `pack`, `box`. Conversion (1 box = 12 pcs) is set per product later.

### Category — `/product/category` (view: all web roles · edit: admin, central manager)
Standard routes + `-all`, `-sort`, `GET /product/category-tree`. `{ code, name_kh, name_en, parent_id, image, note, status }`
- List filter `?parent_id=<id>` or `?parent_id=root`; each row has `child_count`.
- A category cannot be its own parent or move under its own child. Delete is blocked while it has children.

### Attribute — `/product/attribute` (view: all web roles · edit: admin, central manager)
Standard routes + `-all`, `-sort`. Used to build product variants (size × color).
```json
{ "code": "size", "name_kh": "ទំហំ", "name_en": "Size", "type": "size",
  "values": [ { "code": "0-3m", "name_kh": "0-3 ខែ", "name_en": "0-3 months", "color_hex": null, "sort_order": 1, "status": true } ] }
```
- `type`: size | color | other. Value `code`: a-z 0-9 _ - ; `color_hex` `#RRGGBB` for colors.
- Send existing values with their `_id` when updating so variants keep pointing to them.

### Brand — `/product/brand` (view: all web roles · edit: admin, central manager)
Standard routes + `-all`, `-sort`. `{ code, name_kh, name_en, logo, note, status }` · delete blocked while products use it.

### Product + variants — `/product/item` (view: all web roles · edit: admin, central manager)
**Product** = the style (Cotton romper). **Variant** = the sellable SKU (Cotton romper 0-3M / Pink). Stock, price, batch and invoice lines will point to a **variant**. A simple product (no `attribute_ids`) has one default variant whose SKU = product code.

| Method | Route | |
|---|---|---|
| `POST` | `/product/item` | product + `variants[]` in one transaction |
| `GET` | `/product/item` | list · `?q=` (code, name, **SKU, barcode**) `&category_id=` (with sub-categories) `&brand_id=&attribute_id=&track_batch=&status=` |
| `GET` | `/product/item-all` | dropdown |
| `PUT` | `/product/item-sort` | drag & drop |
| `GET` | `/product/item/barcode/:barcode` | scan → `{ product, variant, unit: { unit_id, code, factor, is_base } }` (base barcode, bigger-unit barcode, or SKU) |
| `GET` | `/product/item/check-code?value=&product_id=` | form helper → `{ product_code, sku, barcode }` each `{ free, used_by }` |
| `GET` | `/product/item/:id` | product + `variants[]` |
| `PUT` | `/product/item/:id` | send only what changes; `variants` (when sent) is the **full list**: with `_id` = update, without = new, missing = deleted |
| `DELETE` / `PUT restore` | `/product/item/:id` · `/product/item/restore/:id` | product and its variants together |
| `GET` | `/product/variant` · `/product/variant/:id` | flat SKU list `?q=&product_id=&category_id=&status=` (product populated) |

```json
{
  "code": "DIAPANT01", "name_kh": "កន្ទបខោ Pampers", "name_en": "Pampers pants",
  "category_id": "<id>", "brand_id": "<id>",
  "base_unit_id": "<pack id>",
  "units": [ { "unit_id": "<box id>", "factor": 4, "is_sale_unit": true, "is_purchase_unit": true } ],
  "attribute_ids": ["<diaper_size id>"],
  "variants": [
    { "options": [ { "attribute_id": "<diaper_size id>", "value_id": "<M value id>" } ],
      "code": "DIAPANT01-M", "barcode": "2000000040011",
      "unit_barcodes": [ { "unit_id": "<box id>", "barcode": "2000000040028" } ],
      "min_stock": null, "status": true }
  ],
  "track_stock": true, "track_batch": false, "min_stock": 10, "allow_discount": true, "is_taxable": true, "image": null
}
```
- Product code and SKU: `A-Z 0-9 _ -`, saved UPPERCASE. SKU is optional → auto `PRODUCTCODE-VALUE-VALUE`.
- Every barcode (base + bigger units, all variants of all products) is unique. A variant can only have a barcode for a unit the product has.
- Each variant needs exactly one value per attribute; no two variants with the same combination. Max 3 attributes, 300 variants.
- Variant names are built from the product name + option names (`Cotton romper (0-3M / Pink)`) and refreshed when the product is saved.
- `min_stock` on a variant = override; `null` uses the product's `min_stock`.
- Delete blocked: unit / category / brand / attribute while a product uses it; an attribute **value** while a variant uses it (turn its status off instead).
- Phase 2 (stock) will lock `base_unit_id`, used unit factors and `track_batch`, and block deleting a product / variant that has stock.

### Price — `/product/price` (view: all web roles, shop manager = default + own shops · edit: admin, central manager)
Sale price in USD per **variant + unit**, with history. `warehouse_id: null` = default for every shop; a shop id = special price for that shop.

| Method | Route | |
|---|---|---|
| `POST` | `/product/price` | `{ variant_id, unit_id?, warehouse_id?, price, effective_from? }` |
| `POST` | `/product/price/bulk` | `{ effective_from?, items: [ ...same ] }` — all or nothing, max 500 |
| `GET` | `/product/price/current` | grid: per variant → per sale unit `{ default, default_next, shops[], price?, source? }` · `?product_id=&variant_id=&category_id=&q=&warehouse_id=` (with a shop: `price` + `source: shop \| default`) · paginated over variants (≤ 200) |
| `GET` | `/product/price` | history `?variant_id=&product_id=&unit_id=&warehouse_id=<id \| default>&state=current\|upcoming\|past` |
| `DELETE` | `/product/price/:id` | only a price that has not started yet |

- No update: a change is always a new row. The previous row gets `effective_to` = new start, so history never overlaps. A price inserted between two rows ends where the next one starts.
- `effective_from` missing or in the past = now (sold invoices already used the old price). Same start time in the same chain → 409.
- `unit_id` missing = base unit; must be the base unit or a **sale** unit of the product. Price ≥ 0, 4 dp.
- Shop price: `warehouse_id` must be a shop (not central). `price: null` = that shop goes back to the default from that date.
- Deleting an upcoming row gives its period back to the previous row.
- Product list rows have `price_range: { min, max, count }` (current default base-unit price; `count` < `variant_count` → some variants have no price yet).

### Product Excel import — `/product/import` (admin, central manager)
| Method | Route | |
|---|---|---|
| `POST` | `/product/import` | `{ rows: [{ _row, product_code, name_kh, … }], apply: false \| true }` → `{ summary: { products, create, update, error, variants, prices }, results: [{ product_code, rows, action: create\|update\|error, message, variants, prices }] }` · ≤ 2000 rows per call |
| `GET` | `/product/import/export` | every product as import rows (today's default prices) + `columns` |
| `GET` | `/product/import/lists` | `columns` + category / brand / unit codes + options (`size=0_3m`) for the template |

Columns: `product_code, name_kh, name_en, category, brand, base_unit, track_batch, min_stock, option_1..3 (attr=value), sku, barcode, unit_2, unit_2_factor, unit_2_barcode, price, unit_2_price`.
- One row = one SKU; rows with the same `product_code` = one product. **Create + update by code**; a blank cell keeps the current value; import **never deletes** variants or prices.
- `apply: false` = preview (nothing saved). Each product is checked and saved on its own: one bad product doesn't stop the others. Duplicate barcode / SKU in the file stops every product involved.
- A price row is added only when the price changed (history kept, starts now). `unit_2` with a price becomes a sale unit. Locks from Phase 2 still apply (base unit / batch / factors of products with stock).

## Stock (Phase 2)

Stock is counted per **variant × warehouse**, always in the product's **base unit**. Every in / out is a row in `StockMovement` (append-only ledger with `balance_after`, `avg_cost_after`); `StockBalance` / `StockBatchBalance` are caches updated in the same transaction.

- **Cost:** moving average per warehouse. IN: `(qty × avg + in_qty × in_cost) / (qty + in_qty)` (when stock ≤ 0 the average becomes the in cost). OUT always at the current average. Transfers carry the source average to the shop.
- **Batches (track_batch):** `Batch` = variant + batch_no + expiry. OUT uses **FEFO** (nearest expiry first; expired batches skipped for transfers, included for adjustments) unless a `batch_id` is given.
- **Negative stock:** only POS sales in a shop (Phase 3). Transfers and adjustments can never go below 0.
- **Locks:** once a product has movements its base unit, batch tracking and existing unit factors are locked; a product / variant with stock ≠ 0 cannot be deleted; a warehouse with movements cannot be deleted or change type.
- **Documents** (all: `POST` draft · `GET` list `?state=&warehouse_id=&from=&to=&q=` · `GET /:id` · `PUT /:id` draft · `PUT /cancel/:id` · `PUT /post/:id`). Items accept `variant_id` **or** `sku` (SKU / barcode) and `unit_id` **or** `unit` (code); `unit_cost` is per the chosen unit.

| Document | Route | No. | Who | Notes |
|---|---|---|---|---|
| Opening stock | `/stock/opening` | OB-yymm-0001 | admin, central | cost required, batch + expiry for batch products; Excel import in the admin |
| Goods receive | `/stock/receive` | GR-… | admin, central (view: + accountant) | **central warehouse only**; `supplier_id`, `supplier_invoice_no` |
| Adjustment | `/stock/adjustment` | ADJ-… | shop manager drafts (own shop) → admin / central post | `reason`: damaged · expired · lost (OUT) · found (IN) · other (±) · transfer_shortage, stock_count (system) |
| Transfer | `/stock/transfer` | TR-… | see below | states `requested → (draft) → dispatched → received`, `cancelled` |

Transfer: shop manager `POST` = **request** from central to own shop (`requested_items` kept); central edits quantities and `PUT /dispatch/:id` (transfer_out, FEFO, average cost) → in transit → shop `PUT /receive/:id { items: [{ _id, received_qty }] }` (transfer_in; less than sent → auto-posted `transfer_shortage` adjustment = loss at once; more than sent → 400).

Stock count (blind) — `/stock/count` · SC-yymm-0001 · shop manager (own shops) or central counts, **admin / central posts**:

| Method | Route | |
|---|---|---|
| `POST` | `/stock/count` | `{ warehouse_id, category_id?, note }` → every active SKU (batch SKUs: one line per batch in stock) · 409 if the warehouse has an open count |
| `GET` | `/stock/count` · `/stock/count/:id` | list (no lines) `?state=&warehouse_id=&q=` · one with lines |
| `PUT` | `/stock/count/:id` | while counting: `{ counts: [{ _id, counted_qty\|null, batch_no?, expiry_date?, note? }], add: [{ sku\|barcode\|variant_id, counted_qty, batch_no?, expiry_date? }] }` |
| `PUT` | `/stock/count/submit/:id` | `{ uncounted: skip \| zero }` → system qty taken **now**, differences computed |
| `PUT` | `/stock/count/reopen/:id` | central: back to counting |
| `PUT` | `/stock/count/post/:id` | central: one **adjustment** (`reason: stock_count`, `count_id`) with the differences, posted at once; `diff_cost` stored |
| `PUT` | `/stock/count/cancel/:id` | counting / submitted → cancelled |

- Blind: `expected_qty` is empty while counting. Always in the base unit. Shop managers never get `unit_cost` / `diff_cost`.
- `stock_count` adjustments can't be edited by hand (like `transfer_shortage`).

Views (shop manager: own shops, **no cost fields**):

| Route | |
|---|---|
| `GET /stock/balance` | per variant: qty per warehouse, avg cost, value, `low` (shop qty ≤ min stock), summary · `?warehouse_id=&category_id=&product_id=&q=&only=low\|negative\|in_stock\|out` |
| `GET /stock/movement` | ledger · `?warehouse_id=&variant_id=&product_id=&batch_id=&type=&ref_type=&from=&to=` |
| `GET /stock/expiry` | batches expiring within `?days=` (default Setting.expiry_alert_days) |
| `GET /stock/availability` | `?warehouse_id=&variant_ids=a,b` → qty + batches (forms) |
| `GET /stock/fefo` | `?warehouse_id=&variant_id=&qty=` → suggested batches |

### Supplier — `/purchase/supplier` (view: web roles · edit: admin, central manager)
Standard routes. `{ code, name, contact_name, phone, email, address, vat_no, payment_term_days }` · delete blocked while goods receives use it.

## Shop portal API — `/shop` (admin, central manager: any warehouse · shop manager: own shops · accountant / cashier: no)

| Method | Route | |
|---|---|---|
| `GET` | `/shop/summary?warehouse_id=` | one warehouse at a glance: `stock { skus, qty, value*, low, out, negative }`, `expiry`, `transfers { incoming, requested, outgoing_pending }`, `adjustments.drafts`, `staff`, + top lists (low, expiring, incoming / requested transfers). `sales` comes in Phase 3. *value: central roles only |
| `GET` | `/shop/staff?warehouse_id=` | everyone linked to the warehouse |
| `POST` | `/shop/staff` | new **cashier** `{ warehouse_id (shop), firstname, lastname, email, contact, password ≥ 8, pos_pin? }` |
| `PUT` | `/shop/staff/:id` | `{ firstname, lastname, contact, job_title, status }` |
| `PUT` | `/shop/staff/reset-password/:id` · `/shop/staff/pos-pin/:id` | `{ password }` · `{ pos_pin: "1234" \| null }` |

- Staff routes only touch **cashiers** of a warehouse the caller may open; managers and other roles stay in the admin web (`/users`, admin only).
- Stock screens of the portal use the normal stock routes with `warehouse_id`; `GET /stock/balance?warehouse_id=&with_price=true` adds `price` / `price_source` (shop | default) of the base unit.

## Telegram — `/telegram` (admin only)

Bots from @BotFather → groups / chats (each linked to **one** bot) → event messages + scheduled reports. Message text is Khmer, English or both, per chat.

| Method | Route | |
|---|---|---|
| `GET` | `/telegram/events` | `{ events, reports, languages }` for the web (event: `code, group, phase, name_kh, name_en`) |
| `POST` | `/telegram/bot` | `{ name, token, is_default, note }` — token checked with `getMe`, stored **AES-256-GCM encrypted**, never returned (`token_hint` only) |
| `GET` | `/telegram/bot` | all bots + `chat_count` |
| `PUT` / `DELETE` | `/telegram/bot/:id` | `{ name, token? (replace, same bot only), is_default, status, note }` · delete blocked while chats use it |
| `POST` | `/telegram/bot/test/:id` | `getMe` now → ok / `last_error` |
| `GET` | `/telegram/bot/chats/:id` | **Find chats**: groups / channels / people that wrote to the bot recently (`getUpdates`) + `already_added` |
| `GET` `POST` `PUT` `DELETE` | `/telegram/chat`, `/telegram/chat-all`, `/telegram/chat/:id` | `{ bot_id, chat_id (-100… or @channel), title, type, language: kh \| en \| both, warehouse_ids ([] = all), event_codes }` · list `?bot_id=` |
| `POST` | `/telegram/chat/test/:id` | send a test message now |
| `GET` | `/telegram/template` | every event: default + current text, `custom`, `placeholders` |
| `PUT` / `DELETE` | `/telegram/template/:code` | `{ template_kh, template_en }` · delete = back to the default text |
| `POST` | `/telegram/template/preview` | `{ template_kh, template_en }` → filled with sample data |
| `GET` `POST` `PUT` `DELETE` | `/telegram/schedule`, `/telegram/schedule/:id` | `{ name, chat_ids, report_codes, warehouse_ids ([] = the chat's), times: ["08:00"], days: [0..6] (0 = Sunday) }` — Cambodia time |
| `POST` | `/telegram/schedule/send/:id` | **Send now** → `{ queued, sent }` |
| `GET` | `/telegram/report/preview?code=&warehouse_ids=a,b&language=&category_id=&days=&limit=` | the text a report would send now (admin, central manager) |
| `GET` | `/telegram/targets` | **one-click send** (admin, central manager): active groups (`title, language, warehouses, bot`) + reports |
| `POST` | `/telegram/send` | **one-click send** `{ chat_ids, report_codes, warehouse_ids ([] = each group's), category_id?, days?, limit? (50), text? (own message) }` → sent right away `{ queued, sent, failed }`, sender name added, activity log |
| `GET` | `/telegram/message?state=pending\|sent\|failed&code=&chat_ref=` | queue / log + `counts` per state |
| `PUT` | `/telegram/message/retry/:id` | failed / pending → send again |

- **Events** (Phase 2): `transfer_requested`, `transfer_dispatched`, `transfer_received`, `transfer_shortage`, `adjustment_waiting` (shop draft), `adjustment_posted`, `goods_received`, `price_changed`, `staff_changed`. Phase 3 (POS): `pos_login` (attendance), `shift_open`, `shift_close`, `invoice_void`, `pos_offline`. A chat gets an event when the code is in `event_codes` and the warehouse matches.
- **Reports**: `stock_summary`, `low_stock`, `near_expiry`, `pending_work`; Phase 3: `daily_sales`, `attendance`. Low stock / near expiry list item name + SKU. Texts over Telegram's 4096 limit are split into parts (1/2, 2/2).
- Messages go to a queue (`TelegramMessage`); a worker sends every 10 s and runs schedules every minute. Failures retry with back-off (30 s × 2ⁿ, 6 tries); 400 / 401 / 403 from Telegram fail at once. Saving a document never waits for Telegram.
- Env (optional): `TELEGRAM_TOKEN_KEY` — key for the token encryption (falls back to `JWT_SECRET`; changing it means re-entering bot tokens) · `TELEGRAM_WORKER=off` — no worker (e.g. a second instance) · `TELEGRAM_API_BASE` — tests only.
- Connect: @BotFather → `/newbot` → copy token → add bot in the web → add the bot to the Telegram group and send a message there (`/start@yourbot`) → **Find chats** → Add.

## QR code / public catalog — `/catalog` (links: admin, central manager · page: no login)

| Method | Route | |
|---|---|---|
| `GET` | `/catalog` | links `?q=&warehouse_id=` (token, status, views, last_viewed_at) |
| `POST` | `/catalog` | `{ name, warehouse_id, category_id?, note }` → random 12-character `token` |
| `PUT` | `/catalog/:id` | `{ name?, warehouse_id?, category_id?, status?, note? }` — `status: false` turns the link off |
| `PUT` | `/catalog/new-token/:id` | new token: the old URL / printed QR stops at once |
| `DELETE` | `/catalog/:id` | soft delete |
| `GET` | `/catalog/public/:token` | **no login** (API key only) · `?q=&category_id=&only=in_stock&page=&limit=` (≤ 60) |

Public answer: `{ company, store, link, categories [{ _id, name, count }], total_items, in_stock, items, pagination }`; each item `{ name, image, brand, category, unit, status, price_min, price_max, variants [{ code, options, price, status }] }`.
- Stock is a **status only**: `in`, `low` (qty ≤ min stock), `out` (≤ 0); products that don't track stock are always `in`. Never qty, cost or barcode.
- **All active items** are listed, in-stock first, out-of-stock last. Price = the shop's price, else the default (base unit); none = "ask for price".
- Categories are the top categories (sub-categories roll up); a link with `category_id` shows only that branch.
- The heavy part is cached **60 s per link** in the server (price is read fresh per page). A visit (page 1, no filter) adds 1 to `views`.
- Off / deleted / unknown token → 404.

## Notes — `/note` (every signed-in user)

| Method | Route | |
|---|---|---|
| `GET` | `/note` | own notes, pinned first then newest · `?q=&pinned=true&page=&limit=` (≤ 200) · super admin: everyone's (`scope: "all"`, `?user_id=` one person) |
| `GET` | `/note/owners` | super admin: people with notes + count |
| `GET` | `/note/:id` | |
| `POST` | `/note` | `{ title, body, color, pinned }` — always the caller's own note; title or body required, body ≤ 20,000 characters |
| `PUT` | `/note/:id` | any of the same fields |
| `DELETE` | `/note/:id` | soft delete |

`color`: default · yellow · green · blue · pink · purple. Someone else's note → 404 (also for admins); only a super admin can read, edit or delete every note (the owner stays the same). Notes are private: nothing about them is written to the activity log.

## Speed

- `vercel.json` → `regions: ["sin1"]` (Singapore, same region as the Atlas cluster AP_SOUTHEAST_1).
- Auth: API key + session + user are cached in memory (`src/util/auth_cache.js`, 30 s, cleared by User / Session model hooks) → protected requests make 0 extra DB calls.
- Every response has `Server-Timing: app;dur=…, db;desc="N calls"`; requests > 500 ms are logged with their DB call count (`src/util/db_timing.js`).
- `GET /dashboard/summary` — everything the dashboard home needs in one request.
- `GET /health` (no key, no data) → `{ ok, db, ms }` — for an uptime service (e.g. cron-job.org every 5 min) so the free Vercel function stays warm.

## Global search — `GET /search?q=&limit=5` (web roles)

`{ products, skus, warehouses, documents, suppliers, categories, brands, users }` — at least 2 characters; all groups run in parallel. Same rules as each list: shop managers only their shops (warehouses, transfers either side, adjustments, opening), goods receive only central roles, users only admin. A barcode / exact SKU is sorted first.

## Security

- **Login limit** (`src/util/login_guard.js`): 8 wrong passwords per email or 30 per IP in 15 min → `429` "wait N minutes" (also for change-password). Counted in MongoDB, so it holds on every Vercel instance; a correct login clears the email's counter. Env: `LOGIN_MAX_FAILS`, `LOGIN_MAX_FAILS_IP`, `LOGIN_WINDOW_MIN`.
- **CORS**: browsers may call the API only from `https://inventory-pos-kh.web.app`, `https://inventory-pos-kh.firebaseapp.com` and localhost. Another domain (custom domain, POS app …): `CORS_ORIGINS="https://a.com,https://b.com"`. Postman / server-to-server calls are not affected.
- **Test data can't reach real data**: `npm run seed:sample` and `npm test` stop unless `MONGO_DB` contains uat / test / dev / sample / demo / staging (`scripts/lib/test_db_guard.js`).

## Production setup (real shops)

1. Use a **separate database**: on Vercel → Settings → Environment Variables set `MONGO_DB` to e.g. `inventory_pos_prod` (same Atlas cluster is fine). Keep `uat` for tests.
2. Set a new `JWT_SECRET`, `API_AUTH_KEY`, `TELEGRAM_TOKEN_KEY` for production (different from UAT); the admin web's `REACT_APP_API_AUTH_KEY` must match `API_AUTH_KEY`.
3. Once, from your computer with the production values in a separate env file: `npm run seed` (API key, first super admin, setting, payment methods). Never run `seed:sample` there (it refuses anyway).
4. `CORS_ORIGINS` if the admin web gets a custom domain. Uptime check: cron-job.org → `/health` every 5 min.
5. **Backups** (below).

## Backup / restore

- `npm run backup` → `backups/<db>/<date_time>/` (every collection as gzip Extended JSON + `manifest.json`), keeps the newest 14 (`BACKUP_KEEP`). Read-only. `backups/` is in `.gitignore`.
- `npm run restore -- <folder> --to <database> --yes` → into an empty database (refuses if data exists); `--replace` empties the target collections first; `--only users,warehouses` for some collections.
- **Nightly on GitHub**: `.github/workflows/backup.yml` runs at 02:00 Cambodia time and keeps each backup 30 days as a downloadable artifact. Add repository secrets `MONGO_USER`, `MONGO_PASS`, `MONGO_DB` (the production database). Keep the repository private.

## Tests

`npm test` runs every `tests/*.test.js` (≈ 420 checks in 20 files, ~7 min) against the **test** database with the sample data; `npm test -- stock price` runs only matching files. Each test creates `@local.test` users / `ZZ` codes and deletes them at the end (document counters restored). Stop `npm run dev` while testing (its Telegram sender may pick up test messages).

## Sample data (UAT)

`npm run seed:sample` — safe to run again. More sample data is added with each module.
- Warehouses WH01 (central), PP01, PP02 (shops)
- Units, a baby-shop category tree (clothing, diapers, bath care, feeding, toys, accessories), attributes size / diaper_size / color
- Brands (Little Bear house brand, Pampers, Huggies, MamyPoko, Johnson's, Pigeon, Dumex)
- 13 products / 54 variants: romper, T-shirt, sleepsuit (size × color) · diaper pants and tape (diaper size, pack + box of 4) · wipes, shampoo, lotion, powder, formula (box units; shampoo → formula track batch / expiry) · bottle and socks (color) · rattle toy. Barcodes are sample EAN-13 starting with `200` (in-store range).
- Prices for every variant (base unit + box / pack), a PP02 special price for DIAPANT01-M ($13.90) and an upcoming FORMULA01 price ($25.50 in 14 days).
- Stock (via the API, `scripts/seed-stock.js`): 4 suppliers · opening stock WH01 / PP01 / PP02 (formula batch F2401 expires in 20 days → expiry alert) · GR posted (Pampers M / L boxes) + 1 draft · transfer to PP01 received with 1 pack short (→ ADJ) · transfer to PP02 in transit · PP02 request · 1 posted + 1 draft adjustment
- Users `central@`, `accountant@`, `manager.pp01@`, `manager.pp02@`, `cashier.pp01@`, `cashier.pp02@` (`@inventorypos.test`), password `Sample@2026`, cashier POS PIN `1234`

## Build plan

| Phase | Content | Status |
|---|---|---|
| 0 | Base cleanup: roles, permission, warehouse scope, counter, seed | ✅ |
| 1 | Master data: warehouse, users, setting, exchange rate, payment method, unit, category, attribute, brand, product + variant, price | ✅ |
| 2 | Stock: movement ledger, opening stock, goods receive + batch, transfer, adjustment | ✅ |
| 2+ | Shop portal API · Telegram (bots, chats, events, scheduled reports) | ✅ |
| 3 | POS: device, sync pull / push, Local POS API | |
| 4 | Sales in cloud, dashboard, reports | |
| 5 | Purchase order, promotion, stock count, KHQR / ABA, commission | |
