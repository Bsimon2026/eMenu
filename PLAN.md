# DigiMenu — phase 1: decisions, inputs, and what it costs

Prepared for Ogle Live Technologies. Companion to the working front end in this repo.

---

## 1. Why the build is cheaper than the first estimate

Your three decisions remove almost all of the recurring third-party cost:

| Decision | Effect |
|---|---|
| **No Meta / WhatsApp Cloud API.** The guest sends from their own WhatsApp to the restaurant's number; we email the restaurant a copy. | Zero per-message fees, zero WABA approvals, zero per-restaurant onboarding friction. The order cost line disappears. |
| **Google Maps: paste the link only.** No Places API, no key, no caching rules. | No Google Cloud billing, no dependency on their terms. |
| **Orders are kept as records.** | A database of orders becomes a feature you can sell (and a reason a restaurant does not churn). |

What is left to pay for is hosting, email, AI reads and support — see §2.

---

## 2. What I need from you

Items 1–3 block the build. 4–6 block launch.

**1. The transactional email account.** An email provider (Resend, Postmark, Amazon SES) plus DNS records on a domain you control — SPF, DKIM, DMARC. Email is now the only guaranteed copy of an order, so it has to land in an inbox and not in spam. Give me the sending domain and I will tell you which records to add. Cost: AED 60–110/month at this volume.

**2. List the exact emails that receive order copies.** Restaurant owner, manager, and optionally the branch. Each restaurant needs at least one verified address before publishing; the flow should not let them publish with an unverified one.

**3. Talabat / Deliveroo import — decide how far to go.** Read the risk box below before you answer.

**4. Trade licence for Ogle Live, TRN, terms of service, privacy policy, data-retention statement.** You are storing owners' trade-licence copies and a log of their customers' orders. Under UAE PDPL (Federal Decree-Law 45/2021) that needs a stated purpose and a retention period. For order records I would suggest: orders 24 months, licence copies for the life of the account plus 90 days, then deleted.

**5. Domain and DNS control for `ogle.live`** so `ogle.live/digimenu/<handle>` can be routed with one wildcard rule and one certificate. Confirm nobody else is using that path.

**6. Who answers the phone during the trial.** Restaurants will call about a wrong price or a missing dish. That person is a real monthly cost — see §5.

### The Talabat / Deliveroo risk — read this before committing

You can paste their link and we can try to read it. Expect it to be unreliable:

- Talabat and Deliveroo **prohibit automated access in their terms**. A letter is a real risk if you do it at volume, and they have bot protection that will block a plain server fetch.
- Their pages are built in the browser, so a server-side read often returns an empty shell. It needs a rendered browser, which is slower and easier to detect.
- **Dish photos are the bigger problem.** The photographs on a platform page may be owned by the restaurant, by the platform, or by the photographer who sold them the shoot. Copying them onto your page is a copyright exposure you would carry, not the restaurant.

My recommendation, in order:

1. **Build the field, attempt the read, fail honestly.** Paste link → try → if it does not parse in six seconds, say so and switch to photo upload. This is what the prototype shows. It costs a few days and looks like a serious product.
2. **Import text only from the link** — categories, names, prices. Do not copy their images; ask the restaurant to send photos, or show dishes without images (a text menu still sells).
3. If a restaurant insists, have them send a PDF or a photo. It takes them one minute and costs you nothing.

Do not promise automated Deliveroo import in a sales meeting. Promise the field, the attempt, and the fallback.

---

## 3. Phase 1 scope (updated)

| Workstream | Content | Est. |
|---|---|---|
| Public site | landing, pricing, login page | 1 wk |
| Owner app | signup, 4-step onboarding, documents, handle claim, QR + PNG, dashboard | 3 wks |
| Guest app | categories, sold-out state, cart, dine-in / take-away / delivery, WhatsApp handoff | 3 wks |
| Order pipeline | record the order server-side, email copy with retry + delivery log, order list + export | 1.5 wks |
| Menu ingestion | upload → vision read → category grouping → human review screen → commit | 4 wks |
| Link import | paste Talabat/Deliveroo/own-site link, rendered fetch, parse, honest failure path | 2 wks |
| Menu editing | add/edit/reorder items and categories, sold-out toggles, price changes | 2 wks |
| Backend & tenancy | Postgres, per-restaurant isolation, encrypted document storage, audit log | 2 wks |
| Admin | approve licence, publish/suspend, see failed reads and failed emails | 1.5 wks |
| QA & deploy | device matrix, staging, backups, monitoring, load test on the menu page | 2 wks |

~22 dev-weeks. Two developers and a designer: **12–14 calendar weeks.**

The two things that always overrun: menu reading accuracy (a photo of a printed menu is a harder input than a PDF), and the growth of the menu editor. Every restaurant will ask to add a dish, hide a category, or change a price at 7pm on a Friday.

---

## 4. Cost to run, per restaurant per month

Fixed infrastructure **AED 349/month**: app hosting (AED 129), Postgres + backups (AED 55), object storage + CDN for logos and licences (AED 37), transactional email (AED 55), monitoring and error tracking (AED 73).

Variable per restaurant **AED 9.26**: support 12 min at AED 45/hr (AED 9.00), one AI re-read (AED 0.18), order emails (AED 0.07).

| Restaurants | Cost to serve / month | All-in, including build + maintenance |
|---|---|---|
| 10 | AED 44 | AED 496 |
| 25 | AED 23 | AED 204 |
| 50 | AED 16 | AED 107 |
| 100 | AED 13 | **AED 58** |
| 250 | AED 11 | AED 29 |

All-in assumes AED 70,000 of build amortised over 24 months and AED 1,600/month of maintenance, spread across the subscriber base. Below ~15 restaurants the fixed costs dominate; from ~100 they almost vanish.

---

## 5. Build cost and maintenance

- Two developers + designer, offshore, 12–14 weeks: **AED 70,000–110,000**
- Same scope through a UAE agency: **AED 180,000–320,000**
- Leaner v1 (English only, photo import only, no link import): **AED 50,000–70,000** in 8–9 weeks

Maintenance after launch: **AED 1,200–2,000/month** — hosting, backups, monitoring, dependency and browser updates, email deliverability upkeep, plus about a day a month of change requests. Budget a visible improvement every month; a restaurant that sees nothing change stops paying.

---

## 6. What to charge

The cost to serve is now so low that pricing is about what the market bears, not your cost.

| | Essential — AED 99/mo | Standard — AED 149/mo | Growth — AED 249/mo |
|---|---|---|---|
| Menu, QR, ordering, sold-out toggles | ✓ | ✓ | ✓ |
| AI menu reads | 1 | 3/month | unlimited |
| Order email copies + records | ✓ | ✓ | ✓ |
| Talabat / Deliveroo link import | — | ✓ | ✓ |
| Arabic menu | — | — | ✓ |
| Category sales report | — | — | ✓ |
| Support | email | WhatsApp, next day | WhatsApp, priority |

Plus **AED 250 one-time** for "send us your menu and we digitise it". It costs you about 20 minutes and it is the easiest thing to sell in the first meeting.

Gross margin at AED 149 with 100 restaurants: **91%**. That is healthy, so do not compete on price — compete on the menu looking like the restaurant, and on not breaking during Friday dinner.

Break-even on a AED 70,000 build at AED 149 (AED 136 net per subscriber):

| Subscribers | Months to repay the build |
|---|---|
| 20 | 25.7 |
| 40 | 12.9 |
| 100 | 5.2 |

The honest read: **at 40 paying restaurants you repay the build inside a year; at 20 it takes over two.** Distribution, not margin, is the constraint.

---

## 7. Risks, in the order they will bite

1. **The order record is created before the guest actually presses send in WhatsApp.** They may close the app at that moment. Store the record as "sent to WhatsApp, awaiting restaurant confirmation", and let the restaurant mark it confirmed or dropped. Do not report it to the restaurant as a confirmed sale.
2. **Email deliverability.** An order email that lands in spam is a lost order. Verify the receiving address at signup, send from a domain with SPF/DKIM/DMARC, and keep a retry log visible in the admin.
3. **Menu reading accuracy.** A wrong price published is worse than no menu. Never auto-publish an extraction; the review screen is the product.
4. **Platform scraping.** See §2 — terms, bot protection, and copyright on dish photos.
5. **A permanent QR printed on 40 table cards.** Reserve slugs, refuse trademarked names, never recycle a handle after a restaurant leaves.
6. **Licence documents are personal data.** Encrypt at rest, serve behind signed URLs, log who opened them, delete on churn.
7. **No payments in phase 1.** Order → WhatsApp → pay at the table or on delivery. Adding card payments means per-merchant KYC with a UAE acquirer and is a phase-2 project, not a sprint.

---

## 8. Sequence

1. Decide §2.3 (how far to push link import) and send the sending domain — one week.
2. Lock the data model: restaurants, categories, items, sold-out flag, orders, order status, documents. Three days, before any UI is wired up.
3. Build the guest app first. It is what a restaurant can see, hold in their hand and sell to their own customers.
4. Menu ingestion and the review screen second, tested against 20 real menu photos from 20 real Abu Dhabi restaurants. Collect those photos before writing the reader.
5. Onboard 5 restaurants free, watch one Friday dinner service, then price it.
