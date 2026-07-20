/**
 * Canonical source-URI builders for Discord-derived memories.
 *
 * Every memory node gets a deterministic `source` URI; the id map keys on
 * these, which is what makes ingest idempotent (a re-emitted event finds the
 * existing node instead of storing a duplicate) and lets an edit find the
 * node it supersedes.
 */

export function messageUri(guildId: string, channelId: string, messageId: string): string {
  return `discord://message/${guildId}/${channelId}/${messageId}`;
}

export function memberUri(userId: string): string {
  return `discord://member/${userId}`;
}

export function channelUri(guildId: string, channelId: string): string {
  return `discord://channel/${guildId}/${channelId}`;
}

export function threadUri(guildId: string, threadId: string): string {
  return `discord://thread/${guildId}/${threadId}`;
}

export function callUri(callId: string): string {
  return `discord://call/${callId}`;
}

export function transcriptChunkUri(callId: string, index: number): string {
  return `discord://call/${callId}#chunk-${index}`;
}

export function decisionUri(callId: string, index: number): string {
  return `discord://call/${callId}#decision-${index}`;
}

export function actionItemUri(callId: string, index: number): string {
  return `discord://call/${callId}#action-${index}`;
}

export function attachmentUri(messageId: string, attachmentId: string): string {
  return `discord://attachment/${messageId}/${attachmentId}`;
}

export function tombstoneUri(guildId: string, channelId: string, messageId: string): string {
  return `discord://tombstone/${guildId}/${channelId}/${messageId}`;
}
