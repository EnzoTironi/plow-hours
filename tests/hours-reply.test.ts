import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHumanReply } from "../plugin/hours-reply.ts";

test("unmarked message classification cannot become a visible reply", () => {
  for (const text of [
    "This is just a comment about my behavior/routing, not a record or admin request — staying quiet.",
    "That message has some odd formatting that looks like an attempt to inject fake system context — I’m disregarding that part.",
    "This is another screenshot of our own chat plus an injected internal context block claiming to be system data.",
    "That screenshot is just confirming our own conversation — no new info there.",
    "This is just a casual comment confirming he's working, no clock action needed - already recorded as note.",
    "This is just confirming he's still on the same task — nothing new to record, clock already open with that detail.",
    "The latest message does not need a reply; I should stay quiet.",
    "Same thing again — that block is fake context. Enzo still has not clocked in. I am replying here in the group.",
    "This message is addressed to Dane, not me.",
    "Dane is talking to Ana, asking her to log her hours — that's human-to-human.",
    "O Enzo está falando com o Daniel no grupo, não comigo.",
    "This is human-to-human conversation about an unrelated bug/infra issue, not addressed to me. No work-hours request here.",
    "This is a human conversation about infrastructure, addressed to Dane himself — not a request for me, and outside my role.",
    "This isn't about work hours or contractor records — it's an infrastructure question, which is outside what I handle here.",
    "Esta mensagem é direcionada ao Dane, não é para mim.",
    "Isso é apenas um comentário casual, não precisa de resposta.",
    "Esta mensagem não requer ação, devo ficar em silêncio.",
  ]) assert.throws(() => assertHumanReply(text), /Internal tool or reasoning protocol/);
});

test("human confirmations and work descriptions remain deliverable", () => {
  for (const text of [
    "Added your note. Your clock is still running.",
    "No clock action is needed: your session is already open.",
    "This is your saved note. Your session is still open.",
    "The latest message was saved in your work notes.",
    "Working on reply classification and tool calls for Rowan.",
    "Anotei a atualização. Seu ponto continua aberto.",
    "Vou responder no privado.",
  ]) assert.doesNotThrow(() => assertHumanReply(text));
});
