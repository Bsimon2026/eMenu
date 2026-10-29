# DigiMenu — owner sign-in, onboarding and guest ordering (phase 1 front end)

A working, no-build-step front end for Ogle Live's digitised restaurant menu:
sign up → claim `ogle.live/digimenu/<handle>` → get a QR → upload a menu photo →
guests scan, order, and the order lands in the restaurant's WhatsApp.

Commercial model, build scope and unit economics: **[PLAN.md](PLAN.md)**.

## Run it

```bash
python -m http.server 8899      # from this directory
```

- Owner app — <http://localhost:8899/index.html>
- Guest menu — <http://localhost:8899/menu.html>

No npm, no build. State lives in `localStorage` under `digimenu.state.v1`, which is
why the guest page picks up the restaurant you just created (name, logo colour,
WhatsApp number, handle).

## What actually works

| Feature | Status |
|---|---|
| Sign in / sign up, field validation, returning-owner refill | real |
| 4-step onboarding with resume | real |
| Dominant-colour extraction from the uploaded logo, applied live to the menu card | real — canvas sampling, saturation-weighted |
| Handle availability check + suggestions | real logic, stubbed directory (`TAKEN_HANDLES` in `assets/data.js`) |
| QR generation (client-side, vendored `qrcode-generator`) | real, scan-verified |
| QR PNG download | real |
| Guest menu, cart, quantities, 3 order modes with their own required fields | real |
| Order → `wa.me/<number>?text=…` handoff | real, uses the number captured at onboarding |
| Menu photo upload → extraction table | **simulated** — the prototype shows sample data and says so on screen; no model is called |

## Layout

```
index.html                  owner app: auth, onboarding (4 steps), dashboard
menu.html                   guest menu + cart + checkout sheet
assets/app.css              owner app styles
assets/app.js               owner app behaviour
assets/menu.css             guest menu styles
assets/menu.js              guest menu, cart, WhatsApp message builder
assets/data.js              demo menu, saved state helpers, palette extraction
assets/vendor/qrcode-generator.js   vendored QR encoder (MIT)
_preview/                   review screenshots
```

## Design notes

The product's output is a printed menu card, so the interface borrows the menu
card's own grammar instead of generic dashboard chrome: hairline section rules,
dotted price leaders, veg/non-veg squares, tabular prices.

- **Two-panel spread.** The left panel is a live menu card — it fills itself in as
  the owner types and takes its accent from the dominant colour of the logo they
  upload. That single interaction is what the page is trying to be remembered for,
  so everything around it is quiet: one accent, one radius, no decorative shadows.
- **Palette.** Aubergine stage `#241318`, bone paper `#F5F3EC`, ink `#191811`,
  pomegranate `#7C2231`, brass `#A8823C`, veg `#2E6B3B`. Deliberately not the
  cream + terracotta palette that every restaurant SaaS lands on, and not
  near-black + acid green.
- **Type.** Fraunces for display (it has a printed-menu warmth without being a
  wedding invitation), Instrument Sans for UI. No third face.
- **Rules over cards.** Hierarchy comes from rules, leaders and spacing, not from
  putting every block in a rounded box with the same shadow.
- Responsive to 360px, visible keyboard focus, `prefers-reduced-motion` honoured.

## Known gaps (deliberately left for the build)

- No backend: auth is cosmetic, documents are not uploaded anywhere, nothing is
  persisted server-side.
- Handle availability is a local stub, not a registry check.
- Extraction is sample data (labelled in the UI).
- English only; the Arabic column belongs in phase 1.5.
- No payments — order → WhatsApp → pay at the table / on delivery.
