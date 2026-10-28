/**
 * Fixtures for the Support inbox demo.
 *
 * One connected mailbox and eight tickets, written the way the product stores
 * them: a thread row plus its messages, with the requester's mail and the
 * agent's replies interleaved. That is enough for the ticket list, the status
 * filters and their counts, the timeline, the meta controls (priority,
 * assignee, tags) and the AI draft button to render their real layouts.
 *
 * Everything is invented. The people, companies and email addresses are not
 * real, and nothing here is drawn from an actual support mailbox — the demo
 * is public, so a fixture built from real tickets would be a data leak with
 * extra steps.
 *
 * The one behaviour worth calling out: `POST .../draft` returns a canned
 * suggestion built by string assembly, not a model. The reply text says so.
 * A demo that implied an LLM had read the thread would be claiming something
 * the demo transport cannot do — it never reaches the network.
 */

import { COMMON_ROUTES, daysAgo } from './common';
import { pick } from '../lang';

interface Inbox {
    id: string;
    organization_id: string;
    provider: string;
    email_address: string;
    display_name: string;
    connected: boolean;
    default_agent_id: string;
    kb_ids: string[];
    created_at: string;
}
interface Thread {
    id: string;
    inbox_id: string;
    subject: string;
    requester_email: string;
    requester_name: string;
    status: string;
    priority: string;
    tags: string[];
    assignee_user_id: string | null;
    last_message_at: string;
    created_at: string;
    csat_score: number | null;
    csat_comment: string | null;
}
interface Message {
    id: string;
    thread_id: string;
    author_kind: string;
    author_display: string;
    email: string;
    body: string;
    internal_note: boolean;
    attachments: unknown[];
    kb_citations: unknown[];
    email_send_status?: string;
    created_at: string;
}
interface Teammate { id: string; username: string; displayName: string; email: string }
interface Tag { id: string; name: string; color: string }
interface Canned { id: string; title: string; body: string }
interface SupportState {
    inboxes: Inbox[];
    threads: Thread[];
    messages: Record<string, Message[]>;
    teammates: Teammate[];
    tags: Tag[];
    canned: Canned[];
}
type Ctx = { state: SupportState; params: Record<string, string>; body: Partial<Message & Thread> | null; query: URLSearchParams };

const INBOX_ID = 'sib_demo_support';
const NOT_SUPPORT_TAG = 'not-support';

/** The connected mailbox. `connected: true` is what keeps the studio out of
 *  its "Connect your support mailbox" empty state. */
const INBOXES = (): Inbox[] => ([
    {
        id: INBOX_ID,
        organization_id: 'demo-org',
        provider: 'gmail',
        email_address: 'support@example.com',
        display_name: 'Customer support',
        connected: true,
        default_agent_id: 'agent_demo_support',
        kb_ids: ['kb_demo_support'],
        created_at: daysAgo(120),
    },
]);

/**
 * Threads. `status` drives both the coloured dot and which filter tab a
 * ticket appears under, so the spread across statuses is deliberate: the
 * demo opens on "Awaiting agent" and has to have something in it, but the
 * other tabs must not be empty either or the filters look broken.
 */
const THREADS = (): Thread[] => ([
    {
        id: 'sth_demo_sso',
        inbox_id: INBOX_ID,
        subject: 'SSO login fails for three colleagues',
        requester_email: 'alex.brooks@northwind-logistics.example',
        requester_name: 'Alex Brooks',
        status: 'awaiting_agent',
        priority: 'high',
        tags: ['sso', 'bug'],
        assignee_user_id: null,
        last_message_at: daysAgo(0),
        created_at: daysAgo(1),
        csat_score: null,
        csat_comment: null,
    },
    {
        id: 'sth_demo_export',
        inbox_id: INBOX_ID,
        subject: 'Can we export a knowledge base to a file?',
        requester_email: 'j.morgan@city-archive.example',
        requester_name: 'Jordan Morgan',
        status: 'awaiting_agent',
        priority: 'normal',
        tags: ['how-to'],
        assignee_user_id: 'demo-user',
        last_message_at: daysAgo(0),
        created_at: daysAgo(0),
        csat_score: null,
        csat_comment: null,
    },
    {
        id: 'sth_demo_dpa',
        inbox_id: INBOX_ID,
        subject: 'DPA signature + sub-processor list for procurement',
        requester_email: 'purchasing@city-hall.example',
        requester_name: 'Procurement office',
        status: 'awaiting_agent',
        priority: 'urgent',
        tags: ['legal', 'procurement'],
        assignee_user_id: null,
        last_message_at: daysAgo(2),
        created_at: daysAgo(3),
        csat_score: null,
        csat_comment: null,
    },
    {
        id: 'sth_demo_whisper',
        inbox_id: INBOX_ID,
        subject: 'Meeting transcription stops after ~40 minutes',
        requester_email: 'tech@bureau-harbor.example',
        requester_name: 'Harbor Consulting',
        status: 'awaiting_user',
        priority: 'normal',
        tags: ['meeting-notes'],
        assignee_user_id: 'demo-user',
        last_message_at: daysAgo(1),
        created_at: daysAgo(4),
        csat_score: null,
        csat_comment: null,
    },
    {
        id: 'sth_demo_quota',
        inbox_id: INBOX_ID,
        subject: 'Raise the monthly automation run limit',
        requester_email: 'ops@clearwork.example',
        requester_name: 'Clearwork Ops',
        status: 'awaiting_user',
        priority: 'low',
        tags: ['billing'],
        assignee_user_id: null,
        last_message_at: daysAgo(2),
        created_at: daysAgo(5),
        csat_score: null,
        csat_comment: null,
    },
    {
        id: 'sth_demo_selfhost',
        inbox_id: INBOX_ID,
        subject: 'Docker Compose: guard container will not start',
        requester_email: 'infra@quadrant-it.example',
        requester_name: 'Quadrant IT',
        status: 'resolved',
        priority: 'normal',
        tags: ['self-hosting'],
        assignee_user_id: 'demo-user',
        last_message_at: daysAgo(6),
        created_at: daysAgo(8),
        csat_score: 5,
        csat_comment: 'Fixed within a day and the explanation actually made sense.',
    },
    {
        id: 'sth_demo_onboarding',
        inbox_id: INBOX_ID,
        subject: 'Onboarding session for eight new colleagues',
        requester_email: 'hr@fieldstone-groep.example',
        requester_name: 'Fieldstone Group',
        status: 'resolved',
        priority: 'normal',
        tags: ['onboarding'],
        assignee_user_id: 'demo-user',
        last_message_at: daysAgo(9),
        created_at: daysAgo(12),
        csat_score: 4,
        csat_comment: null,
    },
    {
        id: 'sth_demo_newsletter',
        inbox_id: INBOX_ID,
        subject: pick({ en: 'Your invoice is ready — Hostbase Ltd', nl: 'Uw factuur staat klaar — Hostbase Ltd' }),
        requester_email: 'noreply@hostbase.example',
        requester_name: 'Hostbase',
        status: 'open',
        priority: 'low',
        tags: [NOT_SUPPORT_TAG],
        assignee_user_id: null,
        last_message_at: daysAgo(1),
        created_at: daysAgo(1),
        csat_score: null,
        csat_comment: null,
    },
]);

/**
 * Messages per thread. `author_kind` is 'customer' | 'agent' | 'ai'; the
 * timeline renders each differently, and `internal_note` messages are shown
 * only to the team. Two threads carry a note so that surface is visible.
 */
const MESSAGES = (): Record<string, Message[]> => ({
    sth_demo_sso: [
        {
            id: 'smg_sso_1', thread_id: 'sth_demo_sso', author_kind: 'customer',
            author_display: 'Alex Brooks', email: 'alex.brooks@northwind-logistics.example',
            body: 'Since Monday three of my colleagues cannot sign in with Microsoft. They get sent back to the login screen with no error. I can still get in, and so can everyone who uses a password. We are on the enterprise plan.\n\nHappy to send screenshots if that helps.',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(1),
        },
        {
            id: 'smg_sso_2', thread_id: 'sth_demo_sso', author_kind: 'agent',
            author_display: 'Demo user', email: 'support@example.com',
            body: 'Thanks Alex — that pattern (silent bounce back to login, only for some accounts) usually means those three are on a different identity provider domain than the one bound to your organisation.\n\nCould you check whether their addresses end in a different domain from yours? And could you send the approximate time one of them last tried, so I can find it in the audit log?',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(1),
        },
        {
            id: 'smg_sso_3', thread_id: 'sth_demo_sso', author_kind: 'customer',
            author_display: 'Alex Brooks', email: 'alex.brooks@northwind-logistics.example',
            body: 'You are right — all three are @northwind-fleet.example, we acquired them last year. The rest of us are @northwind-logistics.example. Tried again just now, about 09:15.',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(0),
        },
        {
            id: 'smg_sso_4', thread_id: 'sth_demo_sso', author_kind: 'agent',
            author_display: 'Demo user', email: 'support@example.com',
            body: 'Second domain is not on the org allow-list — needs adding under Organisation → Domains before their SSO will bind. Flagging because the error is silent; worth a product ticket.',
            internal_note: true, attachments: [], kb_citations: [],
            created_at: daysAgo(0),
        },
    ],
    sth_demo_export: [
        {
            id: 'smg_exp_1', thread_id: 'sth_demo_export', author_kind: 'customer',
            author_display: 'Jordan Morgan', email: 'j.morgan@city-archive.example',
            body: 'We need to hand our knowledge base to an external auditor. Is there a way to get the whole thing out as files, rather than them needing an account?',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(0),
        },
    ],
    sth_demo_dpa: [
        {
            id: 'smg_dpa_1', thread_id: 'sth_demo_dpa', author_kind: 'customer',
            author_display: 'Procurement office', email: 'purchasing@city-hall.example',
            body: pick({
                en: 'For the tender we need a signed data processing agreement, plus a current list of sub-processors and the countries they operate in. Can you provide those?\n\nThe deadline is this coming Friday.',
                nl: 'Voor de aanbesteding hebben wij een ondertekende verwerkersovereenkomst nodig, plus een actuele lijst van sub-verwerkers en de vestigingslanden. Kunt u die aanleveren?\n\nDeadline is aanstaande vrijdag.',
            }),
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(3),
        },
        {
            id: 'smg_dpa_2', thread_id: 'sth_demo_dpa', author_kind: 'agent',
            author_display: 'Demo user', email: 'support@example.com',
            body: 'Procurement deadline Friday — needs the countersigned DPA, not just the template. Passing to legal.',
            internal_note: true, attachments: [], kb_citations: [],
            created_at: daysAgo(2),
        },
    ],
    sth_demo_whisper: [
        {
            id: 'smg_wsp_1', thread_id: 'sth_demo_whisper', author_kind: 'customer',
            author_display: 'Harbor Consulting', email: 'tech@bureau-harbor.example',
            body: 'Transcription of our longer sessions cuts off around the 40 minute mark. Shorter meetings are fine. Self-hosted, GPU box.',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(4),
        },
        {
            id: 'smg_wsp_2', thread_id: 'sth_demo_whisper', author_kind: 'agent',
            author_display: 'Demo user', email: 'support@example.com',
            body: 'That is almost always the reverse proxy timing out the upload rather than the transcription itself failing — the job keeps running, but the connection that was waiting for it is closed.\n\nCould you check the proxy timeout in front of the stack? For long audio it wants to be well above the default 60s. If you send me the container logs from around the cut-off I can confirm which side gave up first.',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(1),
        },
    ],
    sth_demo_quota: [
        {
            id: 'smg_qta_1', thread_id: 'sth_demo_quota', author_kind: 'customer',
            author_display: 'Clearwork Ops', email: 'ops@clearwork.example',
            body: 'We are hitting the monthly run limit around the 20th. What are the options?',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(5),
        },
        {
            id: 'smg_qta_2', thread_id: 'sth_demo_quota', author_kind: 'agent',
            author_display: 'Demo user', email: 'support@example.com',
            body: 'Two options, and I would look at the second one first.\n\nThe quick one is raising the limit on your plan. The better one is that a lot of runs are usually a schedule firing more often than the work actually changes — if you tell me which automations are burning the most, I can look at whether a trigger change gets you under the limit without paying more.',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(2),
        },
    ],
    sth_demo_selfhost: [
        {
            id: 'smg_shs_1', thread_id: 'sth_demo_selfhost', author_kind: 'customer',
            author_display: 'Quadrant IT', email: 'infra@quadrant-it.example',
            body: 'guard-service exits immediately on startup. Everything else in the compose file comes up fine.',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(8),
        },
        {
            id: 'smg_shs_2', thread_id: 'sth_demo_selfhost', author_kind: 'agent',
            author_display: 'Demo user', email: 'support@example.com',
            body: 'The guard downloads its detection model on first start, so an exit that fast is usually no outbound access or no room on the volume rather than a bad config.\n\nIf you run it in the foreground the last line before the exit will say which. Worth checking free disk on the model volume first — that is the more common of the two.',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(7),
        },
        {
            id: 'smg_shs_3', thread_id: 'sth_demo_selfhost', author_kind: 'customer',
            author_display: 'Quadrant IT', email: 'infra@quadrant-it.example',
            body: 'Disk. The volume was 2 GB. Resized and it came straight up. Thanks.',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(6),
        },
    ],
    sth_demo_onboarding: [
        {
            id: 'smg_onb_1', thread_id: 'sth_demo_onboarding', author_kind: 'customer',
            author_display: 'Fieldstone Group', email: 'hr@fieldstone-groep.example',
            body: 'Eight people starting in March. Can you run a session for them?',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(12),
        },
        {
            id: 'smg_onb_2', thread_id: 'sth_demo_onboarding', author_kind: 'agent',
            author_display: 'Demo user', email: 'support@example.com',
            body: 'Yes — an hour works well for a group that size. Send me two or three dates that suit and I will confirm one.',
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(9),
        },
    ],
    sth_demo_newsletter: [
        {
            id: 'smg_nws_1', thread_id: 'sth_demo_newsletter', author_kind: 'customer',
            author_display: 'Hostbase', email: 'noreply@hostbase.example',
            body: pick({
                en: 'Your monthly invoice is available in the customer portal.\n\nThis message was sent automatically.',
                nl: 'Uw maandelijkse factuur is beschikbaar in het klantportaal.\n\nDit bericht is automatisch verzonden.',
            }),
            internal_note: false, attachments: [], kb_citations: [],
            created_at: daysAgo(1),
        },
    ],
});

const TEAMMATES = (): Teammate[] => ([
    { id: 'demo-user', username: 'demo', displayName: 'Demo user', email: 'demo@example.com' },
    { id: 'demo-colleague', username: 'casey', displayName: 'Casey Hayes', email: 'casey@example.com' },
]);

const TAGS = (): Tag[] => ([
    { id: 'tag_bug', name: 'bug', color: '#EF4444' },
    { id: 'tag_howto', name: 'how-to', color: '#3B82F6' },
    { id: 'tag_legal', name: 'legal', color: '#8B5CF6' },
    { id: 'tag_billing', name: 'billing', color: '#F59E0B' },
    { id: 'tag_selfhost', name: 'self-hosting', color: '#10B981' },
    { id: 'tag_notsupport', name: NOT_SUPPORT_TAG, color: '#78716C' },
]);

const CANNED = (): Canned[] => ([
    {
        id: 'cn_dpa', title: 'DPA + sub-processors',
        body: 'You can download our data processing agreement and the current sub-processor list from the legal pages. If procurement needs a countersigned copy, send me the entity name and I will arrange it.',
    },
    {
        id: 'cn_export', title: 'Exporting your data',
        body: 'Knowledge bases, automations and sites all export to a file on demand from their own screens — no ticket needed, and nothing is locked in.',
    },
    {
        id: 'cn_selfhost', title: 'Self-hosting requirements',
        body: 'The minimum is 2 CPU cores, 4 GB of RAM and 10 GB of disk, with 1 GB for PostgreSQL. Four cores and 8 GB is the comfortable shape for day-to-day production use.',
    },
]);

export function createState(): SupportState {
    return {
        inboxes: INBOXES(),
        threads: THREADS(),
        messages: MESSAGES(),
        teammates: TEAMMATES(),
        tags: TAGS(),
        canned: CANNED(),
    };
}

/** Counts per filter tab, derived rather than stored — otherwise a demo
 *  interaction that changes a status leaves the badge lying. */
function countsFor(threads: Thread[]) {
    const notSupport = threads.filter((t: Thread) => (t.tags || []).includes(NOT_SUPPORT_TAG));
    const real = threads.filter((t: Thread) => !(t.tags || []).includes(NOT_SUPPORT_TAG));
    return {
        awaiting_agent: real.filter((t: Thread) => t.status === 'awaiting_agent').length,
        awaiting_user: real.filter((t: Thread) => t.status === 'awaiting_user').length,
        resolved: real.filter((t: Thread) => t.status === 'resolved').length,
        '': real.length,
        not_support: notSupport.length,
    };
}

export const ROUTES = {
    ...COMMON_ROUTES,

    'GET /api/support-inbox/inboxes': ({ state }: Ctx) => ({ inboxes: state.inboxes }),

    'GET /api/support-inbox/threads': ({ state, query }: Ctx) => {
        const status = query.get('status') || '';
        const tag = query.get('tag') || '';
        const search = (query.get('search') || '').toLowerCase();

        let rows = state.threads;
        // The not-support view is a TAG filter, not a status filter, and the
        // two are mutually exclusive: without excluding tagged mail from the
        // status views a newsletter shows up under "Awaiting agent".
        if (tag) rows = rows.filter((t: Thread) => (t.tags || []).includes(tag));
        else rows = rows.filter((t: Thread) => !(t.tags || []).includes(NOT_SUPPORT_TAG));
        if (status) rows = rows.filter((t: Thread) => t.status === status);
        if (search) {
            rows = rows.filter((t: Thread) =>
                (t.subject || '').toLowerCase().includes(search)
                || (t.requester_email || '').toLowerCase().includes(search));
        }
        return { threads: rows, counts: countsFor(state.threads) };
    },

    'GET /api/support-inbox/threads/:threadId': ({ state, params }: Ctx) => {
        const thread = state.threads.find((t: Thread) => t.id === params.threadId) || null;
        return { thread, messages: state.messages[params.threadId] || [] };
    },

    // Writes mutate the in-memory state so the UI stays consistent for the
    // rest of the session — change a priority and the list still agrees.
    'PATCH /api/support-inbox/threads/:threadId': ({ state, params, body }: Ctx) => {
        const thread = state.threads.find((t: Thread) => t.id === params.threadId);
        if (thread) Object.assign(thread, body || {});
        return { thread };
    },

    'GET /api/support-inbox/threads/:threadId/context': ({ state, params }: Ctx) => {
        const thread = state.threads.find((t: Thread) => t.id === params.threadId);
        if (!thread) return { requester: null, recentThreads: [] };
        return {
            requester: {
                email: thread.requester_email,
                name: thread.requester_name,
                firstSeen: thread.created_at,
                ticketCount: state.threads.filter((t: Thread) => t.requester_email === thread.requester_email).length,
            },
            recentThreads: state.threads
                .filter((t: Thread) => t.requester_email === thread.requester_email && t.id !== thread.id)
                .slice(0, 5)
                .map((t: Thread) => ({ id: t.id, subject: t.subject, status: t.status, created_at: t.created_at })),
        };
    },

    'GET /api/support-inbox/threads/:threadId/events': () => ({ events: [] }),

    /**
     * The AI draft button. This is deterministic string assembly keyed off the
     * thread's tags — NOT a model. The demo transport never reaches the
     * network, so a draft that claimed to have reasoned over the thread would
     * be theatre. The copy says where it came from.
     */
    'POST /api/support-inbox/threads/:threadId/draft': ({ state, params }: Ctx) => {
        const thread = state.threads.find((t: Thread) => t.id === params.threadId);
        const tags = (thread?.tags || []);
        const canned = state.canned;
        let body: string | undefined;
        if (tags.includes('legal')) body = canned.find((c: Canned) => c.id === 'cn_dpa')?.body;
        else if (tags.includes('self-hosting')) body = canned.find((c: Canned) => c.id === 'cn_selfhost')?.body;
        else if (tags.includes('how-to')) body = canned.find((c: Canned) => c.id === 'cn_export')?.body;

        return {
            draft: (body || 'Thanks for getting in touch — I am looking into this and will come back to you shortly.')
                + '\n\n(Sample draft, assembled from this demo’s canned replies. The real assistant grounds its answer in your knowledge base.)',
            citations: [],
        };
    },

    'POST /api/support-inbox/threads/:threadId/reply': ({ state, params, body }: Ctx) => {
        const list = state.messages[params.threadId] || (state.messages[params.threadId] = []);
        const message: Message = {
            id: `smg_demo_${list.length + 1}_${params.threadId}`,
            thread_id: params.threadId,
            author_kind: 'agent',
            author_display: 'Demo user',
            email: 'support@example.com',
            body: body?.body || '',
            internal_note: !!body?.internal_note,
            attachments: [],
            kb_citations: [],
            // Nothing is sent. Saying so in the field the UI already renders
            // is better than a silent no-op that looks like a delivery.
            email_send_status: 'demo_not_sent',
            created_at: new Date().toISOString(),
        };
        list.push(message);

        const thread = state.threads.find((t: Thread) => t.id === params.threadId);
        if (thread && !message.internal_note) thread.status = 'awaiting_user';
        return { message };
    },

    'GET /api/support-inbox/teammates': ({ state }: Ctx) => ({ teammates: state.teammates }),
    'GET /api/support-inbox/tags': ({ state }: Ctx) => ({ tags: state.tags }),
    'GET /api/support-inbox/canned': ({ state }: Ctx) => ({ canned: state.canned }),
    'GET /api/support-inbox/audit': () => ({ entries: [] }),
    'GET /api/support-inbox/sla-policies': () => ({ policies: [] }),
    'GET /api/support-inbox/insights': ({ state }: Ctx) => ({
        totals: {
            open: state.threads.filter((t: Thread) => t.status === 'awaiting_agent').length,
            resolved: state.threads.filter((t: Thread) => t.status === 'resolved').length,
        },
        // No invented response-time or satisfaction averages: the site's own
        // rules forbid publishing performance figures we cannot stand behind,
        // and a demo chart is still a published number.
        series: [],
    }),
    'GET /api/support-inbox/inboxes/:id/access': () => ({ members: [] }),
    'GET /api/support-inbox/inboxes/:id/available-integrations': () => ({ integrations: [] }),
    'GET /api/support-inbox/inboxes/:id/kb-automation': () => ({ enabled: false }),
    'GET /api/kb': () => ({ knowledgeBases: [{ id: 'kb_demo_support', name: 'Support knowledge base' }] }),
};
