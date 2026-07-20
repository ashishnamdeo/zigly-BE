# Zigly Prescription-to-WhatsApp Integration

Node.js/Express backend that receives a "Upload Prescription" form submission from a
Shopify storefront and forwards the file plus customer name/phone to a WhatsApp
number via the Gupshup WhatsApp API.

## Architecture

```
Shopify storefront (theme section + JS)
        │  multipart/form-data POST (name, phone, prescription file)
        ▼
Express backend (this repo)
        │  1. Multer validates + stores the file, serves it at a public URL
        │  2. Sends an approved HSM template message via Gupshup (name + phone)
        │  3. Sends a media message via Gupshup (the file, by URL)
        ▼
Gupshup WhatsApp API
        │
        ▼
Predefined WhatsApp number (pharmacist / store)
```

Gupshup's Messages API fetches media by URL rather than accepting a raw file
upload, so the backend hosts the uploaded file at `APP_BASE_URL/uploads/<file>`
and passes that URL as `media_url`. This means `APP_BASE_URL` **must** be a
publicly reachable HTTPS URL in production (Gupshup's servers need to fetch it).

The name/phone notification is sent via an approved HSM template (`isHSM`/`isTemplate`
with the template text pre-filled) rather than a freeform message, since WhatsApp
requires business-initiated messages to use an approved template unless there's
already an open 24-hour session with the destination number. The prescription
file itself is then sent as a plain media message, which succeeds because the
template message just opened/refreshed that session.

## Project structure

```
zigly-BE/
├── src/
│   ├── config/env.js                    # env var loading + validation
│   ├── controllers/prescription.controller.js
│   ├── middleware/
│   │   ├── upload.middleware.js          # Multer: JPG/PNG/PDF only, size limit
│   │   └── errorHandler.js               # centralized error handling + cleanup
│   ├── routes/prescription.routes.js
│   ├── services/gupshup.service.js       # Gupshup WhatsApp API client
│   ├── utils/
│   │   ├── ApiError.js
│   │   └── logger.js
│   ├── app.js                            # Express app (middleware, routes)
│   └── server.js                         # entrypoint
├── shopify/
│   ├── sections/upload-prescription.liquid    # standalone page section (the form)
│   ├── snippets/rx-prescription-upload.liquid # product-page widget, gates Add to Cart
│   └── assets/
│       ├── upload-prescription.js        # form submit handler (fetch → backend)
│       └── upload-prescription.css
├── uploads/                              # uploaded files served statically
├── .env.example
├── package.json
└── README.md
```

## 1. Backend setup

### Prerequisites
- Node.js 18+
- A Gupshup Enterprise account with a WhatsApp sender configured and an
  approved HSM template for the name/phone notification
- A publicly reachable HTTPS domain for deployment (e.g. Render, Railway, Fly.io,
  an EC2/VPS behind nginx + Let's Encrypt, etc.)

### Install

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `APP_BASE_URL` | Public HTTPS URL of this backend, e.g. `https://api.yourdomain.com` |
| `ALLOWED_ORIGINS` | Comma-separated list of storefront origins allowed to call the API |
| `GUPSHUP_USERID` | Your Gupshup Enterprise account userid (Console → Account Info) |
| `GUPSHUP_PASSWORD` | Your Gupshup Enterprise account password |
| `GUPSHUP_SEND_TO` | The number that should receive prescriptions, E.164 (e.g. `+919876543210`) |
| `GUPSHUP_TEMPLATE_TEXT` | Approved HSM template text with `{{1}}`/`{{2}}` placeholders for the name/phone notification |
| `UPLOAD_DIR` | Local folder for uploaded files (default `uploads`) |
| `MAX_FILE_SIZE_MB` | Max upload size in MB (default 10) |

### Run

```bash
npm run dev     # local development with nodemon
npm start        # production
```

Health check: `GET /health` → `{ "success": true, "status": "ok" }`

### API

`POST /api/prescription/upload`

- Content-Type: `multipart/form-data`
- Fields:
  - `name` (string, required)
  - `phone` (string, required — 8-15 digits, optional leading `+`)
  - `prescription` (file, required — JPG, PNG, or PDF, max `MAX_FILE_SIZE_MB`)

Success response:
```json
{ "success": true, "message": "Prescription uploaded and sent via WhatsApp successfully" }
```

Error response:
```json
{ "success": false, "message": "..." }
```

### Production notes

- **File storage**: local disk storage works but is ephemeral on most
  container/serverless platforms (files vanish on redeploy/restart). For a
  durable production setup, swap `multer.diskStorage` in
  [upload.middleware.js](src/middleware/upload.middleware.js) for
  `multer-s3` (or Cloudinary/GCS) and use the returned CDN URL in place of
  `APP_BASE_URL/uploads/...` when calling Gupshup — the rest of the flow is
  unchanged.
- **HTTPS required**: Gupshup must be able to fetch the uploaded file over the
  public internet, so `APP_BASE_URL` cannot be `localhost` in production. Use
  ngrok for local testing against real Gupshup delivery.
- **Rate limiting**: `express-rate-limit` is applied to the upload route
  (30 requests / 15 min / IP) — tune in
  [prescription.routes.js](src/routes/prescription.routes.js).
- **CORS**: only origins listed in `ALLOWED_ORIGINS` can call the API.
- **Process manager**: run behind PM2 or your platform's process supervisor
  (`pm2 start src/server.js --name zigly-prescription-api`), or containerize
  it (Dockerfile not included but the app has no native dependencies, so any
  standard `node:18-alpine` image works).

## 2. Gupshup setup

1. Sign up for a [Gupshup](https://www.gupshup.io) Enterprise account and
   note your **userid** and **password** from the Console dashboard
   (`GUPSHUP_USERID` / `GUPSHUP_PASSWORD`). Authentication uses plain
   userid/password — no separate API key is required.
2. Get a WhatsApp Business sender number configured on your Gupshup account
   (Gupshup's support team coordinates the Meta/WABA registration).
3. Set `GUPSHUP_SEND_TO` to the WhatsApp number that should receive
   prescription uploads (e.g. the pharmacist's phone), in E.164 format
   (e.g. `+919876543210`).
4. Get an approved **HSM template** created (Gupshup's support team can create
   it on your behalf via Unify or the Template Creation API) with two
   variables for the notification text, e.g.:
   ```
   New prescription received from {{1}}, phone {{2}}.
   ```
   Set the same text, placeholders included, as `GUPSHUP_TEMPLATE_TEXT` —
   [gupshup.service.js](src/services/gupshup.service.js) resolves `{{1}}`/`{{2}}`
   with the customer's name/phone before sending. Templates need WhatsApp
   approval before use (usually within minutes to a few hours).
5. [prescription.controller.js](src/controllers/prescription.controller.js)
   maps `contentVariables` as `{ 1: name, 2: phone }` — update the key numbers
   there if your template's placeholders are in a different order.

## 3. Shopify setup

The `shopify/` folder contains a ready-to-use theme section — no custom app
scaffold or OAuth backend is required for this integration, since the form
only needs to POST to your Node.js backend directly.

### Quick path: add the section to your theme

1. In the Shopify admin, go to **Online Store → Themes → Edit code** on the
   theme you want to add the form to.
2. Under `Sections`, create a new file `upload-prescription.liquid` and paste
   the contents of [shopify/sections/upload-prescription.liquid](shopify/sections/upload-prescription.liquid).
3. Under `Assets`, create `upload-prescription.js` and `upload-prescription.css`
   with the contents of the matching files in [shopify/assets/](shopify/assets/).
4. Go to **Online Store → Themes → Customize**, open the page you want the
   form on (e.g. a "Prescription Upload" page you create under **Online
   Store → Pages**), click **Add section**, and choose **Upload Prescription**.
5. In the section settings, set **Backend upload endpoint URL** to your
   deployed backend, e.g. `https://api.yourdomain.com/api/prescription/upload`.
6. Add `https://your-store.myshopify.com` (and your custom domain, if any) to
   `ALLOWED_ORIGINS` in the backend's `.env`.

### Product-page widget (self-contained "Send Prescription" button)

[shopify/snippets/rx-prescription-upload.liquid](shopify/snippets/rx-prescription-upload.liquid)
is a different pattern from the standalone page section above: it renders
directly on the product page and has its own **Send Prescription** button,
independent of "Add to Cart".

How it works:
- It collects name, phone, and a single JPG/PNG/PDF file (client-side
  validated against the same rules as the backend: allowed types, 10MB max).
- The prescription file input is still associated with the product form via
  `form="product-form-{{ section.id }}"` and `name="properties[Prescription
  upload]"` — Shopify's native mechanism for attaching an uploaded file to a
  cart line item property. So whenever the customer clicks Add to Cart
  (wherever that button lives on the page), the same file is *also* attached
  to the order in Shopify admin as a bonus audit trail — that's independent
  of, not a dependency of, the WhatsApp send below.
- Clicking **Send Prescription** validates the fields and `POST`s
  `name`/`phone`/the file to the backend directly. On success the button
  shows "SENT ✓" and an inline confirmation; on failure it re-enables itself
  and shows an inline error so the customer can retry. Picking a different
  file resets this state.

To use it:
1. Add the file to your theme under `Snippets` as `rx-prescription-upload.liquid`.
2. In the product template (e.g. `sections/main-product.liquid`), render it
   near the product form: `{% render 'rx-prescription-upload' %}`. It needs
   `section.id` in scope, so render it from within the section that owns the
   product form.
3. Set `RX_UPLOAD_ENDPOINT` near the top of the snippet's `<script>` block to
   your deployed backend's `/api/prescription/upload` URL.
4. Make sure the Tabler icon webfont is loaded once in `theme.liquid` (see the
   commented `<link>` at the bottom of the snippet) since the buttons use
   `ti-*` icon classes.

### Alternative: package it as a Shopify app (Theme App Extension)

If you'd prefer to distribute this as an installable Shopify app (e.g. across
multiple stores) rather than editing theme code directly:

```bash
npm install -g @shopify/cli
shopify app init
shopify app generate extension --type=theme_app_extension
```

Copy the liquid block and assets into the generated extension's
`blocks/`/`assets/` folders, run `shopify app dev` to test, then
`shopify app deploy` to publish. Merchants then enable the block via the
theme editor's **App embeds/blocks** instead of pasting code — functionally
identical to the quick path above, just installable/updatable as an app.

## 4. Testing end-to-end

1. Start the backend (`npm run dev`), tunneled via ngrok if testing locally:
   `ngrok http 3000`, then set `APP_BASE_URL` to the ngrok HTTPS URL.
2. Add the theme section to a Shopify page (or a dev store) and point
   **Backend upload endpoint URL** at `<ngrok-url>/api/prescription/upload`.
3. Submit the form with a test name, phone, and a JPG/PNG/PDF file.
4. Confirm the destination WhatsApp number receives the HSM template
   notification (name/phone), followed by the prescription image/document.
5. Check backend logs for `Prescription forwarded to WhatsApp` to confirm
   success; error responses surface in the storefront form's status message.
