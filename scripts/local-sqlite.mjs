// Test-only stand-in for node:sqlite, served by scripts/local-root.mjs so the ledger's
// absolute database path lands under OURS_LOCAL_ROOT like every other file.
// local-root.mjs has already replaced the builtin's DatabaseSync with the mapping class.
const sqlite = process.getBuiltinModule("node:sqlite");

export const { DatabaseSync, StatementSync, Session, constants, backup } = sqlite;
export default { ...sqlite, DatabaseSync };
