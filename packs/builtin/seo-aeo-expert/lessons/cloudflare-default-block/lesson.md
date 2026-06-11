# Cloudflare blocks AI bots by default — audit before assuming AI visibility

**Confidence: [H]** (Cloudflare primary sources)

Since 2025-07, Cloudflare blocks AI crawlers **by default for new zones**
(one-click block for existing); pay-per-crawl (HTTP 402) is in closed beta.
Webflow and other hosts ship similar defaults. Consequence: sites are
routinely _unintentionally_ invisible to AI engines while their robots.txt
looks permissive — the CDN eats the bot before robots.txt matters.

**How to apply:** the "am I accidentally blocking citation bots?" audit is
the single highest-yield AEO check for any Cloudflare/Webflow-fronted site:
verify AI Crawl Control settings against declared bot policy, then confirm
with server logs (search-bot user agents actually fetching 200s). Re-check
after any CDN/WAF change. Bot classes: [[bot-taxonomy-three-classes]].

**Evidence:** https://blog.cloudflare.com/introducing-pay-per-crawl/ ·
https://developers.cloudflare.com/ai-crawl-control/features/manage-ai-crawlers/
