/**
 * The machine-readable surface — what an assistant or an agent framework can
 * read without guessing, and the one place each answer is written.
 *
 *   /llms.txt      a Markdown map of the site. Generated, not typed: the price
 *                  line comes from `plans.js` and the menu list from the same
 *                  `isLive()` rows the sitemap uses, so a price in it cannot
 *                  drift and a link in it cannot rot into a 404.
 *   /openapi.json  the public read and order endpoints as an OpenAPI 3.1
 *                  document, so a client can be generated rather than guessed.
 *   a 404 body     a short page that says where everything is, instead of the
 *                  platform's stock "not found".
 *   Markdown       `Accept: text/markdown` on any page returns that page as
 *                  Markdown, with `Vary: Accept` so no cache mixes the two up.
 *
 * Nothing here invents content: every sentence is either a fact the site already
 * states (plans, prices, the contact line) or a row from the database. The copy
 * is deliberately short — an agent wants the map, not the brochure.
 */

const { PLANS, ADDONS } = require("./plans");

const DEFAULT_BASE = (process.env.PUBLIC_BASE || "https://digimenu.indubaicity.com").replace(/\/+$/, "");

function base(v) {
  return String(v || DEFAULT_BASE).replace(/\/+$/, "");
}

/* The identity, once. index.html states the same thing to crawlers in its
   JSON-LD; when another profile exists it is added in both places (and to
   `sameAs` here) and nowhere else. */
const ORG = {
  name: "Ogle Live Technology",
  tradingAs: "Ogle.live",
  product: "DigiMenu",
  email: "connect@indubaicity.com",
  phone: "+971 56 891 1233",
  telephone: "+971568911233",
  city: "Dubai",
  region: "Dubai",
  country: "AE",
  countryName: "United Arab Emirates",
  site: "https://ogle.live/",
  /* Real, resolving web properties of the same entity. A social or registry
     profile belongs here the day it exists — never before: a sameAs that 404s
     is worse for the reader than an empty array. */
  sameAs: ["https://ogle.live/", "https://digimenu.indubaicity.com/"]
};

/* ---------- small text helpers ---------- */

/** Collapse anything a dish name might contain into one line of text. */
function one(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

/** Text safe to sit inside a Markdown link label or a table cell. */
function mdText(v) {
  return one(v).replace(/[[\]]/g, function (c) { return c === "[" ? "(" : ")"; }).replace(/\|/g, "/");
}

/** AED 1,999 · AED 129 · AED 12.50 — grouped, no bare trailing zeros. */
function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return "";
  const fixed = (Math.round(v * 100) / 100).toFixed(v % 1 === 0 ? 0 : 2);
  const parts = fixed.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return parts.join(".");
}

/** Does this client want the Markdown variant? `text/markdown;q=0` does not. */
function wantsMarkdown(accept) {
  const a = String(accept || "").toLowerCase();
  if (a.indexOf("text/markdown") === -1) return false;
  return !/text\/markdown\s*;\s*q=0(\.0*)?\s*(,|$)/.test(a);
}

/* ---------- the price line, from the one table ---------- */

function priceLine() {
  const tiers = Object.keys(PLANS).map(function (key) {
    const p = PLANS[key];
    const both = [];
    if (p.price.monthly != null) both.push("AED " + money(p.price.monthly) + " a month");
    if (p.price.yearly != null) both.push("AED " + money(p.price.yearly) + " a year");
    return p.label + " " + both.join(" or ");
  });
  const addons = Object.keys(ADDONS).map(function (key) {
    return ADDONS[key].label + " AED " + money(ADDONS[key].yearly) + " a year";
  });
  return tiers.join(" · ") + (addons.length ? " · " + addons.join(" · ") : "");
}

/* ---------- /llms.txt ----------
 * The shape llmstxt.org asks for: an H1, a blockquote summary, then `##`
 * sections of `- [title](url): why to open it`. Absolute URLs, because the
 * reader is not a browser and has no base to resolve against. */

function llmsTxt(opts) {
  const b = base(opts && opts.base);
  const menus = (opts && opts.menus) || [];
  const L = [];

  L.push("# " + ORG.product);
  L.push("");
  L.push("> " + ORG.product + " is a QR menu for restaurants in the UAE that takes the order: the guest scans a code, orders from their own phone, and the order arrives in the restaurant's WhatsApp. No app for the guest, no commission on an order, no hardware.");
  L.push("");
  L.push("It is a product of " + ORG.name + ", trading as " + ORG.tradingAs + ", " + ORG.city + ", " + ORG.countryName + ". Prices are in AED and include 5% VAT. Every restaurant's menu is a page on this domain at `/<handle>`, and every live menu is listed in the sitemap with the date it last changed.");
  L.push("");

  L.push("## The product");
  L.push("");
  L.push("- [" + ORG.product + "](" + b + "/): what it is, how a guest orders, and the dashboard the owner runs it from.");
  L.push("- [How ordering works](" + b + "/#how): scan the code, build the basket, review and confirm, then the order opens in WhatsApp.");
  L.push("- [Pricing](" + b + "/#pricing): " + priceLine() + ".");
  L.push("- [Questions restaurants ask](" + b + "/#faq): six answers — guest apps, the 50-dish cap on QR Menu, whether WhatsApp Business is needed, Arabic, a custom domain, and what happens when a plan lapses.");
  L.push("");

  if (menus.length) {
    L.push("## Live menus");
    L.push("");
    menus.forEach(function (m) {
      const where = m.city ? " in " + mdText(m.city) : "";
      L.push("- [" + mdText(m.name || m.handle) + "](" + b + "/" + encodeURIComponent(m.handle) + "): the live QR menu for " + mdText(m.name || m.handle) + where + ".");
    });
    L.push("");
  }

  L.push("## For agents and developers");
  L.push("");
  L.push("- [Sitemap](" + b + "/sitemap.xml): every indexable page, with its last-modified date.");
  L.push("- [OpenAPI description](" + b + "/openapi.json): the public menu read and order endpoints, with request and response shapes and error codes.");
  L.push("- [robots.txt](" + b + "/robots.txt): what may be crawled. The sign-in, the owner dashboard, the operator console and the feedback links are private and answer a session or a one-off token.");
  L.push("- Markdown: any page above also comes back as Markdown — send `Accept: text/markdown`. Ask for a restaurant's page the same way to get its whole menu as Markdown with prices.");
  L.push("");

  L.push("## Legal and contact");
  L.push("");
  L.push("- [Terms of Service](" + b + "/terms.html): who we are, the plans and prices, the free week, cancellation and refunds, liability, and governing law.");
  L.push("- [Privacy Policy](" + b + "/privacy.html): what is collected, why, how long it is kept, who else touches it, and how to ask for a copy or a deletion.");
  L.push("- " + ORG.name + " · " + ORG.city + ", " + ORG.countryName + " · " + ORG.email + " · " + ORG.phone);
  L.push("");

  return L.join("\n");
}

/* ---------- /openapi.json ----------
 * Only what an outside client may call: the two public endpoints and the three
 * documents above. The dashboard's endpoints take a session and are not part of
 * this contract. */

function openapiDoc(opts) {
  const b = base(opts && opts.base);
  const err = {
    type: "object",
    properties: {
      ok: { type: "boolean", const: false },
      code: { type: "string", description: "Machine-readable reason, e.g. NOT_FOUND." },
      message: { type: "string", description: "A sentence written for a person." }
    },
    required: ["ok", "code"]
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "DigiMenu public API",
      version: "1.0.0",
      summary: "Read a restaurant's live menu, and place a guest order.",
      description:
        "DigiMenu is a QR menu that takes the order, run by " + ORG.name + " (" + ORG.tradingAs + "). " +
        "These are the two endpoints a guest page calls: GET /api/menu for the menu and POST /api/order for the order. " +
        "Ordering is only accepted for a restaurant whose plan includes it; otherwise POST answers 403 ORDERING_NOT_INCLUDED. " +
        "Everything the owner does (editing dishes, publishing, reading orders) needs a session token and is not part of this document.",
      contact: { name: ORG.name, email: ORG.email, url: ORG.site },
      license: { name: "Proprietary — use of the API is governed by the Terms of Service", identifier: "Proprietary" }
    },
    servers: [{ url: b, description: "Production" }],
    tags: [
      { name: "menu", description: "What a restaurant is serving." },
      { name: "order", description: "A guest's order on the way to the kitchen." },
      { name: "agent", description: "The machine-readable documents." }
    ],
    paths: {
      "/api/menu": {
        get: {
          tags: ["menu"],
          operationId: "getMenu",
          summary: "A restaurant's published menu, by handle or by host",
          description: "Returns the restaurant's profile and its categories with dishes and prices. A row that says published while its plan has lapsed answers 404 UNPUBLISHED — the same test the guest page applies.",
          parameters: [
            { name: "handle", in: "query", required: false, schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,31}$" }, description: "The menu address, e.g. kings-kebab. Use this or host." },
            { name: "host", in: "query", required: false, schema: { type: "string" }, description: "A restaurant's own domain, when the address carries no handle." }
          ],
          responses: {
            200: {
              description: "The menu.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", const: true },
                      restaurant: { $ref: "#/components/schemas/Restaurant" },
                      categories: { type: "array", items: { $ref: "#/components/schemas/Category" } },
                      itemCount: { type: "integer", description: "Dish placements, so a dish listed twice counts twice." }
                    },
                    required: ["ok", "restaurant", "categories"]
                  }
                }
              }
            },
            400: { description: "BAD_HANDLE / BAD_HOST — the address is not a menu address.", content: { "application/json": { schema: err } } },
            404: { description: "NOT_FOUND / UNPUBLISHED — no live menu at that address.", content: { "application/json": { schema: err } } },
            502: { description: "DB_ERROR — the menu database did not answer.", content: { "application/json": { schema: err } } }
          }
        }
      },
      "/api/order": {
        post: {
          tags: ["order"],
          operationId: "placeOrder",
          summary: "Save a guest's order",
          description:
            "Stores the order and its lines, then mails the guest a copy with a short link back to the chat. " +
            "The order is saved before any WhatsApp step: the guest opens the chat from the confirmation screen, not from this call. " +
            "An identical order (same restaurant, phone and total) inside two minutes returns the first one with duplicate: true instead of storing a second.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/OrderRequest" } } }
          },
          responses: {
            200: {
              description: "Stored.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", const: true },
                      orderId: { type: "string", format: "uuid" },
                      total: { type: "number" },
                      subtotal: { type: "number" },
                      items: { type: "integer", description: "How many order lines were written." },
                      linesSaved: { type: "boolean", description: "Whether the lines were stored with the order." },
                      discount: {
                        type: ["object", "null"],
                        properties: { code: { type: "string" }, amount: { type: "number" } }
                      },
                      notified: { type: "boolean", description: "Whether the restaurant's copy of the order was mailed." },
                      guestNotified: { type: "boolean", description: "Whether the guest's copy was mailed." },
                      mailReady: { type: "boolean", description: "Whether the mail provider is configured at all." },
                      duplicate: { type: "boolean", description: "True when the same order was already received inside two minutes; orderId is then the first one." },
                      message: { type: "string" }
                    },
                    required: ["ok", "orderId", "total"]
                  }
                }
              }
            },
            400: { description: "NAME / PHONE / EMAIL / NO_ITEMS / BAD_HANDLE / BAD_BODY — a required field is missing or the address is not a menu address.", content: { "application/json": { schema: err } } },
            403: { description: "ORDERING_NOT_INCLUDED / SUBSCRIPTION_INACTIVE — this restaurant's plan does not take orders, or the free week has ended with no plan active.", content: { "application/json": { schema: err } } },
            404: { description: "NOT_FOUND — no published menu at that address.", content: { "application/json": { schema: err } } }
          }
        }
      },
      "/s/{code}": {
        get: {
          tags: ["order"],
          operationId: "orderShortLink",
          summary: "Short link from the guest's email to the order's WhatsApp chat",
          description: "Answers 302 to a wa.me URL with the message rebuilt from the stored order, so nothing is trusted from the URL beyond the order id.",
          parameters: [{ name: "code", in: "path", required: true, schema: { type: "string" }, description: "The order id (uuid, or its 32-character hex form)." }],
          responses: {
            302: { description: "Redirect to the WhatsApp chat.", headers: { Location: { schema: { type: "string" } } } },
            404: { description: "The order is not on this account any more.", content: { "text/html": { schema: { type: "string" } } } }
          }
        }
      },
      "/{handle}": {
        get: {
          tags: ["menu"],
          operationId: "getMenuPage",
          summary: "A restaurant's guest menu page",
          description: "The HTML page a guest scans into, with that restaurant's title and share card. Send `Accept: text/markdown` for the same menu as Markdown.",
          parameters: [{ name: "handle", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: {
              description: "The menu page.",
              content: {
                "text/html": { schema: { type: "string" } },
                "text/markdown": { schema: { type: "string" } }
              }
            }
          }
        }
      },
      "/llms.txt": {
        get: {
          tags: ["agent"],
          operationId: "getLlmsTxt",
          summary: "A Markdown map of the site for language models",
          responses: { 200: { description: "The map.", content: { "text/plain": { schema: { type: "string" } } } } }
        }
      },
      "/sitemap.xml": {
        get: {
          tags: ["agent"],
          operationId: "getSitemap",
          summary: "Every indexable page, with last-modified dates",
          responses: { 200: { description: "The sitemap.", content: { "application/xml": { schema: { type: "string" } } } } }
        }
      }
    },
    components: {
      schemas: {
        Restaurant: {
          type: "object",
          properties: {
            name: { type: "string" },
            handle: { type: "string" },
            city: { type: ["string", "null"] },
            address: { type: ["string", "null"] },
            tagline: { type: ["string", "null"] },
            currency: { type: "string", description: "ISO 4217, e.g. AED." },
            accent: { type: "string", description: "The restaurant's brand colour as a hex value." },
            logoUrl: { type: ["string", "null"] },
            coverUrl: { type: ["string", "null"] },
            mapsUrl: { type: ["string", "null"] },
            purposes: { type: "array", items: { type: "string" }, description: "Which order modes are switched on: Dine In, Take Away, Delivery." },
            ordering: { type: "boolean", description: "Whether this restaurant's plan takes orders." },
            locales: { type: "array", items: { type: "string" } },
            theme: { type: "object" }
          },
          required: ["name", "handle"]
        },
        Category: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            featured: { type: "boolean" },
            items: { type: "array", items: { $ref: "#/components/schemas/MenuItem" } }
          },
          required: ["name", "items"]
        },
        MenuItem: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: ["string", "null"] },
            price: { type: "number", description: "In the restaurant's currency." },
            image: { type: ["string", "null"] },
            soldOut: { type: "boolean" },
            diet: { type: ["string", "null"] }
          },
          required: ["name", "price"]
        },
        OrderRequest: {
          type: "object",
          properties: {
            handle: { type: "string", description: "The menu address the order belongs to." },
            mode: { type: "string", enum: ["Dine In", "Take Away", "Delivery"], default: "Dine In" },
            name: { type: "string", description: "The guest's name. Required." },
            phone: { type: "string", description: "The guest's mobile. Required — it is the fallback if WhatsApp fails." },
            email: { type: "string", format: "email", description: "Required. The order copy goes here." },
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  qty: { type: "integer", minimum: 1 },
                  price: { type: "number" }
                },
                required: ["name", "qty", "price"]
              }
            },
            table: { type: "string", description: "Dine In only." },
            pickupAt: { type: "string", description: "Take Away only: a label such as 15 min, 30 min, 45 min or 1 hour, or an ISO timestamp." },
            address: { type: "string", description: "Delivery only." },
            note: { type: "string" },
            discountCode: { type: "string" }
          },
          required: ["handle", "name", "phone", "email", "items"]
        }
      }
    }
  };
}

/* ---------- the 404 ---------- */

function notFoundBody(opts) {
  const b = base(opts && opts.base);
  const markdown = wantsMarkdown(opts && opts.accept);

  if (markdown) {
    return {
      type: "text/markdown; charset=utf-8",
      body: [
        "# 404 — not found",
        "",
        "That address is not on " + b.replace(/^https?:\/\//, "") + ". Every live restaurant menu is a page at `/<handle>`.",
        "",
        "- [Sitemap](" + b + "/sitemap.xml): every page that exists, with its last-modified date.",
        "- [llms.txt](" + b + "/llms.txt): a Markdown map of the site for agents.",
        "- [OpenAPI description](" + b + "/openapi.json): the public menu and order endpoints.",
        "- [DigiMenu](" + b + "/): what the product is and what it costs.",
        ""
      ].join("\n")
    };
  }

  return {
    type: "text/html; charset=utf-8",
    body: "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
      "<title>Not found — " + ORG.product + "</title>\n" +
      "<meta name=\"robots\" content=\"noindex\">\n" +
      "<style>body{font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:56px 24px;color:#12141a;background:#fff}" +
      "main{max-width:560px;margin:0 auto}h1{font-size:24px;margin:0 0 10px}p{color:#545a66;margin:0 0 22px}" +
      "ul{list-style:none;padding:0;margin:0}li{padding:9px 0;border-top:1px solid #e6e8ec}" +
      "a{color:#12141a;font-weight:600;text-decoration:none}a:hover{text-decoration:underline}" +
      "span{color:#7a8090;font-size:14px;display:block}</style>\n" +
      "</head>\n<body>\n<main>\n" +
      "<h1>That address is not here.</h1>\n" +
      "<p>Every live restaurant menu is a page at <code>/&lt;handle&gt;</code> on this site. These are the ways in:</p>\n" +
      "<ul>\n" +
      "<li><a href=\"/sitemap.xml\">Sitemap</a><span>every page that exists, with the date it last changed</span></li>\n" +
      "<li><a href=\"/llms.txt\">llms.txt</a><span>a Markdown map of the site, for agents</span></li>\n" +
      "<li><a href=\"/openapi.json\">OpenAPI description</a><span>the public menu and order endpoints</span></li>\n" +
      "<li><a href=\"/\">" + ORG.product + "</a><span>what the product is and what it costs</span></li>\n" +
      "</ul>\n" +
      "</main>\n</body>\n</html>\n"
  };
}

/* ---------- the Markdown variants ----------
 * One per page an agent is likely to ask for. Written by hand against the page
 * it mirrors, because a tag-stripper turns a pricing table into confetti. */

function homeMarkdown(opts) {
  const b = base(opts && opts.base);
  const menus = (opts && opts.menus) || [];
  const L = [];

  L.push("# " + ORG.product);
  L.push("");
  L.push("> A QR menu for restaurants in the UAE that takes the order: guests scan a code, order from their phone, and every order lands in the restaurant's WhatsApp. From AED " + money(PLANS.qr.price.yearly) + " a year. No app, no commission, no hardware.");
  L.push("");
  L.push("A product of " + ORG.name + " (" + ORG.tradingAs + "), " + ORG.city + ", " + ORG.countryName + ". Prices are in AED and include 5% VAT. The full page, with photographs, is at " + b + "/.");
  L.push("");

  L.push("## The problem it solves");
  L.push("");
  L.push("A printed menu is wrong the moment the kitchen runs out. DigiMenu keeps one live menu: the owner changes a price or flips a dish to sold out on their phone, and the guest's page is already right.");
  L.push("");

  L.push("## How a guest orders");
  L.push("");
  L.push("1. The guest scans the QR code on the table, the sticker, or the link in a WhatsApp message. The menu opens in the browser — nothing to install, no account.");
  L.push("2. They pick dishes and quantities, choosing Dine In (with a table), Take Away (with a collection time) or Delivery (with an address), if the restaurant offers those.");
  L.push("3. **Review & Confirm** opens the basket one more time; **Order on WhatsApp** saves the order; **Send on WhatsApp** opens the chat with the order already written.");
  L.push("4. The order is stored before the chat opens, so it is in the owner's dashboard whichever way the chat goes.");
  L.push("");

  L.push("## Plans and prices");
  L.push("");
  L.push("| Plan | Monthly | Yearly | What it is |");
  L.push("| --- | --- | --- | --- |");
  ["qr", "order", "pro"].forEach(function (key) {
    const p = PLANS[key];
    L.push("| **" + p.label + "** | " + (p.price.monthly == null ? "—" : "AED " + money(p.price.monthly)) + " | AED " + money(p.price.yearly) + " | " + mdText(p.blurb) + " |");
  });
  L.push("");
  Object.keys(ADDONS).forEach(function (key) {
    L.push("- " + ADDONS[key].label + ": AED " + money(ADDONS[key].yearly) + " a year.");
  });
  L.push("- The free week is worth Pro. You pay when the menu is ready to go in front of a guest.");
  L.push("- QR Menu holds " + PLANS.qr.itemCap + " dishes, each with a photo. Pro and Ultra have no dish count.");
  L.push("");

  L.push("## What the owner gets");
  L.push("");
  L.push("A phone-first dashboard: orders as they arrive, the menu editor with prices, photos, sold-out switches and Arabic, a day's takings, and a publishing switch under Manage. One screen, and it fits in a pocket.");
  L.push("");

  if (menus.length) {
    L.push("## Live menus");
    L.push("");
    menus.forEach(function (m) {
      L.push("- [" + mdText(m.name || m.handle) + "](" + b + "/" + encodeURIComponent(m.handle) + "): " + mdText(m.name || m.handle) + (m.city ? " in " + mdText(m.city) : "") + ".");
    });
    L.push("");
  }

  L.push("## Machine-readable");
  L.push("");
  L.push("- [llms.txt](" + b + "/llms.txt): this map, as a file.");
  L.push("- [OpenAPI description](" + b + "/openapi.json): the public menu and order endpoints.");
  L.push("- [Sitemap](" + b + "/sitemap.xml): every indexable page with its last-modified date.");
  L.push("- Any page here also answers as Markdown: send `Accept: text/markdown`.");
  L.push("");

  L.push("## Contact");
  L.push("");
  L.push(ORG.name + " · " + ORG.city + ", " + ORG.countryName);
  L.push("Email " + ORG.email + " · Phone and WhatsApp " + ORG.phone);
  L.push("");
  L.push("- [Terms of Service](" + b + "/terms.html)");
  L.push("- [Privacy Policy](" + b + "/privacy.html)");
  L.push("");

  return L.join("\n");
}

function termsMarkdown(opts) {
  const b = base(opts && opts.base);
  return [
    "# Terms of Service",
    "",
    "> The agreement between " + ORG.name + " (" + ORG.tradingAs + ") and the restaurant that subscribes to " + ORG.product + ". Last updated 14 November 2026.",
    "",
    "The binding text is the HTML page: [" + b + "/terms.html](" + b + "/terms.html). This is a summary of what it covers, section by section.",
    "",
    "## What it says, in order",
    "",
    "1. **Who we are** — " + ORG.name + ", " + ORG.city + ", " + ORG.countryName + ", trading as " + ORG.tradingAs + ". Contact: " + ORG.email + ".",
    "2. **What the service is** — a QR menu and the ordering that goes with it, on the plan you buy.",
    "3. **Your account** — one owner, named staff logins, and who may do what.",
    "4. **The free week** — a week at Pro rights, starting when you sign up.",
    "5. **Plans, prices and payment** — " + priceLine() + ". Prices are in AED and include 5% VAT.",
    "6. **WhatsApp and Meta** — messages sent through your own WhatsApp Business number are billed by Meta, separately from us.",
    "7. **Your menu and your content** — yours; we host it for as long as you are a customer.",
    "8. **Acceptable use** — no unlawful menus, no scraping, no reselling the service.",
    "9. **Your guests and their data** — the guest's order belongs to your relationship with them; we process it for you.",
    "10. **Cancellation, suspension and refunds** — what happens when a plan lapses: the page pauses, the menu is not deleted, and nothing renews without you asking.",
    "11. **Our responsibility** — the limits of it.",
    "12. **Changes** — how new terms are announced.",
    "13. **Governing law and disputes** — the laws of the UAE as applied in the Emirate of Dubai, and the courts of Dubai.",
    "14. **Contact** — " + ORG.email + ".",
    "",
    "Read the full agreement before subscribing: " + b + "/terms.html",
    ""
  ].join("\n");
}

function privacyMarkdown(opts) {
  const b = base(opts && opts.base);
  return [
    "# Privacy Policy",
    "",
    "> What " + ORG.name + " (" + ORG.tradingAs + ") collects when you use " + ORG.product + ", why, how long it is kept, and how to get a copy or a deletion. Last updated 14 November 2026.",
    "",
    "The binding text is the HTML page: [" + b + "/privacy.html](" + b + "/privacy.html). This is a summary of what it covers, section by section.",
    "",
    "## What it says, in order",
    "",
    "1. **Who is responsible** — " + ORG.name + ", " + ORG.city + ", " + ORG.countryName + " is the controller for the accounts and sites we run. For guest data passing through a restaurant's menu, the restaurant decides and we process for them.",
    "2. **What we collect** — the account (name, email, hashed password), the restaurant profile (trading name, handle, city, contact and order numbers, address, logo, licence), technical records from sign-in, and, for a guest, the name and phone number they type, the mode, the table or address, the items, the total and any note.",
    "3. **Why we hold it** — to run the menu, take the order, and keep the record of it.",
    "4. **Guests and restaurants** — who sees which part of a guest's order.",
    "5. **Who else touches it** — the host, the database and mail providers that make the product work.",
    "6. **Cookies and local storage** — the session, and the dashboard's own state; no advertising cookies.",
    "7. **How long we keep it** — the retention for accounts, menus and orders.",
    "8. **Security** — how it is stored and who can reach it.",
    "9. **Your rights** — access, correction, deletion and objection under UAE Federal Decree-Law No. 45 of 2021 (the PDPL). Write to " + ORG.email + "; we answer within 30 days.",
    "10. **Where data is stored** — outside the UAE, with the safeguards the policy names.",
    "11. **Children** — the service is not for them.",
    "12. **Changes** — how a new policy is announced.",
    "13. **Contact** — " + ORG.email + ".",
    "",
    "Read the full policy: " + b + "/privacy.html",
    ""
  ].join("\n");
}

/* ---------- a restaurant, as Markdown ----------
 * The most useful thing an assistant can be handed about a restaurant, and the
 * one page that is generated per tenant. Prices come from the same payload the
 * guest page draws, so the two cannot disagree. */

function menuMarkdown(opts) {
  const b = base(opts && opts.base);
  const r = (opts && opts.restaurant) || {};
  const cats = (opts && opts.categories) || [];
  const handle = String((opts && opts.handle) || r.handle || "");
  const name = one(r.name) || handle;
  const currency = one(r.currency) || "AED";
  const url = b + "/" + encodeURIComponent(handle);
  const L = [];

  L.push("# " + mdText(name));
  L.push("");
  L.push("> " + (one(r.tagline) || (one(r.city) ? one(r.city) + " — the live menu" : "The live QR menu")) + ".");
  L.push("");
  if (!opts || opts.live !== false) {
    L.push("The guest page is at " + url + " — it opens in a browser, with no app and no account.");
  } else {
    L.push("This menu is not live to guests yet. The page is at " + url + ".");
  }
  L.push("");

  const facts = [];
  if (one(r.city)) facts.push("- City: " + one(r.city));
  if (one(r.address)) facts.push("- Address: " + one(r.address));
  facts.push("- Currency: " + currency);
  facts.push("- Ordering: " + (r.ordering ? "yes — Dine In, Take Away or Delivery, as the restaurant offers" : "this restaurant's plan is the menu only; the guest orders at the counter"));
  if (Array.isArray(r.locales) && r.locales.length) facts.push("- Menu languages: " + r.locales.join(", "));
  if (one(r.mapsUrl) && /^https?:\/\//i.test(one(r.mapsUrl))) facts.push("- Map: " + one(r.mapsUrl));
  L.push(facts.join("\n"));
  L.push("");

  cats.forEach(function (c) {
    const items = (c && c.items) || [];
    if (!c || !one(c.name) || !items.length) return;
    L.push("## " + mdText(c.name));
    L.push("");
    items.forEach(function (it) {
      if (!it || !one(it.name)) return;
      const bits = [currency + " " + money(it.price)];
      if (one(it.description)) bits.push(one(it.description));
      if (it.soldOut) bits.push("sold out today");
      L.push("- **" + mdText(it.name) + "** — " + bits.join(" · "));
    });
    L.push("");
  });

  L.push("---");
  L.push("");
  L.push("Ordered from the live menu at " + url + ". Prices are as the restaurant last published them, in " + currency + ".");
  L.push("A machine-readable copy of this menu is at " + b + "/api/menu?handle=" + encodeURIComponent(handle) + "; the whole site as an agent map is at " + b + "/llms.txt.");
  L.push("");

  return L.join("\n");
}

/**
 * The menu payload the guest page draws, read over HTTP so the Markdown cannot
 * disagree with the page it serves. `origin` is the host the request arrived on;
 * both callers (the agent handler and the tenant page) pass their own.
 */
async function fetchMenu(origin, handle) {
  try {
    const r = await fetch(String(origin).replace(/\/+$/, "") + "/api/menu?handle=" + encodeURIComponent(handle), {
      headers: { "user-agent": "digimenu-agent-md" }
    });
    if (!r.ok) return null;
    const body = await r.json();
    return body && body.ok ? body : null;
  } catch (e) {
    return null;
  }
}

/** A page that is not a menu and has no Markdown variant: say so, and point at the map. */
function noMarkdownPage(opts) {
  const b = base(opts && opts.base);
  return [
    "# No Markdown here",
    "",
    "That page has no Markdown variant. These do:",
    "",
    "- [" + ORG.product + "](" + b + "/)",
    "- [Terms of Service](" + b + "/terms.html)",
    "- [Privacy Policy](" + b + "/privacy.html)",
    "- any restaurant's page, at `/<handle>`",
    "- [the site map](" + b + "/llms.txt)",
    ""
  ].join("\n");
}

module.exports = {
  ORG,
  base,
  money,
  wantsMarkdown,
  priceLine,
  llmsTxt,
  openapiDoc,
  notFoundBody,
  homeMarkdown,
  termsMarkdown,
  privacyMarkdown,
  menuMarkdown,
  fetchMenu,
  noMarkdownPage
};
