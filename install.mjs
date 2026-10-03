import { cp, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const plugin='/opt/plow/plugin';
await cp('/opt/plow/hours-source/plugin', plugin, {recursive:true});

function replaceOnce(source, before, after) {
  if (source.split(before).length!==2) throw new Error('Pinned Plow base contract changed: '+before.slice(0,80));
  return source.replace(before,after);
}

let entry=await readFile(plugin+'/index.ts','utf8');
const membersLine = entry.split('\n').find(line => line.includes('description: "Recipient phone numbers in E.164 format.'));
if (!membersLine) throw new Error('Pinned Plow group members contract changed');
const phonePattern = JSON.stringify('^\\+[1-9][0-9]{1,14}$');
entry=replaceOnce(entry,membersLine,`          members: { type: "array", minItems: 1, items: { type: "string", anyOf: [{ pattern: ${phonePattern} }, { format: "email" }] }, description: "International phone numbers or iMessage email handles. The owner is included automatically." },`);
entry=replaceOnce(entry,'Accepts phone numbers, not chat ids or email addresses.','Accepts international phone numbers or iMessage email handles, never chat IDs.');
entry='import { clockHours, contractorGroupPrompt, hoursGroup, registerHours } from "./hours-channel.ts";\nimport { clockSourceSchema, hoursEnabled, hoursLedger } from "./hours.ts";\nimport { workText } from "./hours-period.ts";\nimport { registerHoursWeb } from "./hours-web.ts";\n'+entry;
const route='  const route = runtime.channel.routing.resolveAgentRoute({ cfg, channel: "plow", accountId: account.accountId, peer });';
entry=replaceOnce(entry,route,route+`\n  const confirmation = clockHours({ account, chat, message, senderIsOwner });
  if (confirmation !== undefined) {
    ingress.onSubmitted();
    await durableSend(cfg, route, account.accountId, chat.uid, chat.uid, confirmation, kind);
    return "completed";
  }`);
const bodyAnchor='  const body = message.body ||';
entry=replaceOnce(entry,bodyAnchor,`  const hoursRestricted = hoursEnabled() && account.accountId === "chat" && (kind === "group" || !senderIsOwner);
  const hoursContractor = hoursRestricted ? hoursGroup(account, chat) : undefined;
${bodyAnchor}`);
const access='access: { commands: { authorized: senderIsOwner }, ...(email ?';
entry=replaceOnce(entry,access,'access: { commands: { authorized: senderIsOwner && !hoursRestricted }, ...(hoursRestricted ? { toolPolicy: { allow: ["plow_hours_self"] } } : {}), ...(email ?');
const turnLog='  log(`turn ${JSON.stringify({ chat: chat.uid, message: message.uid, first_contact: firstContact, senderId, senderName, senderIsOwner, sessionKey: route.sessionKey })}`);';
entry=replaceOnce(entry,turnLog,`  if (hoursContractor && sender.type === "member" && !senderIsOwner) {
    const hoursSource = {
      line_uid: account.lineUid, chat_uid: chat.uid, handle: sender.provider_key,
      message_uid: message.uid, created_at: message.created_at, body: message.body,
    };
    ctxPayload.GatewayRunToolBindings = { plowHoursClock: hoursSource };
    const hoursAttempt = hoursLedger().clockAttempt(hoursSource);
    if (hoursAttempt > 1) {
      const retryId = message.uid + ":hours-retry-" + hoursAttempt;
      ctxPayload.MessageSid = retryId;
      ctxPayload.MessageSidFull = retryId;
    }
  }
${turnLog}`);
entry=replaceOnce(entry,turnLog,`  if (hoursEnabled() && account.accountId === "chat" && senderIsOwner && kind === "direct" && sender.type === "member") {
    ctxPayload.GatewayRunToolBindings = { plowHoursOwner: {
      line_uid: account.lineUid, chat_uid: chat.uid, handle: sender.provider_key,
      message_uid: message.uid, created_at: message.created_at, body: message.body,
    } };
  }
${turnLog}`);
entry=replaceOnce(entry,'  const body = message.body ||', '  const body = (hoursRestricted ? workText(message.body) : message.body) ||');
entry=replaceOnce(entry,'      body: m.body, timestamp:', '      body: hoursRestricted ? workText(m.body) : m.body, timestamp:');
entry=replaceOnce(entry,'body: message.reply_to.body, sender:', 'body: hoursRestricted ? workText(message.reply_to.body) : message.reply_to.body, sender:');
const prompt='      ...(email ? { groupSystemPrompt: emailTurnPrompt(chat, persona ?? "the assistant") } : {}),';
const preparePayload='      preparePayload: (payload, info) => {';
entry=replaceOnce(entry,preparePayload,preparePayload+`\n        if (hoursRestricted && payload.isError) {
          failure = new Error("Contractor turn could not complete");
          const source = ctxPayload.GatewayRunToolBindings?.plowHoursClock;
          if (source && !hoursLedger().claimFailureNotice(clockSourceSchema.parse(source))) return null;
          return { ...payload, text: "Não consegui processar sua mensagem agora. Ela ficou pendente, e vou tentar novamente com o horário original. Não confirmei nenhuma alteração neste aviso.", replyToId: undefined, replyToCurrent: false };
        }`);
entry=replaceOnce(entry,prompt,prompt+`\n      ...(hoursRestricted ? { groupSystemPrompt: hoursContractor
        ? contractorGroupPrompt(hoursContractor.id)
        : "You are Plow Hours. This is not an authorized contractor group. You have no access to contractor records or owner data here. Ask the person to use the group containing the owner, this agent and that registered contractor. Do not register, grant permissions, change records or disclose other conversations." } : {}),`);
entry=replaceOnce(entry,'...(!email && !chat.trusted && !senderIsOwner ? { disableTools: true } : {}),','...(hoursRestricted ? { disableTools: !hoursContractor } : !email && !chat.trusted && !senderIsOwner ? { disableTools: true } : {}),');
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

let transport=await readFile(plugin+'/transport.ts','utf8');
transport='import { hoursEnabled, hoursLedger, normalizeHandle } from "./hours.ts";\n'+transport;
const dispatch='  const dispatchTurn = async ({ chat, message }: Queued, onSubmitted: () => void) => {';
transport=replaceOnce(transport,dispatch,dispatch+`\n    const hoursTurn = hoursEnabled() && account.accountId === "chat" && !!hoursLedger().groupContractor(chat.uid);`);
transport=replaceOnce(transport,'onAdopted: () => acknowledge("adoption")','onAdopted: () => hoursTurn ? Promise.resolve() : acknowledge("adoption")');
transport=replaceOnce(transport,'    else if (outcome === "incomplete") pending.delete(message.uid);',`    else if (outcome === "incomplete") {
      pending.delete(message.uid);
      if (hoursTurn && !signal.aborted) throw new Error("Contractor message remains pending for recovery");
    }`);
transport=replaceOnce(transport,'    if (outcome === "completed") await acknowledge("terminal");',`    if (outcome === "completed") {
      await acknowledge("terminal");
      if (hoursTurn) hoursLedger().completeClockMessage(account.lineUid, chat.uid, message.uid);
    }`);
transport=replaceOnce(transport,'    if (signal.aborted || seen.has(message.uid) || checkpoints.get(chatUid) === message.uid || recent.get(chatUid)?.has(message.uid) || pending.has(message.uid)) return;',`    const retryingHours = hoursEnabled() && hoursLedger().isPendingClockMessage(account.lineUid, chatUid, message.uid);
    if (signal.aborted || pending.has(message.uid) || (!retryingHours && (seen.has(message.uid) || checkpoints.get(chatUid) === message.uid || recent.get(chatUid)?.has(message.uid)))) return;`);
transport=replaceOnce(transport,'        const window = await recover(account, chatUid, checkpoint, log);',`        const window = await recover(account, chatUid, checkpoint, log);
        const savedHours = hoursEnabled() ? hoursLedger().pendingClockMessages(account.lineUid, chatUid) : [];
        if (savedHours.length) {
          const chat = await request<Chat>(account, \`/chats/\${chatUid}\`);
          for (const source of savedHours) {
            if (window.some(message => message.uid === source.message_uid)) continue;
            const sender = chat.participants.find(p => p.type === "member" && p.role !== "owner" && normalizeHandle(p.provider_key) === normalizeHandle(source.handle));
            if (!sender || sender.type !== "member") continue;
            window.push({ uid: source.message_uid, body: source.body, created_at: source.created_at, direction: "inbound", sender, attachments: [] });
          }
          window.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        }`);
transport=replaceOnce(transport,'    await submitted;', `    if (hoursEnabled() && account.accountId === "chat" && hoursLedger().groupContractor(chat.uid)) await task;
    else await submitted;`);
await writeFile(plugin+'/transport.ts',transport);

const manifest=JSON.parse(await readFile(plugin+'/openclaw.plugin.json','utf8'));
manifest.contracts.tools.push('plow_hours','plow_hours_self');
await writeFile(plugin+'/openclaw.plugin.json',JSON.stringify(manifest,null,2)+'\n');
let config=await readFile('/opt/plow/boot/config.ts','utf8');
config='import { HoursLedger } from "../plugin/hours.ts";\n'+config;
config=replaceOnce(config,'  const name = identity.agent?.name;', `  const ownerUids = [...new Set(identity.chats.filter(chat => chat.status === "active").flatMap(chat => chat.participants
    .filter(p => p.type === "member" && p.role === "owner").map(p => p.type === "member" ? p.uid : "")))];
  if (process.env.PLOW_HOURS === "1") {
    if (ownerUids.length !== 1 || !ownerUids[0]) throw new Error("Plow Hours needs exactly one authenticated owner identity.");
    const ledger = new HoursLedger(join(process.env.OPENCLAW_STATE_DIR ?? "/var/lib/plow", "plow-hours"));
    try { ledger.bindInstallation(identity.line.uid, ownerUids[0]); } finally { ledger.close(); }
  }
  const name = identity.agent?.name;`);
config=replaceOnce(config,'userHeader: "x-plow-user", allowLoopback: true,','userHeader: "x-plow-user", allowLoopback: true, allowUsers: [...ownerUids, ...(process.env.PLOW_HOURS_LOCAL === "1" ? ["dev-owner"] : [])],');
config=replaceOnce(config,'  const name = identity.agent?.name;','  const name = process.env.AGENT_NAME ?? identity.agent?.name;');
config=replaceOnce(config,'"plow_send_email"]','"plow_send_email", ...(process.env.PLOW_HOURS === "1" ? ["plow_hours", "plow_hours_self"] : [])]');
config=replaceOnce(config,'"automations", "read", "write", "edit", "exec",', '"automations",');
config=replaceOnce(config,'deny: ["ask_user"]', 'deny: ["ask_user", "exec", "read", "write", "edit", "apply_patch"]');
await writeFile('/opt/plow/boot/config.ts',config);
let main=await readFile('/opt/plow/boot/main.js','utf8');
main='import { startHoursBackups } from "../hours-source/backup.mjs";\n'+main;
main=replaceOnce(main,'  startAgentIndex(300_000, writeLog);', '  startHoursBackups();\n  startAgentIndex(300_000, writeLog);');
await writeFile('/opt/plow/boot/main.js',main);

for (const [source,destination] of [
  [plugin+'/index.ts',plugin+'/dist/index.js'],
  [plugin+'/transport.ts',plugin+'/dist/transport.js'],
  [plugin+'/hours.ts',plugin+'/dist/hours.js'],
  [plugin+'/hours-billing.ts',plugin+'/dist/hours-billing.js'],
  [plugin+'/hours-period.ts',plugin+'/dist/hours-period.js'],
  [plugin+'/hours-channel.ts',plugin+'/dist/hours-channel.js'],
  [plugin+'/hours-web.ts',plugin+'/dist/hours-web.js'],
  ['/opt/plow/boot/config.ts','/opt/plow/boot/config.js'],
]) {
  const text=await readFile(source,'utf8');
  await writeFile(destination,stripTypeScriptTypes(text.replaceAll(/(from "\.\/[^"\n]+)\.ts"/g,'$1.js"')));
}
await cp(plugin+'/hours-web',plugin+'/dist/hours-web',{recursive:true});
await writeFile('/opt/plow/probe','#!/usr/bin/env node\nimport "./hours-source/probe.mjs";\n',{mode:0o755});
await writeFile('/opt/plow/hours-backup','#!/usr/bin/env node\nimport { runBackupCli } from "./hours-source/backup.mjs";\nawait runBackupCli(process.argv.slice(2));\n',{mode:0o755});
