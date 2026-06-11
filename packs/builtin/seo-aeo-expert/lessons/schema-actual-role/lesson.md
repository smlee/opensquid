# Schema's actual role in AI search — useful, but not where vendors claim

**Confidence: [H]** on the confirmed parts; **[C]** flagged on the folklore

**Confirmed:** Microsoft's Fabrice Canel (SMX Munich 2025-03): Bing/Copilot
**do use schema markup to help their LLMs understand content**. Schema
remains required for rich results and Merchant Center eligibility, and aids
entity disambiguation. **Also confirmed:** Google's official guide —
structured data is **not required** for Google AI features.

**Folklore (do not encode):** "schema = 2.5x citation chance", "40% more
AIO appearances", "schema is the language of LLM tokenization" — no credible
methodology behind any of these (the tokenization claim is technically false).

**How to apply:** ship schema for rich results, Merchant Center, Bing/Copilot
comprehension, and entity grounding — server-side rendered
([[no-js-execution]]), validator-checked ([[freehand-schema-forbidden]]).
Never sell it internally as a Google AI-citation lever.

**Evidence:** https://searchengineland.com/microsoft-bing-copilot-use-schema-for-its-llms-453455 ·
https://developers.google.com/search/docs/fundamentals/ai-optimization-guide ·
https://searchengineland.com/schema-markup-ai-search-no-hype-472339
