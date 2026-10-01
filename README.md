# Le Blend Menu API

Node.js + Express + MongoDB (Mongoose) + Cloudinary. Same structure as SDMS API.

## Setup

```bash
npm install
cp .env.example .env      # fill in Mongo, API key, JWT secret, Cloudinary, seed admin
npm run seed              # creates the first super admin + settings
npm run seed:books        # creates the 3 menu books (Breakfast, Lunch & Dinner, Drinks), rate → 4000
npm run dev               # http://localhost:8086
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

## List query (all `GET /x` list routes)

| Param | Example | Meaning |
|---|---|---|
| `page`, `limit` | `page=1&limit=20` | Pagination (max 200) |
| `sort`, `order` | `sort=sort_order&order=asc` | Sorting |
| `q`, `q_key` | `q=kuy&q_key=["name_en","name_kh","code"]` | Keyword search |
| `q_id`, `q_key_id` | `q_id=["<id>"]&q_key_id=["category_id"]` | Filter by ids |
| `includeDeleted` | `true` | Include soft-deleted rows |

## Roles

| Role | Can do |
|---|---|
| Super admin (`is_super_admin`) | Everything |
| `អ្នកគ្រប់គ្រងប្រព័ន្ធ` (admin) | Everything |
| `អ្នកគ្រប់គ្រងម៉ឺនុយ` (menu manager) | Menu: categories, sections, items, banners, upload |
| `បុគ្គលិក` (staff) | View only |

## Endpoints — `/api/admin`

### Auth
| Method | Path | Body |
|---|---|---|
| POST | `/auth/login` | `{ email, password }` → `data.access_token`, `data.is_first_login` |
| GET | `/auth/me` | |
| POST | `/auth/logout` | |
| PUT | `/auth/change-password` | `{ old_password, new_password }` (use when `is_first_login = true`) |

### Users (admin)
`POST /users`, `GET /users`, `GET /users-all`, `GET /users-roles`, `GET /users/:id`, `PUT /users/:id`,
`PUT /users/reset-password/:id` `{ password }`, `DELETE /users/:id`, `PUT /users/restore/:id`

Create body: `{ firstname, lastname, email, password, role, contact?, job_title?, note?, status? }`

### Session / Activity log (admin)
`GET /session`, `DELETE /session/:id` (force logout), `GET /activity_log?category=menu_item`, `GET /activity_log/category-all`

### Upload (menu manager)
| Method | Path | Body |
|---|---|---|
| POST | `/upload` | form-data: `files` (1–10 images, 4MB each), `folder` = `menu` \| `category` \| `banner` \| `setting` \| `others` |
| GET | `/upload/signature?folder=menu` | Signed direct upload from the browser |
| DELETE | `/upload` | `{ public_id }` |

The upload returns image objects `{ url, public_id, width, height, ... }` → send one of them as `image` / `icon` / `logo`.

### Menu book — `/menu/book`
Printed / digital menus (from the menu sheet): Breakfast, Lunch & Dinner, Drinks. One item can be in many books.
`POST`, `GET` (list, `?format=book|folded`, includes `item_count`), `GET -all`, `PUT -sort`, `GET /:id`, `PUT /:id`, `DELETE /:id`, `PUT /restore/:id`

```json
{ "code": "breakfast", "name_kh": "អាហារពេលព្រឹក", "name_en": "Breakfast", "name_cn": "早餐",
  "location": "ភោជនីយដ្ឋាន និង កាហ្វេ", "format": "book", "serve_from": "06:00", "serve_to": "10:30" }
```
Delete is blocked while items are still in the book.

### Menu category — `/menu/category`
`POST`, `GET` (list, `?type=food|drink`, includes `item_count`), `GET -all`, `PUT -sort`, `GET /:id`, `PUT /:id`, `DELETE /:id`, `PUT /restore/:id`

```json
{ "code": "breakfast", "name_en": "Breakfast", "name_kh": "អាហារពេលព្រឹក", "type": "food",
  "icon": { "url": "..." }, "serve_from": "06:00", "serve_to": "10:00",
  "intro_en": "Begin your morning with us", "sort_order": 0, "status": true }
```
Delete is blocked while the category still has items or sections.

### Menu section — `/menu/section` (headers inside a category, e.g. "HOT COFFEE")
Same routes as category (`?category_id=` filter).
```json
{ "category_id": "<id>", "name_en": "SIGNATURE COCKTAIL", "style": "signature", "subtitle": "CRAFTED WITH PASSION" }
```

### Menu item — `/menu/item`
Same routes + `PUT /availability/:id` `{ is_available: false }` (sold out).
List filters: `?category_id=&section_id=&book_id=&is_available=true&is_featured=true`

```json
{ "code": "001", "category_id": "<id>", "section_id": null,
  "name_kh": "នំបញ្ចុកសម្លខ្មែរ", "name_en": "Num Banh Chok Samlar Khmer", "name_cn": "高棉米粉",
  "book_ids": ["<breakfast id>", "<lunch_dinner id>"],
  "desc_kh": "...", "desc_en": "...", "image": { "url": "..." },
  "price_type": "single", "price": 3.8 }
```
Size price:
```json
{ "price_type": "size", "sizes": [{ "label": "S", "price": 8 }, { "label": "M", "price": 13.8 }] }
```

### Banner — `/menu/banner`
Same routes (`?type=hero|highlight|promo`).
```json
{ "type": "promo", "image": { "url": "..." }, "title": "Breakfast Promotion",
  "category_id": "<breakfast id>", "start_date": "2026-10-01", "end_date": "2026-10-31" }
```

### Setting — `/menu/setting`
`GET`, `PUT` (admin) `{ restaurant_name, logo, address, phone, email, website, facebook, telegram, map_url, currency, currency_symbol, exchange_rate_khr, opening_hours, copyright }`

### Sort (drag & drop) — category / section / item / banner
`PUT /menu/<module>-sort` body `{ "items": [{ "_id": "<id>", "sort_order": 0 }, ...] }`

## Public menu — `/api/public` (no login, no API key)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/public/menu/:token` | `{ setting, categories, sections, items, banners }` — only active rows; sold-out items come with `is_available: false`. Wrong / old token → 404 |

The token is `setting.public_token` (created automatically the first time `GET /api/admin/menu/setting` is called).

| Method | Path | Who |
|---|---|---|
| PUT | `/api/admin/menu/setting/public-token` | admin — makes a new token; old links / printed QR codes stop working |

Public page in the admin app: `<site>/m/<token>` (optional `?category=<code>&table=5`).

## Languages & prices
- Every menu record has **Khmer / English / Chinese**: `name_kh`, `name_en`, `name_cn` (items also `desc_*`, categories `intro_*`). At least one name is required.
- Prices are saved in **USD**. Riel = `price × setting.exchange_rate_khr` (default **4000**, same as the menu sheet) — the admin / public menu calculate it.
