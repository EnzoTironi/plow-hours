// Test-only preload for scripts/test-local.mjs. Never copied into the image.
//
// The image's code and tests address the filesystem by absolute path: /opt/plow,
// /opt/ours, /var/lib/plow, /etc/plow and /app. A developer Mac cannot create those
// without root, so this maps each one under OURS_LOCAL_ROOT, for fs, node:sqlite and
// module resolution alike. Everything else is untouched.
import fs from "node:fs";
import module from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.OURS_LOCAL_ROOT;
if (!root || !root.startsWith("/")) throw new Error("OURS_LOCAL_ROOT must be an absolute path");
const PREFIXES = ["/opt/plow", "/opt/ours", "/var/lib/plow", "/etc/plow", "/app"];

export function mapPath(path) {
  for (const prefix of PREFIXES) {
    if (path === prefix || path.startsWith(prefix + "/")) return root + path;
  }
  return path;
}

function mapArg(value) {
  if (typeof value === "string") return mapPath(value);
  if (value instanceof URL && value.protocol === "file:") {
    const mapped = mapPath(fileURLToPath(value));
    return mapped === fileURLToPath(value) ? value : pathToFileURL(mapped);
  }
  return value;
}

// Functions whose first two arguments are both paths. Every other function maps its
// first argument only, so file contents passed to writeFile are never rewritten.
const TWO_PATHS = new Set(["cp", "copyFile", "rename", "link", "symlink"]);

function wrap(target) {
  for (const [name, fn] of Object.entries(target)) {
    if (typeof fn !== "function" || /^[A-Z]/.test(name) || fn.__oursMapped) continue;
    const paths = TWO_PATHS.has(name.replace(/Sync$/, "")) ? 2 : 1;
    const mapped = function (...args) {
      for (let i = 0; i < Math.min(paths, args.length); i++) args[i] = mapArg(args[i]);
      return fn.apply(this, args);
    };
    Object.defineProperties(mapped, Object.getOwnPropertyDescriptors(fn));
    mapped.__oursMapped = true;
    target[name] = mapped;
  }
}

wrap(fs);
wrap(fs.promises);

// The ledger opens SQLite by absolute path. Code that reaches node:sqlite through
// process.getBuiltinModule gets the builtin's own export, so that is replaced too.
const sqlite = process.getBuiltinModule("node:sqlite");
const { DatabaseSync } = sqlite;
sqlite.DatabaseSync = class extends DatabaseSync {
  constructor(path, ...rest) { super(mapArg(path), ...rest); }
};

module.syncBuiltinESMExports();

// node:sqlite's named ESM exports are not live bindings, so ESM importers get a
// stand-in module that exports the mapping class instead.
const SQLITE = new URL("./local-sqlite.mjs", import.meta.url).href;
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:sqlite" && context.parentURL !== SQLITE) return { url: SQLITE, shortCircuit: true };
    if (specifier.startsWith("/")) return nextResolve(mapPath(specifier), context);
    if (specifier.startsWith("file:")) return nextResolve(mapArg(new URL(specifier)).href, context);
    return nextResolve(specifier, context);
  },
});
