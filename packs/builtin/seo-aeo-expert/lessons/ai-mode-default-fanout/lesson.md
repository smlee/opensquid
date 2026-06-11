# AI Mode is the default Google experience — optimize for query fan-out

**Confidence: [H]** (Google primary sources)

At I/O 2026 (2026-05-19) AI Mode became the global default Google Search
experience (1B+ monthly users). Architecture per Google's own docs: RAG
grounded in core Search ranking + **query fan-out** — one query expands into
many concurrent sub-queries, each retrieving independently.

**How to apply:** optimize pages to win fan-out _sub-queries_, not just head
terms. Each self-contained section that fully answers one sub-question is a
retrieval candidate. Coverage of the question-space around a topic beats one
monolithic page targeting one phrase. See [[chunk-shape]].

**Evidence:** https://developers.google.com/search/docs/fundamentals/ai-optimization-guide ·
https://blog.google/products-and-platforms/products/search/search-io-2026/ (2026-05)
