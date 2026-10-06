import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerAddressesAgent } from "../plugin/hours-channel.ts";

// Issue #19: in a contractor group the owner shared a bare link with the contractor and the agent asked the group
// what to do with it. Owner group messages reach the model only when they name the agent or reply to it.
const owner = { type: "member" as const, uid: "owner", role: "owner", display_name: "Daniel", provider_key: "+15550000001" };
const contractor = { type: "member" as const, uid: "plucas", role: "member", display_name: "Plucas", provider_key: "+15550000009" };
const self = { type: "agent" as const, relationship: "self", line: { uid: "ln_p4", display_name: "Elm" } };
const group = { uid: "cht_plucas", status: "active", trusted: false, participants: [owner, contractor, self] };
const message = (body: string, reply_to?: object) => ({ uid: "m", direction: "inbound", body, sender: owner,
  created_at: "2026-10-05T22:16:05-07:00", attachments: [], ...(reply_to ? { reply_to } : {}) }) as Parameters<typeof ownerAddressesAgent>[1];
const names = ["Plow Hours"];

test("a link or a request to the contractor is not for the agent", () => {
  assert.equal(ownerAddressesAgent(group, message("http://aiworthusing.com/agent-index/thefoundertimes"), names), false);
  assert.equal(ownerAddressesAgent(group, message("Plucas, can you log your hours?"), names), false);
  assert.equal(ownerAddressesAgent(group, message("What is plucas working hours from today?"), names), false);
});

test("naming the agent or its line, as a whole word, addresses it", () => {
  assert.equal(ownerAddressesAgent(group, message("Plow Hours, what are Plucas's hours today?"), names), true);
  assert.equal(ownerAddressesAgent(group, message("elm: explain the timesheet to Plucas"), names), true);
  assert.equal(ownerAddressesAgent(group, message("take the helm on this, Plucas"), names), false);
});

test("a reply to the agent's own message addresses it; a reply to the contractor does not", () => {
  assert.equal(ownerAddressesAgent(group, message("what does that mean?", { uid: "a", body: "Clock stopped", sender: self }), names), true);
  assert.equal(ownerAddressesAgent(group, message("nice work", { uid: "c", body: "done for today", sender: contractor }), names), false);
});
