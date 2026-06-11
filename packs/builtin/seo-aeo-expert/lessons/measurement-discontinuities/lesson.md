# Measurement discontinuities and the 2026 tracking stack

**Confidence: [H]** (Google primary sources + replicated analyses)

Two hard discontinuities make naive trend analysis wrong:

1. **2025-09 `num=100` removal** — 87.7% of sites lost GSC impressions and
   average position "improved" overnight (bot impressions removed). Artifact,
   not ranking change.
2. **2026-05 AI Mode default** — click/CTR baselines shift again.

GSC's **"Generative AI performance" report** (2026-06, data from 2026-05-18):
impressions only — no clicks, no queries, no API/BigQuery; manual CSV export.
Before it, AI Mode data was silently lumped into "Web" totals.

**LLM referrals:** typically <2% of referral traffic but convert ~3x
(Microsoft Clarity; multiple datasets). Track in GA4 with referrer regex
(chatgpt.com, perplexity.ai, gemini.google.com, copilot.microsoft.com) —
note Gemini/AI-Mode referrals are largely indistinguishable from google.com
organic. Referral mix is shifting: ChatGPT 86.7%→64.5% of LLM referrals in a
year; Gemini 5.7%→21.5%.

**How to apply:** annotate both discontinuity dates in every dashboard;
never compare across them without correction; add the GA4 LLM-referral
segment before any AEO work so before/after is measurable.

**Evidence:** https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports ·
https://zeo.org/resources/blog/the-impact-of-num-100-parameter-removal-on-seo-reporting ·
https://clarity.microsoft.com/blog/ai-traffic-converts-at-3x-the-rate-of-other-channels-study/
