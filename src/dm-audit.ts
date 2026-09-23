export interface DmAuditConversation {
  channel: string;
  recipientId: string;
}

export interface DmAuditConversationsPage {
  conversations: DmAuditConversation[];
  nextCursor?: string;
}

export interface DmAuditMessage {
  channel: string;
  recipientId: string;
  ts: string;
  text: string;
  permalink: string;
}

export interface DmAuditMessagesPage {
  messages: DmAuditMessage[];
  threads: string[];
  nextLatest?: string;
  nextOldest?: string;
  nextCursor?: string;
}

export interface DmAuditQuery {
  channel: string;
  recipientId: string;
  oldest: string;
  latest?: string;
  threadTs?: string;
  cursor?: string;
}
