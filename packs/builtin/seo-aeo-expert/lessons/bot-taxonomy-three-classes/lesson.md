# Three AI bot classes — know which one you are blocking

**Confidence: [H]** (vendor primary docs)

| Class           | Bots                                                                                                    | Blocking it means                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Training        | GPTBot, ClaudeBot, Google-Extended, Bytespider, Meta-ExternalAgent, CCBot                               | content not in future training sets — legitimate choice, NO search-visibility cost |
| Search/citation | **OAI-SearchBot** (ChatGPT Search), **Claude-SearchBot**, **PerplexityBot**, **Bingbot**, **Googlebot** | removed from that engine's ANSWERS — total visibility loss there                   |
| User-fetch      | ChatGPT-User, Perplexity-User                                                                           | live page fetches on user request fail                                             |

Two traps: **Google-Extended does NOT control AI Overviews/AI Mode**
(Googlebot does — blocking Google-Extended only affects Gemini Apps
grounding). **GPTBot does not control ChatGPT Search** (OAI-SearchBot does);
ChatGPT also dies with Bingbot because its index is Bing ([[bing-is-chatgpt]]).

**How to apply:** never block a search/citation bot without an explicit
business decision. Audit robots.txt AND the CDN layer
([[cloudflare-default-block]]) — both can block independently.

**Evidence:** https://developers.openai.com/api/docs/bots ·
https://nohacks.co/blog/ai-user-agents-landscape-2026
