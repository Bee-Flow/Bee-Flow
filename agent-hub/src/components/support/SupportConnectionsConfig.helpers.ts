/** GET /api/support/youtrack/status. */
export interface YouTrackConnection {
    configured?: boolean;
    ok?: boolean;
    host?: string;
    error?: string;
    defaultProject?: string;
    includeSubject?: boolean;
    projects?: Array<{ id: string; shortName: string; name: string }>;
}

/** GET /api/support/notifications. */
export interface ChatNotifications {
    configured?: boolean;
    enabled?: boolean;
    host?: string;
    provider?: string;
    events?: string[];
    availableEvents?: string[];
}

/** What a chat settings save sends; the webhook URL is added from the field. */
export interface ChatPatch {
    events?: string[];
    provider?: string;
    enabled?: boolean;
    webhookUrl?: string;
}

export const PROVIDERS = [
    { id: 'google_chat', label: 'Google Chat' },
    { id: 'slack', label: 'Slack' },
    { id: 'teams', label: 'Microsoft Teams' },
    { id: 'generic', label: 'Plain JSON webhook' },
];

// Written from the reader's side: what happens, not which table it touches.
export const EVENT_LABELS: Record<string, string> = {
    ticket_created: 'A new ticket arrives',
    customer_message: 'A customer replies',
    sla_breach: 'An SLA is breached',
    escalation: 'A ticket is escalated to engineering',
    issue_resolved: 'A linked issue is resolved',
};
