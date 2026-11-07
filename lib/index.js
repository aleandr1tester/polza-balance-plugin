/**
 * Host half of dsh-polza-balance.
 *
 * AUDIT NOTES (host side)
 * - This file only keeps the plugin on the Host roster so the Loader entry
 *   exists and the browser module can be served. `apply` is intentionally empty.
 * - No network, no filesystem, no storage, no credentials, no timers, no
 *   dynamic code. The widget's only network call lives in lib/client.js
 *   (`mcpCall`, a single `fetch` to the configured polza.ai MCP endpoint).
 * - `inject`/config are declared in the browser half (lib/client.js), which is
 *   discovered through the package.json `dsh.client` declaration.
 */

/** Keep the plugin on the Host roster; the whole plugin lives in the browser half. */
export function apply() {}
