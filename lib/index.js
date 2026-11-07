/**
 * Host half of dsh-polza-balance.
 *
 * The whole plugin lives in the browser half (`exports["./client"]`, discovered
 * through the package.json `dsh.client` declaration). This empty `apply` keeps
 * the plugin on the host roster so the Loader entry exists and the client module
 * system can serve the bundle.
 */
export function apply() {}
