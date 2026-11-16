import type { TranslateFn } from '@/hooks/useTranslation';

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

/** The chat services a card can go to, each with the shape of its webhook address as the field's example. */
export const PROVIDERS = [
    { id: 'google_chat', label: 'Google Chat', placeholder: 'https://chat.googleapis.com/v1/spaces/…' },
    { id: 'slack', label: 'Slack', placeholder: 'https://hooks.slack.com/services/…' },
    { id: 'teams', label: 'Microsoft Teams', placeholder: 'https://….webhook.office.com/…' },
    { id: 'generic', label: 'Plain JSON webhook', placeholder: 'https://example.com/webhook' },
];

/** The example webhook address of a provider (the first one's for an unknown id). */
export function webhookPlaceholder(provider: string | null | undefined): string {
    return (PROVIDERS.find(p => p.id === provider) ?? PROVIDERS[0]).placeholder;
}

/** The chat events in words, written from the reader's side: what happens, not which table it touches. */
export function eventLabelsFor(t: TranslateFn): Record<string, string> {
    return {
        ticket_created: t('support.connections_event_ticket_created', 'A new ticket arrives'),
        customer_message: t('support.connections_event_customer_message', 'A customer replies'),
        sla_breach: t('support.connections_event_sla_breach', 'An SLA is breached'),
        escalation: t('support.connections_event_escalation', 'A ticket is escalated to engineering'),
        issue_resolved: t('support.connections_event_issue_resolved', 'A linked issue is resolved'),
    };
}
