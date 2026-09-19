// Moved into the vendored MCP package so the bridge, the bundler and the
// test harness all resolve one copy. This re-export keeps the existing
// scripts, CLI and tests working against the same implementation.
export * from '../../vendor/gpt-repo-mcp/src/github-pages/http.mjs';
