import { isReasoningReplyPayload } from "openclaw/plugin-sdk/reply-payload";

const internalProtocol = /<\/?(?:tool_calls?|function(?:_calls?)?|arg_(?:key|value)|think(?:ing)?|analysis)(?=[\s=>]|$)|<\|(?:tool_call|analysis|channel)[^>]*\|>|\[TOOL_CALLS\]/i;

export function isInternalReplyText(text: string): boolean {
  return internalProtocol.test(text) || isReasoningReplyPayload({ text });
}

export function assertHumanReply(text: string): void {
  if (isInternalReplyText(text)) {
    throw new Error("Internal tool or reasoning protocol cannot be sent. Use registered tools and a plain-language reply.");
  }
}
