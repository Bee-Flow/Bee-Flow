/**
 * Where a notification goes when you tap it.
 *
 * The server stores a WEB path in `link` — `/app/studio/automations/<id>?view=runs`,
 * `/app/settings/help_support?thread=<id>`, `/app/cowork/<taskId>`. Those are
 * agent-hub routes; this app is native and its route table is a different
 * shape, so every link has to be translated. Every writer of a `link` in the
 * server tree is enumerated below, because a table built from guesses would
 * quietly send half the notifications to the wrong screen:
 *
 *   /app                                  jobs/ncOnboardingReminder.js
 *   /app/cowork/:taskId                   core/aiTaskRunner.js
 *   /app/studio/automations/:id?view=runs&run=:runId[&step=:stepId]
 *                                         core/automationRunner/execution.js,
 *                                         routes/automation/approvals.js
 *   /app/studio/approvals/:id             automation/approvalHooks.js
 *   /app/settings/help_support?thread=    routes/support/threads.js
 *   /app/settings/learning                jobs/learningNudge.js
 *   /app/admin/security/users             auth/connectorJwt.js
 *   /app/admin/compliance/:section[/:id]  compliance/events.js, attention.js,
 *     (dsr also ?id=)                     deadlines.js, jobs/complianceDeadlineNotifier.js
 *   /app/settings/organisation/license    core/appPaths.js (the Stripe return)
 *   /app/webpages/:id                     integrations/webpageBuilderTools.js,
 *                                         integrations/webpageAutomationTools.js
 *   /app/studio/webpages/:id              core/webpages/sidePanelWebpageContext.js
 *   /app/studio/skills/:id                projects/completeness.js
 *   /app/studio/knowledge/:id             projects/completeness.js
 *   /app/studio/agents/:id                projects/completeness.js
 *   /app/studio/datatables/:id            projects/completeness.js
 *   /app/studio/solutions/:id             routes/studio/attentionChecks.js
 *   /app/studio/documents/:id             core/documents/deckDocument.js,
 *                                         integrations/documentBuilderTools.js
 *                                         (chat answers, not notifications)
 *
 * Everything under /app/studio is translated in routeStudio.ts, against the
 * Studio registry (features/studio), and the organisation addresses
 * (settings/organisation, org-settings, admin) in routeOrg.ts — the admin
 * Compliance Center in routeCompliance.ts; this file keeps the rest.
 *
 * Four of these were marked web-only when this table was written, because the
 * screens did not exist yet. Three of them now do — `/support`, the `/settings`
 * tree and `/admin` were built alongside this file — so the table routes to
 * them. A row that says "only on the web app" about a screen sitting two taps
 * away in the navigation is worse than no row at all.
 *
 * Three outcomes, and the difference matters on screen:
 *   - a route      → the row is a button and opens that screen
 *   - a route marked `approximate` → the nearest place that leads to the thing
 *                    (the Studio hub, whose row opens a web-only section)
 *   - `null` with a reason → the row explains where the thing lives instead of
 *                            offering a tap that does nothing
 * Guessing a "close enough" screen that does NOT lead to the thing is worse
 * than saying so: a user sent to the automation list when they expected an
 * approval concludes the approval is lost.
 */

import { translate } from '@/core/i18n';

import { adminTarget, legacyOrgSettingsTarget, orgSettingsTarget } from './routeOrg';
import { listOrDetail, studioTarget, type ListOrDetail } from './routeStudio';
import type { AppNotification } from './types';

export interface NotificationTarget {
    /** An expo-router path, or null when this app has no screen for it. */
    href: string | null;
    /** Shown on the row when `href` is null. One short sentence. */
    unavailableReason?: string;
    /**
     * True when `href` is the nearest place, not the thing the link names —
     * the Studio hub for a section the phone has no screen for yet. A link in
     * a chat answer opens it too (shared/markdown/links.ts): the web page is
     * no better on a phone, whose browser the web sends from Studio to the chat.
     */
    approximate?: boolean;
}

/**
 * A thing the phone cannot open, and where it can be opened instead. Said as
 * "on a computer", not "on the web": the phone's own browser gets the web at
 * phone width, which hides these too (the Learning Center is one of the
 * Settings sections the web keeps for a computer; see shared/markdown/links.ts
 * PHONE_WEB_HIDDEN). Translated when the row renders, not at import.
 */
const ON_A_COMPUTER = (reason: string): NotificationTarget => ({ href: null, unavailableReason: reason });

export function targetForNotification(notification: AppNotification): NotificationTarget {
    const fromLink = translateWebLink(notification.link);
    if (fromLink) return fromLink;

    // No usable link. A run notification still knows which run it was, and
    // `task_id` is the one column that survives every category.
    if (notification.task_id) {
        // Every scheduled item is a Cowork schedule: an older `ai_task`
        // notification's task moved there under the same id (server
        // migrations prompt-tasks-to-cowork-2026-08 and agent-tasks-to-cowork-2026-10).
        if (notification.category === 'cowork' || notification.category === 'ai_task') {
            return { href: `/cowork/${notification.task_id}` };
        }
    }

    return { href: null };
}

function settingsTarget(section: string | undefined, sub: string | undefined): NotificationTarget {
    switch (section) {
        case 'organisation':
            return orgSettingsTarget(sub);
        // The thread id in `?thread=` is dropped rather than passed on: the
        // native support screen lists the threads and opens one in place, so a
        // query string it would silently ignore is a lie told to the next reader.
        case 'help_support':
            return { href: '/support' };
        case 'learning':
            return ON_A_COMPUTER(
                translate('mobile.notifications.learning_on_computer', 'Open the Learning Center in Bee Flow on a computer.'),
            );
        // Security means the same thing on both sides and has a screen here
        // (app/settings/security.tsx).
        case 'security':
            return { href: '/settings/security' };
        // The rest of the web's settings sections do not map one-to-one onto
        // the phone's (its 'account' is a profile screen; the web's is the
        // consumer billing group), so an unrecognised one lands on the index
        // rather than guessing at a sub-screen.
        default:
            return { href: '/settings' };
    }
}

/**
 * Top-level `/app/<section>/<id>` sections with a native list/detail pair.
 * `/app/webpages/<id>` is the shape core/appPaths.webpagePath ACTUALLY mints
 * (webpageBuilderTools / webpageAutomationTools hand it back as "I made you a
 * page"); it used to match nothing and be a dead tap with no reason on it.
 */
const TOP_SECTIONS = new Map<string, ListOrDetail>([
    ['webpages', { href: '/webpages', detail: (ref) => `/webpages/${ref}` }],
    // The consumer directories (the web Sidebar's Apps and Forms rows):
    // /app/apps/<appId> runs an app, /app/forms/<token> opens a form to FILL
    // IN by its page token — which on the phone is /forms/fill/<token>, the
    // one route the token may travel in (a Form page is keyed by its automation).
    ['apps', { href: '/apps', detail: (ref) => `/apps/${ref}` }],
    ['forms', { href: '/forms', detail: (ref) => `/forms/fill/${ref}` }],
    ['notebooks', { href: '/notebooks', detail: (ref) => `/notebooks/${ref}` }],
    ['projects', { href: '/projects', detail: (ref) => `/projects/${ref}` }],
    ['knowledge', { href: '/knowledge', detail: (ref) => `/knowledge/${ref}` }],
    ['kb', { href: '/knowledge', detail: (ref) => `/knowledge/${ref}` }],
    ['transcriptions', { href: '/(tabs)/record', detail: (ref) => `/recordings/${ref}` }],
    ['meetings', { href: '/(tabs)/record', detail: (ref) => `/recordings/${ref}` }],
]);

/** Cowork: the list, and one piece of delegated work. */
const COWORK: ListOrDetail = { href: '/cowork', detail: (ref) => `/cowork/${ref}` };

/** Split `/app/a/b/c?x=y` into its segments and query; `/app` itself is optional. */
function parseWebPath(link: string): { segments: string[]; query: string } {
    const [rawPath = ''] = link.split('?');
    const path = rawPath.replace(/^\/app\/?/, '/').replace(/\/+$/, '') || '/';
    const query = link.includes('?') ? link.slice(link.indexOf('?') + 1) : '';
    return { segments: path.split('/').filter(Boolean), query };
}

/** A whole id, as opposed to the web's 8-character short form of one. */
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An agent chat: the agent (and the conversation) when the link carries whole
 * ids. The short form (/app/a/<first 8>) is resolved by the web against its
 * loaded lists; here it opens the agent list — the nearest place — rather
 * than a browser tab that is not signed in.
 */
function agentChatTarget(agent: string | undefined, conversation: string | undefined, whole: boolean): NotificationTarget {
    if (!agent) return { href: '/agents' };
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- FULL_ID is an anchored, fixed-length UUID pattern, so it cannot backtrack
    if (!whole && !FULL_ID.test(agent)) return { href: '/agents', approximate: true };
    const chat = conversation && FULL_ID.test(conversation) ? `?c=${conversation}` : '';
    return { href: `/agents/${agent}${chat}` };
}

/** A direct chat by its whole id, else the list of chats it is in. */
function directChatTarget(conversation: string | undefined): NotificationTarget {
    if (conversation && FULL_ID.test(conversation)) return { href: `/chat/${conversation}` };
    return { href: '/chats', approximate: true };
}

function sectionTarget(segments: readonly string[], query: string): NotificationTarget | null {
    const [head = '', second, third, fourth] = segments;
    const mapped = TOP_SECTIONS.get(head);
    if (mapped) return listOrDetail(mapped, second);
    switch (head) {
        // This used to answer `/tasks`, claiming cowork runs were "listed with
        // routines on the phone". They were not: /tasks reads /api/ai-tasks
        // and /api/reminders, a different store from cowork_schedules — so
        // the app opened a screen that structurally could not contain the item.
        // `/app/work` is what the page was called before the rename, and
        // `/app/studio/cowork` where it lived as a Studio tab; the web still
        // opens Cowork at both (appRoutes.js pageFromPath).
        case 'cowork':
        case 'work':
            return listOrDetail(COWORK, second);
        case 'studio':
            return second === 'cowork' ? listOrDetail(COWORK, third) : studioTarget(second, third, query, fourth);
        case 'chat':
            return second ? { href: `/chat/${second}` } : null;
        // The web's chat addresses, as its address bar shows them (appRoutes.js
        // parseAgentUrl / parseDirectChatUrl): /app/agent/<id>[/<conv>],
        // /app/a/<short>[/<short conv>], /app/d/<short conv>.
        case 'agent':
            return agentChatTarget(second, third, true);
        case 'a':
            return agentChatTarget(second, third, false);
        case 'd':
            return directChatTarget(second);
        case 'settings':
            return settingsTarget(second, third);
        case 'org-settings':
            return legacyOrgSettingsTarget(second, third);
        case 'admin':
            return adminTarget(second, segments.slice(2), query);
        default:
            return null;
    }
}

/**
 * Translate one `/app/...` web path.
 *
 * Returns null when the string is not a link this table knows — the caller
 * then falls back to the category rules above. Deliberately tolerant of a
 * query string and of a missing leading `/app`.
 */
export function translateWebLink(link: string | null | undefined): NotificationTarget | null {
    if (!link || typeof link !== 'string') return null;
    // An absolute URL to another host is not ours to route.
    if (/^https?:\/\//i.test(link)) {
        return ON_A_COMPUTER(translate('mobile.notifications.link_on_computer', 'Open this link on a computer.'));
    }
    const { segments, query } = parseWebPath(link);
    if (!segments[0]) return { href: '/(tabs)' };
    return sectionTarget(segments, query);
}
