import { isReasoningReplyPayload } from "openclaw/plugin-sdk/reply-payload";

const internalProtocol = /<\/?(?:tool_calls?|function(?:_calls?)?|arg_(?:key|value)|think(?:ing)?|analysis)(?=[\s=>]|$)|<\|(?:tool_call|analysis|channel)[^>]*\|>|\[TOOL_CALLS\]/i;

const messageClassification = /^(?:this (?:is|message\b)|the (?:latest |last )?message\b|(?:isso|isto) (?:é|e)(?=\s|$)|(?:essa|esta|a última|a ultima) mensagem\b)/iu;
const responseDecision = /\b(?:nothing (?:new )?to (?:record|do)|no (?:clock |tool )?action (?:is )?(?:needed|required)|(?:no|does not need|doesn't need) (?:a )?(?:reply|response)|(?:i|we) should (?:stay (?:quiet|silent)|not (?:reply|respond))|(?:não|nao) (?:precisa|requer) (?:de )?(?:resposta|ação|acao)|(?:devo|devemos) (?:ficar (?:em silêncio|em silencio|quieto)|(?:não|nao) responder))\b/iu;

export function isInternalReplyText(text: string): boolean {
  return internalProtocol.test(text) || isReasoningReplyPayload({ text })
    || (messageClassification.test(text.trimStart()) && responseDecision.test(text));
}

export function assertHumanReply(text: string): void {
  if (isInternalReplyText(text)) {
    throw new Error("Internal tool or reasoning protocol cannot be sent. Use registered tools and a plain-language reply.");
  }
}
