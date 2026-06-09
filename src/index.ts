/**
 * opensquid public entry. opensquid ships via its `bin` entrypoints (CLI + hooks) and the MCP
 * servers — it exposes no library root API. (The former `./engine/*` re-export was removed when the
 * loop-engine subsystem was retired; opensquid is fully engine-free.)
 */
export {};
