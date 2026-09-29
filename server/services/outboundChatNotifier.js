/**
 * Tells the team, in chat, that something arrived in the support inbox.
 *
 * BUILT AS A CHANNEL, NOT A GOOGLE CHAT FEATURE. Nothing like this existed in
 * the codebase — Chat appears only as example text teaching the automation
 * builder to use its generic HTTP step, and the runner's own notification
 * channels are in-app and email. Since it is greenfield either way, the
 * provider is a payload builder and Slack and Teams cost one function each.
 *
 * WHAT THE CARD SAYS. The ticket reference, the source, and a staff-only link.
 * Not the customer's name, address or organisation: personal data does not
 * leave Bee Flow except over email (CLAUDE.md → Security), and Chat is a
 * third-party destination whose history Google keeps. The subject rides along
 * only when an admin turned that on, because a support subject carries a name
 * often enough to be a discretionary field — and even then only after the
 * same PII screen a YouTrack issue gets. A subject that fails it, or that
 * could not be screened, is left off; the notification still goes.
 *
 * WHOSE TICKETS. The channel is Bee Flow's own team space, configured once
 * for the company inbox. Tickets in a customer organisation's own support
 * inbox (inbox_id set) never go there.
 *
 * The card's job is "somebody go look". A notification that told you
 * everything would need protecting as carefully as the inbox itself.
 */

const configStore = require('../stores/configStore');
const supportStore = require('../stores/supportStore');
const { jsonApiRequest } = require('../integrations/shared/apiClient');
const { includeSubjectEnabled, screenText } = require('../support/issueEgress');
const log = require('../telemetry/log');

const WEBHOOK_KEY = 'support_chat_webhook_url';
const PROVIDER_KEY = 'support_chat_provider';
const ENABLED_KEY = 'support_chat_enabled';
const EVENTS_KEY = 'support_chat_events';

const PROVIDERS = ['google_chat', 'slack', 'teams', 'generic'];

/**
 * What may trigger a message. The first two are on by default: a new ticket
 * and a customer replying are what the team actually needs to know about, and
 * everything else is opt-in so the channel stays worth reading.
 *
 * Who sends each: ticket_created and customer_message the support thread
 * routes, escalation the escalate route, sla_breach the SLA enforcer, and
 * issue_resolved the issue sync poller.
 */
const EVENTS = ['ticket_created', 'customer_message', 'sla_breach', 'escalation', 'issue_resolved'];
const DEFAULT_EVENTS = ['ticket_created', 'customer_message'];

// One message per ticket per window. A ten-message email thread would
// otherwise produce ten pings and the team would mute the space within a day.
// That window is for arrivals only: an escalation, a breached SLA or a
// resolved issue is its own news and keeps its own window, so a customer
// reply a minute earlier cannot swallow it.
const THROTTLE_MS = 10 * 60_000;
const lastSent = new Map();
const ARRIVAL_EVENTS = new Set(['ticket_created', 'customer_message']);

function throttleKey(threadId, event) {
    return ARRIVAL_EVENTS.has(event) ? threadId : `${threadId}:${event}`;
}

const { clientHost, adminSupportInboxPath, adminSupportTicketPath } = require('../utils/appPaths');

/**
 * getConfig JSON-parses what setConfig stored, so the route's 'true' comes back
 * as the boolean true and its JSON list as an array. Reading them as strings
 * made the channel impossible to turn on and every event choice snap back to
 * the defaults. The string forms are still accepted for a value that reached
 * the table some other way.
 */
function parseEvents(stored) {
    let list = stored;
    if (typeof list === 'string') {
        try { list = JSON.parse(list); } catch (_) { return DEFAULT_EVENTS; }
    }
    return Array.isArray(list) ? list.filter(e => EVENTS.includes(e)) : DEFAULT_EVENTS;
}

async function getSettings() {
    const [url, provider, enabled, events] = await Promise.all([
        configStore.getSecret(WEBHOOK_KEY),
        configStore.getConfig(PROVIDER_KEY),
        configStore.getConfig(ENABLED_KEY),
        configStore.getConfig(EVENTS_KEY),
    ]);
    return {
        url: url || null,
        provider: PROVIDERS.includes(provider) ? provider : 'google_chat',
        enabled: enabled === true || enabled === 'true',
        events: parseEvents(events),
    };
}

/**
 * Public view of the settings. Never the URL: a Google Chat webhook carries
 * its key and token in the query string, so the URL *is* the credential.
 */
async function getPublicSettings() {
    const s = await getSettings();
    let host = null;
    try { if (s.url) host = new URL(s.url).host; } catch (_) { /* malformed: shown as configured-but-broken */ }
    return {
        configured: !!s.url,
        enabled: s.enabled,
        provider: s.provider,
        host,
        events: s.events,
        availableEvents: EVENTS,
        includeSubject: await includeSubjectEnabled(),
    };
}

// ── Payload builders ──────────────────────────────────────────────────────

function googleChatPayload({ title, lines, url, linkText }) {
    return {
        // cardsV2 renders as a card with a real button; `text` is the fallback
        // for clients that cannot render cards.
        text: `${title} — ${lines.join(' · ')}`,
        cardsV2: [{
            cardId: 'beeflow-support',
            card: {
                header: { title: 'Bee Flow support', subtitle: title },
                sections: [{
                    widgets: [
                        ...lines.map(t => ({ textParagraph: { text: t } })),
                        {
                            buttonList: {
                                buttons: [{ text: linkText, onClick: { openLink: { url } } }],
                            },
                        },
                    ],
                }],
            },
        }],
    };
}

function slackPayload({ title, lines, url, linkText }) {
    return {
        text: `${title} — ${lines.join(' · ')}`,
        blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${lines.join('\n')}` } },
            {
                type: 'actions',
                elements: [{ type: 'button', text: { type: 'plain_text', text: linkText }, url }],
            },
        ],
    };
}

function teamsPayload({ title, lines, url, linkText }) {
    return {
        '@type': 'MessageCard',
        '@context': 'https://schema.org/extensions',
        summary: title,
        title,
        text: lines.join('\n\n'),
        potentialAction: [{ '@type': 'OpenUri', name: linkText, targets: [{ os: 'default', uri: url }] }],
    };
}

function buildPayload(provider, card) {
    if (provider === 'slack') return slackPayload(card);
    if (provider === 'teams') return teamsPayload(card);
    if (provider === 'generic') return { title: card.title, lines: card.lines, url: card.url };
    return googleChatPayload(card);
}

/**
 * The card's contents, assembled from an allow-list exactly like the YouTrack
 * payload. The thread row is read for four things and no more.
 */
function buildCard({ thread, event, detail = null, includeSubject = false }) {
    const ref = thread.ticket_ref || 'a ticket';
    const titles = {
        ticket_created: `New support ticket ${ref}`,
        customer_message: `${ref} — customer replied`,
        sla_breach: `${ref} — SLA breached`,
        escalation: `${ref} — escalated to engineering`,
        issue_resolved: `${ref} — a linked issue was resolved`,
    };
    const lines = [`Source: ${thread.source || 'unknown'}`];
    if (thread.priority && thread.priority !== 'normal') lines.push(`Priority: ${thread.priority}`);
    if (includeSubject && thread.subject) lines.push(`Subject: ${String(thread.subject).slice(0, 200)}`);
    if (detail) lines.push(String(detail).slice(0, 300));

    return {
        title: titles[event] || `${ref} — update`,
        lines,
        url: `${clientHost()}${adminSupportTicketPath(thread.id)}`,
        linkText: 'Open the ticket',
    };
}

// ── Delivery ──────────────────────────────────────────────────────────────

/**
 * POST the payload. `jsonApiRequest` carries the SSRF pre-filter, a mandatory
 * timeout and truncated error bodies — the last matters here because the URL
 * is a credential and must never reach a log line.
 */
async function post(url, payload) {
    return jsonApiRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        errorPrefix: 'Chat webhook',
    });
}

/**
 * May the subject go on this card? Only when the admin setting is on AND the
 * subject passes the screen a YouTrack issue gets (issueEgress.screenText:
 * this ticket's own identifiers, then the PII guard). Fails closed: a finding,
 * a guard that could not run, or a screen that threw each leave the subject
 * off. The audit line carries the categories, never the text.
 */
async function subjectMayTravel(thread, event) {
    if (!thread.subject || !(await includeSubjectEnabled())) return false;
    let screen;
    try {
        screen = await screenText(String(thread.subject), { thread });
    } catch (err) {
        log.warn('[SupportChat] subject screen failed:', err.message);
        screen = { ok: false, scanned: false, findings: [] };
    }
    if (screen.ok && screen.scanned) return true;
    supportStore.recordAuditEvent({
        organizationId: thread.organization_id || null,
        threadId: thread.id,
        actorKind: 'system',
        action: 'chat_subject_withheld',
        payload: { event, findings: (screen.findings || []).map(f => f.category), scanned: !!screen.scanned },
    }).catch(() => {});
    return false;
}

/**
 * Send one notification. Fire-and-forget from the caller's point of view: a
 * chat outage must never fail a customer's ticket submission, so this resolves
 * to a result object and never throws.
 */
async function notify({ thread, event, detail = null, force = false }) {
    if (!thread?.id) return { sent: false, reason: 'no thread' };
    if (thread.inbox_id) return { sent: false, reason: 'not the company inbox' };

    const s = await getSettings();
    if (!s.enabled || !s.url) return { sent: false, reason: 'not configured' };
    if (!force && !s.events.includes(event)) return { sent: false, reason: 'event not selected' };

    const key = throttleKey(thread.id, event);
    if (!force) {
        const last = lastSent.get(key) || 0;
        if (Date.now() - last < THROTTLE_MS) return { sent: false, reason: 'throttled' };
    }

    const card = buildCard({ thread, event, detail, includeSubject: await subjectMayTravel(thread, event) });
    const payload = buildPayload(s.provider, card);

    try {
        await post(s.url, payload);
        lastSent.set(key, Date.now());
        supportStore.recordAuditEvent({
            organizationId: thread.organization_id || null,
            threadId: thread.id,
            actorKind: 'system',
            action: 'chat_notification_sent',
            payload: { event, provider: s.provider },
        }).catch(() => {});
        return { sent: true };
    } catch (err) {
        // A notification that fails silently is worse than none: the team
        // believes it is covered. Record every failure.
        log.warn('[SupportChat] delivery failed:', err.message);
        supportStore.recordAuditEvent({
            organizationId: thread.organization_id || null,
            threadId: thread.id,
            actorKind: 'system',
            action: 'chat_notification_failed',
            payload: { event, provider: s.provider, error: err.message },
        }).catch(() => {});
        return { sent: false, reason: err.message };
    }
}

/** Send a real card to the configured space so an admin can see it arrive. */
async function sendTest() {
    const s = await getSettings();
    if (!s.url) return { ok: false, error: 'No webhook URL saved yet' };
    const card = {
        title: 'Bee Flow support notifications are working',
        lines: ['This is a test. Real notifications carry a ticket reference, the source, and a link.'],
        url: `${clientHost()}${adminSupportInboxPath()}`,
        linkText: 'Open the inbox',
    };
    try {
        await post(s.url, buildPayload(s.provider, card));
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = {
    WEBHOOK_KEY, PROVIDER_KEY, ENABLED_KEY, EVENTS_KEY,
    PROVIDERS, EVENTS, DEFAULT_EVENTS, THROTTLE_MS,
    getSettings, getPublicSettings, buildCard, buildPayload,
    notify, sendTest,
    _lastSent: lastSent,
};
