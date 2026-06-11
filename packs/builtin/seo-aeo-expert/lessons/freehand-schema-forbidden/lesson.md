# Freehand LLM-generated JSON-LD is forbidden — validator before ship

**Confidence: [M]** (practitioner consensus, consistent across 2026 reviews)

The 2026 agent-SEO consensus: "AI is absolutely horrible at writing schema"
freehand — hallucinated properties, wrong enum values, missing required
fields (priceValidUntil, reviewCount), invalid nesting. The failures are
silent: pages render fine while rich-result eligibility quietly dies.

**How to apply (the rule):** every JSON-LD change passes a validator before
push — `ajv` against schema.org definitions, Google Rich Results Test, or
Schema.org validator. Product offers additionally need priceValidUntil +
MerchantReturnPolicy + OfferShippingDetails for Merchant eligibility.
AggregateRating needs reviewCount/ratingCount. Schema must be in
server-rendered HTML ([[no-js-execution]]). The schema-validation-gate skill

- ops FSM enforce this: JSON-LD edits open the cycle, a validator run closes
  it, pushing while open gets flagged.

**Evidence:** https://www.frase.io/blog/ai-agents-for-seo ·
https://aimultiple.com/seo-ai (agent-workflow reliability reviews, 2026)
