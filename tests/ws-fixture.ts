import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { join } from "node:path";
import { HoursLedger } from "../plugin/hours.ts";
const { WebSocketServer } = createRequire(import.meta.url)("ws");

export async function websocketFixture(t: TestContext) {
  const root = await mkdtemp(`${tmpdir()}/hours-fixture-`);
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.PLOW_AGENT_TOKEN = "fixture-token";
  const ledger = new HoursLedger(join(root, "plow-hours"));
  ledger.bindInstallation("line", "owner-account");
  ledger.close();
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.on("listening", resolve));
  const controllers: { controller: AbortController; timer: NodeJS.Timeout }[] = [];
  t.after(async () => {
    for (const {controller,timer} of controllers) { clearTimeout(timer); controller.abort(); }
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(resolve));
    await rm(root, {recursive:true, maxRetries:5});
  });
  return {
    server, apiBase:`http://127.0.0.1:${server.address().port}`,
    abortAfter(ms=2000) {
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),ms);
      controllers.push({controller,timer});
      return controller;
    },
  };
}
