import { isReasoningReplyPayload } from "openclaw/plugin-sdk/reply-payload";

const internalProtocol = /<\/?(?:tool_calls?|function(?:_calls?)?|arg_(?:key|value)|think(?:ing)?|analysis)(?=[\s=>]|$)|<\|(?:tool_call|analysis|channel)[^>]*\|>|\[TOOL_CALLS\]/i;

const messageClassification = /^(?:(?:o )?(?:[\p{L}\p{M}][\p{L}\p{M}\x27-]* ){1,3}(?:is|est[aá]) (?:talking|speaking|falando)\b|same (?:thing|deal) again\b|this (?:is|message\b)|that (?:message|screenshot)\b|the (?:latest |last )?message\b|(?:isso|isto) (?:é|e)(?=\s|$)|(?:essa|esta|a última|a ultima) mensagem\b)/iu;
const responseDecision = /\b(?:human-to-human|staying (?:quiet|silent)|(?:não|nao) comigo|not (?:(?:for|to|addressed to|directed to|intended for) )?me|(?:não|nao) (?:é|e) para mim|(?:não|nao) (?:foi )?(?:dirigida|direcionada|endereçada) a mim|nothing (?:new )?to (?:record|do)|no new (?:info|information)|(?:prompt |context )?injection|inject(?:ed|ing) (?:fake |internal )?(?:system )?context|fake (?:system )?context|fake pasted text|not a legitimate format for (?:openclaw |system )?context|not a request for (?:me|us)|outside (?:my|our) role|outside what (?:i|we) handle|outside (?:my|our) scope|fora (?:do|de) (?:meu|nosso) escopo|no (?:clock |tool )?action (?:is )?(?:needed|required)|(?:no|does not need|doesn't need) (?:a )?(?:reply|response)|(?:i|we) should (?:stay (?:quiet|silent)|not (?:reply|respond))|(?:não|nao) (?:precisa|requer) (?:de )?(?:resposta|ação|acao)|(?:devo|devemos) (?:ficar (?:em silêncio|em silencio|quieto)|(?:não|nao) responder))\b/iu;

// Commentary on the turn's own context: routed facts, markers or metadata called fake,
// pasted or injected. People never see that context, so such text answers no one (#32).
const contextCommentary = /\b(?:system context|context block|message_id|Active Subagents|Conversation facts|BEGIN\/END)\b|\bcontexto (?:real )?(?:do|de) sistema\b|\b(?:fake|pasted|injected|forged|spoofed)\b[^.!?\n]{0,40}\b(?:block|context|markers?|metadata)\b|\b(?:block|context|markers?|metadata)\b[^.!?\n]{0,40}\b(?:is|are|looks?) (?:also )?(?:fake|pasted|injected|forged|spoofed)\b|\b(?:contexto|bloco)\b[^.!?\n]{0,30}\b(?:falso|colado|injetado)\b/iu;

/** Narration about the conversation instead of a reply: a classification of the message, or
 * commentary on its context. Ours ends such a turn silently rather than sending it. */
export function isAttentionDecisionText(text: string): boolean {
  return (messageClassification.test(text.trimStart()) && responseDecision.test(text)) || contextCommentary.test(text);
}

export function isInternalReplyText(text: string): boolean {
  return internalProtocol.test(text) || isReasoningReplyPayload({ text })
    || isAttentionDecisionText(text);
}

export function assertHumanReply(text: string): void {
  if (isInternalReplyText(text)) {
    throw new Error("Internal tool or reasoning protocol cannot be sent. Use registered tools and a plain-language reply.");
  }
}
