import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHumanReply } from "../plugin/hours-reply.ts";

test("unmarked message classification cannot become a visible reply", () => {
  for (const text of [
    "This is just a casual comment confirming he's working, no clock action needed - already recorded as note.",
    "This is just confirming he's still on the same task — nothing new to record, clock already open with that detail.",
    "The latest message does not need a reply; I should stay quiet.",
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
