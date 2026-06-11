# No major AI crawler executes JavaScript — SSR/SSG is a hard gate

**Confidence: [H]** (replicated; Vercel study + 500M-fetch analysis)

Analysis of 500M+ GPTBot fetches found **zero JS execution**; Vercel's AI
crawler study (2024-12) established it and it remains true in 2026.
Googlebot is the only full-rendering crawler; Bingbot renders partially —
and ChatGPT depends on Bing's index. Client-side-rendered content is
therefore invisible to ChatGPT, Claude, and Perplexity.

**How to apply:** indexable content must be in the server-rendered HTML
(SSR/SSG). In Next.js: pages and layouts stay server components; `"use
client"` belongs at the interactive leaf. Verify with `curl` (no JS) — what
you see is what AI engines see. JSON-LD must also be server-side
([[schema-actual-role]]).

**Evidence:** https://vercel.com/blog/the-rise-of-the-ai-crawler ·
https://www.asklantern.com/blogs/ai-crawlers-do-not-render-javascript
