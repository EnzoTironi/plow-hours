import { cp, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const plugin='/opt/plow/plugin';
await cp('/opt/plow/hours-source/plugin', plugin, {recursive:true});

function replaceOnce(source, before, after) {
  if (source.split(before).length!==2) throw new Error('Pinned Plow base contract changed: '+before.slice(0,80));
  return source.replace(before,after);
}

let entry=await readFile(plugin+'/index.ts','utf8');
entry='import { clockHours, registerHours } from "./hours-channel.ts";\nimport { registerHoursWeb } from "./hours-web.ts";\n'+entry;
const route='  const route = runtime.channel.routing.resolveAgentRoute({ cfg, channel: "plow", accountId: account.accountId, peer });';
entry=replaceOnce(entry,route,route+`\n  const confirmation = clockHours({ account, chat, message, senderIsOwner });
  if (confirmation !== undefined) {
    ingress.onSubmitted();
    await durableSend(cfg, route, account.accountId, chat.uid, chat.uid, confirmation, kind);
    return "completed";
  }`);
entry=replaceOnce(entry,'if (api.registrationMode === "full") api.logger.info("plow channel registered");',`if (api.registrationMode === "full") {
      registerHoursWeb(api);
      api.logger.info("plow channel registered");
    }`);
entry=replaceOnce(entry,'  registerCapabilities(api) {',`  registerCapabilities(api) {
    registerHours(api, async context => {
      if (!context.config) throw new Error("Plow configuration is unavailable.");
      const account = plugin.config.resolveAccount(context.config, "chat");
      return { account, ...await ownerDmTurn(account, context) };
    });`);
await writeFile(plugin+'/index.ts',entry);

const manifest=JSON.parse(await readFile(plugin+'/openclaw.plugin.json','utf8'));
manifest.contracts.tools.push('plow_hours');
await writeFile(plugin+'/openclaw.plugin.json',JSON.stringify(manifest,null,2)+'\n');
let config=await readFile('/opt/plow/boot/config.ts','utf8');
config=replaceOnce(config,'"plow_send_email"]','"plow_send_email", ...(process.env.PLOW_HOURS === "1" ? ["plow_hours"] : [])]');
await writeFile('/opt/plow/boot/config.ts',config);

for (const [source,destination] of [
  [plugin+'/index.ts',plugin+'/dist/index.js'],
  [plugin+'/hours.ts',plugin+'/dist/hours.js'],
  [plugin+'/hours-channel.ts',plugin+'/dist/hours-channel.js'],
  [plugin+'/hours-web.ts',plugin+'/dist/hours-web.js'],
  ['/opt/plow/boot/config.ts','/opt/plow/boot/config.js'],
]) {
  const text=await readFile(source,'utf8');
  await writeFile(destination,stripTypeScriptTypes(text.replaceAll(/(from "\.\/[^"\n]+)\.ts"/g,'$1.js"')));
}
await cp(plugin+'/hours-web',plugin+'/dist/hours-web',{recursive:true});
await writeFile('/opt/plow/probe','#!/usr/bin/env node\nimport "./hours-source/probe.mjs";\n',{mode:0o755});
