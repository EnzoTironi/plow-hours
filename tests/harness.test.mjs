// The no-Docker harness, run on the host: `node --test tests/*.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dockerEnv, pinnedBase } from "../scripts/harness-lib.mjs";

const SHA = "ddbaa6bc0f9e071d9411777b91590e755e367d84";
const DIGEST = "5b0ebf5e33514b09f0f22f1c14424a19b4eb3fc21adfaeb260002f76d362478c";

test("the harness tests the base the Dockerfile pins, and refuses an unpinned base", () => {
  assert.equal(pinnedBase(`# comment\nFROM public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-${SHA}@sha256:${DIGEST}\nUSER root\n`), SHA);
  for (const from of [`plow-cloud-agents@sha256:${DIGEST}`, `plow-cloud-agents:base-${SHA}`, "plow-cloud-agents:latest"]) {
    assert.throws(() => pinnedBase(`FROM public.ecr.aws/e1h7x4a2/${from}\n`), /must pin the base/);
  }
});

test("the harness reads ENV the way Docker does, quoted values included", () => {
  assert.deepEqual(dockerEnv('ENV A=1 B="two words" C=\nENV D=x\nRUN E=no\n'), { A: "1", B: "two words", C: "", D: "x" });
  const env = dockerEnv(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"));
  assert.equal(env.AGENT_ID, "ours");
  assert.equal(env.AGENT_BLURB, "Track contractor hours in iMessage. Keep the timesheet and invoice paperwork in one place.");
});

test("the path map puts the image's files and databases under the local root and leaves the rest alone", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ours-map-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ours-outside-")));
  try {
    const probe = join(outside, "probe.mjs");
    writeFileSync(probe, `
      import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      mkdirSync("/var/lib/plow/plow-hours", { recursive: true });
      writeFileSync("/var/lib/plow/plow-hours/note.txt", "/opt/plow is text, not a path");
      new DatabaseSync("/var/lib/plow/plow-hours/test.sqlite").exec("CREATE TABLE t (x)");
      const builtin = new (process.getBuiltinModule("node:sqlite").DatabaseSync)("/var/lib/plow/builtin.sqlite");
      builtin.exec("CREATE TABLE t (x)");
      writeFileSync(${JSON.stringify(join(outside, "untouched.txt"))}, "ok");
      console.log(JSON.stringify({ note: readFileSync("/var/lib/plow/plow-hours/note.txt", "utf8"), app: existsSync("/app") }));
    `);
    const output = execFileSync(process.execPath, ["--import", fileURLToPath(new URL("../scripts/local-root.mjs", import.meta.url)), probe],
      { env: { ...process.env, OURS_LOCAL_ROOT: root }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), { note: "/opt/plow is text, not a path", app: false });
    assert.ok(existsSync(join(root, "var/lib/plow/plow-hours/note.txt")), "fs writes land under the root");
    assert.ok(existsSync(join(root, "var/lib/plow/plow-hours/test.sqlite")), "ESM node:sqlite opens land under the root");
    assert.ok(existsSync(join(root, "var/lib/plow/builtin.sqlite")), "getBuiltinModule node:sqlite opens land under the root");
    assert.ok(existsSync(join(outside, "untouched.txt")), "other paths are not remapped");
    assert.ok(!existsSync("/var/lib/plow/plow-hours/note.txt"), "nothing is written to the real /var/lib/plow");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
