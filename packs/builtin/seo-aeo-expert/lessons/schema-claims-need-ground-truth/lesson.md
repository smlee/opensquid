# Schema is claim-bearing — syntactic validation cannot catch fiction

**Confidence: [H]** (first-principles + live incident, 2026-06-10)

Structured data sits at the intersection where "technical SEO" stops being
business-agnostic: every Offer, Service, price, availability, and
description in JSON-LD is a **statement of business fact**. Validators
(ajv, Rich Results Test, Schema.org) check the _syntactic_ layer only.
Among claim types, only dates self-falsify (`validThrough` in the past).
Wrong prices, nonexistent products, and wrong capacities pass every
validator — and AI engines extract and repeat them verbatim.

**The incident that proved it:** a boutique-studio site served a
syntactically perfect OfferCatalog advertising a product that did not exist
("Group — $350 one-month unlimited") with wrong rates across the board —
generated from a stale code-side data table, invisible on the rendered page
(client-rendered UI), visible to every AI engine, for weeks. No validator
or HTML audit could have caught it; only the owner could.

**How to apply — the claims-free / claim-bearing boundary:**

- Claims-free (canonicals, hreflang, title length, redirects, rendering):
  verify mechanically, ship on green checks.
- Claim-bearing (any schema node describing offerings/prices/people/hours):
  every value must trace to a **ground-truth source** — the live
  API/database the visible UI renders from, or explicit owner confirmation.
  Never a parallel static file ([[freehand-schema-forbidden]] covers shape;
  this lesson covers TRUTH).
- Before auditing a site's offerings, find where the catalog actually
  lives. If the UI is client-rendered, the HTML lies by omission — to
  crawlers AND to you ([[no-js-execution]]).
- Maintain a business ground-truth doc (real lineup, hard rules, known
  anti-sources) loaded at session start; schema work without it is
  fiction-risk, not SEO.
