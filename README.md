# DigiMenu — QR menus and WhatsApp ordering for UAE restaurants

A product of [Ogle.live](https://ogle.live) Technologies. This repo is the phase-1 front end:
a marketing site, restaurant sign-in, onboarding, dashboard, and the guest menu that takes orders.

Commercial model, build scope and unit economics: **[PLAN.md](PLAN.md)**.

## Run it

```bash
python -m http.server 8899      # from this directory
```

| Page | URL | What it is |
|---|---|---|
| Landing | <http://localhost:8899/index.html> | `ogle.live/digimenu` — hero with a live menu in a phone frame |
| Login | <http://localhost:8899/login.html> | Restaurant sign in / create account |
| App | <http://localhost:8899/app.html> | Dashboard, and the 3-step onboarding (`app.html?onboard=2`) |
| Guest menu | <http://localhost:8899/menu.html> | What the QR opens; `?embed=1` is the phone-frame version |

No build step, no npm. State lives in `localStorage` under `digimenu.state.v1` (orders under
`digimenu.orders.v1`), which is why the guest page reflects the restaurant you just set up and
the dashboard sees the order you just placed.

## What actually works

| Feature | Status |
|---|---|
| Sign in / sign up with validation | real (no backend, auth is cosmetic) |
| 3-step onboarding with resume | real |
| Logo upload → dominant colour read (canvas sampling) | real — Ogle logo reads `#f7941d` |
| Handle availability + suggestions | real logic, stubbed directory (`TAKEN` in `assets/app.js`) |
| QR generation + PNG download | real, vendored encoder, scan-verified |
| Menu editor with sold-out switches → guest page updates | real, persisted |
| Guest cart, three order modes, WhatsApp handoff | real |
| Order recorded in the dashboard | real (browser storage) |
| Email copy of the order to the restaurant | **not built** — needs a backend and an email provider |
| Menu photo → dishes | **simulated**, labelled on screen |
| Talabat / Deliveroo link read | **simulated**, labelled on screen; see PLAN.md §2 for the real risk |

## Layout

```
index.html              landing page
login.html              sign in / create account
app.html                dashboard + onboarding wizard
menu.html               guest menu
assets/base.css         tokens, buttons, forms (Ogle palette)
assets/site.css         marketing pages
assets/app.css          dashboard shell + wizard
assets/menu.css         guest menu
assets/app.js           dashboard, onboarding, menu editor, import, QR
assets/menu.js          guest menu, cart, order message, order record
assets/data.js          demo menu, storage helpers, palette extraction
assets/vendor/          qrcode-generator (MIT)
assets/ogle-live-logo.png   the real Ogle.live logo
_preview/               review screenshots
```

## Design system

Taken from the live ogle.live identity so the product sits inside the brand rather than beside it.

- **Orange `#F7941D`** (their brand orange) is the only accent: primary buttons, the active tab,
  the QR's owner. Everything else is neutral.
- **Charcoal `#12161A`** for the sidebar and the CTA band; white cards on `#F6F7F8`.
- **Inter** for interface text, **Outfit** for headings — the pair their own site uses.
- One radius (8px), hairline borders, shadows only on things that float (device frame, dialogs, toast).
- The marketing page uses real product screenshots — the hero phone is the actual menu page in an
  iframe, and the QR beside it is generated at load, not a picture of one.

## Known gaps

- No backend: nothing is saved server-side, uploads are not stored anywhere, email is not sent.
- The order is recorded when the guest taps send, before they press send in WhatsApp — the real
  build must mark it "awaiting restaurant confirmation" (see PLAN.md §7.1).
- English only. Arabic needs a `name_ar` column from day one.
- No payments.
