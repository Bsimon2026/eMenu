# DigiMenu — Phase 1 plan, inputs and unit economics

Prepared for Ogle Live Technologies. Companion to the working front-end in this repo.

---

## 1. What phase 1 actually is

One web app, two faces:

| Face | Who | What it does |
|---|---|---|
| `/index.html` | Restaurant owner | Sign in / sign up → 4-step onboarding (account, restaurant + order channels + WhatsApp number, documents, link + QR) → dashboard (publish status, QR download, menu photo upload, AI extraction review) |
| `/menu.html?r=<handle>` | Guest | Menu by category, veg/non-veg markers, cart, dine-in / take-away / delivery, order sent to the restaurant's WhatsApp |

Everything else in the original brief — logo palette reading, category detection, the QR, the order handoff — is in the prototype and below in the build scope.

---

## 2. What I need from you before build starts

Ordered by how much they block work. Items 1–4 block the build; 5–8 block launch.

**1. The WhatsApp decision — the only real architectural fork.**
Two ways to get an order from the guest to the kitchen:

|  | A. Deep link (`wa.me`) — what the prototype does | B. WhatsApp Cloud API |
|---|---|---|
| Cost | AED 0 forever | Meta charges per delivered message (UAE: ~$0.0157 utility/service, 1,000 free service messages per number per month) |
| Setup per restaurant | none — they keep their existing WhatsApp number | each restaurant's number must be registered into a WABA, Meta business verification, template approval |
| Order arrives as | a normal WhatsApp chat message | a structured payload you can store, print, push to a POS, re-send if missed |
| Automated confirmation, order history, analytics | no | yes |
| Risk | none | number bans, policy changes, per-restaurant onboarding friction |

Recommendation: **A for launch, B as the paid tier later.** Deep links let you onboard 50 restaurants in a week with zero per-restaurant approval, and it is what the prototype implements. Decide now which one phase 1 ships, because it changes the dashboard, the pricing and the support load.

**2. Confirm the URL scheme.** `ogle.live/digimenu/<handle>` as a path (one wildcard route, one TLS cert, unlimited restaurants) vs `<handle>.ogle.live` (needs a wildcard certificate + DNS automation). The prototype assumes the path form — it is cheaper and faster, and a slug under a path is just as memorable on a table tent. Confirm the domain `ogle.live` is yours and is not already used for something else.

**3. Legal and business identity.** Trade licence for Ogle Live Technologies, TRN for VAT invoices, terms of service, privacy policy, and a data-retention statement for uploaded licences. You cannot store restaurant trade-licence copies (personal data of the owner) without a stated purpose and retention period — UAE PDPL (Federal Decree-Law 45/2021). This is also required to pass Meta business verification later.

**4. Pricing, trial length and what the trial limits are.** My recommendation in §6. Needed before the signup screen copy is final: how many trial days, what happens at expiry, whether a card is required at signup (recommend: no card for trial).

**5. Google Maps API key** with billing enabled on a Google Cloud project, Places API (New) enabled. Non-negotiable constraint: **only `place_id` may be stored indefinitely** — address, hours, photos and coordinates may be cached for at most 30 days, then must be refreshed from Google. So do not copy Maps photos into your storage and serve them forever; re-fetch. Budget ~$0.05–0.15 per restaurant onboarding at current Places pricing.

**6. AI provider account and a spend cap.** A vision model API key (OpenAI / Anthropic / Gemini). Measured cost for one menu: **cents, not dollars** — a 2-page menu photo is roughly 8–10k input tokens on a small vision model; at ~$0.15/1M input this is well under $0.01 per image. Cap it anyway, and log every extraction.

**7. Brand assets for Ogle Live** — logo, product wordmark, one brand colour, and who writes the copy (I've written all of it in the prototype as a starting point; it needs your voice).

**8. Who does support and menu corrections during the trial.** A restaurant whose AI extraction came out wrong will call someone. That someone is a real monthly cost — see §6.

Optional but decide early: Arabic/Hindi/Urdu on the guest menu (UAE reality — most kitchens and a large share of guests). Recommend phase 1.5, but the data model should have a `name_ar` column from day one so you don't migrate later.

---

## 3. Build scope, phase 1

| Workstream | Content | Est. |
|---|---|---|
| Owner app | auth, 4-step onboarding, document upload, handle claim + availability, QR generation + PNG download, dashboard | 3 wks |
| Guest app | category menu, diet markers, cart, 3 order modes with their own fields, WhatsApp handoff message | 3 wks |
| Menu ingestion | upload → normalise (deskew/crop) → vision extraction → category grouping → price/diet parsing → **human review UI** → commit to menu | 4 wks |
| Backend & tenancy | Postgres schema, per-restaurant isolation, file storage, signed URLs for licence documents, audit log | 2 wks |
| Admin | approve licence, publish/suspend a restaurant, see extraction failures, plan + expiry | 2 wks |
| Publish gate + legal | enforce logo + licence before publish, ToS/privacy pages, cookie notice | 1 wk |
| QA & deploy | device matrix, staging, backups, monitoring | 2 wks |

~15–17 dev-weeks. With two developers and a designer, that is **10–12 calendar weeks**.

The line item everyone underestimates is menu ingestion. Photographed menus have combo prices ("half / full"), dishes with no price, prices in a separate column, and handwriting. The extraction gets you 85–90% right; the human review screen is what makes it sellable. Do not cut it.

---

## 4. What it costs to run, per restaurant per month

Assumptions: one shared multi-tenant stack, AED 3.6725/USD (pegged), support at AED 45/hour, 12 minutes of support per restaurant per month, WhatsApp via Cloud API at UAE rates with the 1,000 free service messages per number.

Fixed infrastructure: **AED 349/month** total (app hosting, Postgres + backups, object storage + CDN, transactional email, monitoring).

Variable per restaurant: **~AED 16.50/month** (support AED 9.00 + AI re-scans ~AED 0.20 + WhatsApp ~AED 7.30 at ~1,900 messages).

| Active restaurants | Fixed cost share | **Cost to serve / restaurant / month** |
|---|---|---|
| 10 | AED 34.89 | **AED 51.42** |
| 25 | AED 13.96 | **AED 30.48** |
| 50 | AED 6.98 | **AED 23.51** |
| 100 | AED 3.49 | **AED 20.02** |
| 250 | AED 1.40 | **AED 17.92** |

That is the recurring cost. Now the development and maintenance load, spread across the subscriber base:

Build AED 70,000 amortised over 24 months + maintenance AED 1,600/month:

| Subscribers | Serve | Build share | Maintenance share | **All-in cost / restaurant / month** |
|---|---|---|---|---|
| 25 | 30.48 | 116.70 | 64.00 | **AED 211** |
| 50 | 23.51 | 58.30 | 32.00 | **AED 114** |
| 100 | 20.02 | 29.20 | 16.00 | **AED 65** |
| 250 | 17.92 | 11.70 | 6.40 | **AED 36** |

Read the last column honestly: **below ~40 paying restaurants this product does not pay for itself at AED 149/month.** The unit economics only look good at 100+.

---

## 5. One-time build cost

Directional, not a quote — it moves with who builds it.

- Two developers + designer, offshore (India/Pakistan), 10–12 weeks: **AED 55,000–90,000**
- Same scope through a UAE agency: **AED 150,000–280,000**
- Leaner v1 (drop admin polish, English only, deep links only): **AED 40,000–55,000** in 7–8 weeks

Ongoing maintenance, once live: **AED 1,200–2,000/month** — hosting, backups, monitoring, dependency upgrades, and keeping up with Meta and Google API changes, plus roughly one day a month of small changes. Budget a real feature release every month or the product starts to look abandoned next to the competitors.

---

## 6. What to charge

| | Essential — AED 99/mo | Standard — AED 149/mo | Pro — AED 249/mo |
|---|---|---|---|
| Guest menu + cart + 3 order modes | ✓ | ✓ | ✓ |
| QR + menu link | ✓ | ✓ | ✓ |
| AI menu import | 1 scan | 3 scans/mo | unlimited |
| WhatsApp Cloud API automation (order log, re-send, print ticket) | — | ✓ | ✓ |
| Second language | — | — | ✓ |
| Analytics (views, add-to-cart, order value) | — | basic | full |
| Support | email | WhatsApp, 24h | WhatsApp, priority |

Plus **AED 250 one-time setup** for "we digitise your menu for you". It costs you ~20 minutes of AI time and a review pass, and it is the single easiest thing to sell to a restaurant owner.

Gross margin at AED 149 with 100 subscribers: **(149 − 20) / 149 = 86.6%**.

Break-even on a AED 70,000 build at AED 149 (AED 129 net per subscriber):

| Subscribers | Months to repay the build |
|---|---|
| 20 | 27 |
| 40 | 13.6 |
| 100 | 5.4 |

Annual prepay at 10 months' price is worth offering early — it funds the next phase.

---

## 7. Risks worth naming now

1. **Extraction accuracy is the product.** A menu that imports wrong is worse than no menu. Never publish an extraction without a human pass — the prototype enforces review before publish for exactly this reason.
2. **Printed QR codes are permanent.** A slug claimed once is on table tents and window stickers forever. Reserve slugs, block trademark-looking ones, and never recycle a handle after a restaurant leaves.
3. **Meta policy.** Deep links carry no risk. Cloud API numbers can be restricted; keep a fallback deep-link path in the guest app even after you add the API.
4. **Licence documents are personal data.** Encrypt at rest, serve behind signed URLs, log access, and delete on churn. Say the retention period in the privacy policy.
5. **Google Places caching.** Only `place_id` may be kept indefinitely; other Places content must be refreshed within 30 days.
6. **Hosting region.** UAE customers expect data in-region. Pick a provider with a Middle East region and confirm the current list before you commit — don't assume.
7. **Payments are not in phase 1.** Order → WhatsApp → pay at the table / on delivery. Adding card payments means per-merchant KYC with a UAE acquirer; that is a phase-2 project on its own, not a sprint.

---

## 8. Suggested sequence

1. Decide §2.1 (WhatsApp path) and §2.4 (pricing) — one week.
2. Lock the data model with `name_ar` and per-restaurant isolation — 3 days.
3. Build guest app first (it is what the restaurant can see and sell), owner app second.
4. Ingestion + review UI third, with 20 real menu photos from 20 real Abu Dhabi restaurants as the test set. Collect these photos before you write the extractor.
5. Onboard 5 restaurants free. Watch them use it for two weeks. Then price it.
