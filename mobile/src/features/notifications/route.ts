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
 *   /app/studio/automations/:id?view=runs core/automationRunner/execution.js
 *   /app/studio/approvals/:id             automation/approvalHooks.js
 *   /app/settings/help_support?thread=    routes/support/threads.js
 *   /app/settings/learning                jobs/learningNudge.js
 *   /app/admin/security/users             auth/connectorJwt.js
 *   /app/webpages/:id                     integrations/webpageBuilderTools.js,
 *                                         integrations/webpageAutomationTools.js
 *   /app/studio/webpages/:id              core/webpages/sidePanelWebpageContext.js
 *   /app/studio/skills/:id                projects/completeness.js
 *   /app/studio/solutions/:id             routes/studio/attentionChecks.js
 *
 * Four of these were marked web-only when this table was written, because the
 * screens did not exist yet. Three of them now do — `/support`, the `/settings`
 * tree and `/admin` were built alongside this file — so the table routes to
 * them. A row that says "only on the web app" about a screen sitting two taps
 * away in the More tab is worse than no row at all.
 *
 * Three outcomes, and the difference matters on screen:
 *   - a route      → the row is a button and opens that screen
 *   - `null` with a reason → the row explains where the thing lives instead of
 *                            offering a tap that does nothing
 * Guessing a "close enough" screen is worse than saying so: a user sent to the
 * Automate tab when they expected an approval concludes the approval is lost.
 */

import type { AppNotification } from './types';

export interface NotificationTarget {
    /** An expo-router path, or null when this app has no screen for it. */
    href: string | null;
    /** Shown on the row when `href` is null. One short sentence. */
    unavailableReason?: string;
}

/** Screens that do not exist in the native app (yet). */
const WEB_ONLY = (what: string): NotificationTarget => ({
    href: null,
    unavailableReason: `${what} is only on the web app for now.`,
});

export function targetForNotification(notification: AppNotification): NotificationTarget {
    const fromLink = translateWebLink(notification.link);
    if (fromLink) return fromLink;

    // No usable link. A run notification still knows which run it was, and
    // `task_id` is the one column that survives every category.
    if (notification.task_id) {
        // Two different stores, and they must not be conflated: `cowork` rows
        // live in cowork_schedules and `ai_task` rows in ai_tasks. Sending both
        // to /tasks — which reads ai_tasks and reminders — meant every Cowork
        // result opened a list that could never contain it.
        if (notification.category === 'cowork') {
            return { href: `/cowork/${notification.task_id}` };
        }
        if (notification.category === 'ai_task') return { href: '/tasks' };
    }

    return { href: null };
}

/**
 * Percent-decode ONE path segment for inspection only — never for building an
 * href, which keeps the server's own encoding. A malformed escape is not worth
 * a crash inside a tap handler, so it is handed back untouched.
 */
function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
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
    if (/^https?:\/\//i.test(link)) return WEB_ONLY('This');

    const [rawPath = ''] = link.split('?');
    const path = rawPath.replace(/^\/app\/?/, '/').replace(/\/+$/, '') || '/';
    const query = link.includes('?') ? link.slice(link.indexOf('?') + 1) : '';
    const segments = path.split('/').filter(Boolean);
    const [head, second, third] = segments;

    if (segments.length === 0) return { href: '/(tabs)' };

    if (head === 'cowork') {
        // This used to answer `/tasks`, with a comment claiming cowork runs
        // were "listed with routines on the phone". They were not: /tasks reads
        // /api/ai-tasks and /api/reminders, a different store from
        // cowork_schedules — so the app badged the notification "Cowork",
        // offered a "Cowork results" preference for it, and then opened a
        // screen that structurally could not contain the item.
        return { href: second ? `/cowork/${second}` : '/(tabs)/cowork' };
    }

    if (head === 'studio') {
        if (second === 'automations' && third) {
            // `?view=runs` is how the web app opens the run history; the phone
            // has a dedicated screen for it.
            return { href: /(^|&)view=runs(&|$)/.test(query) ? `/automations/${third}/runs` : `/automations/${third}` };
        }
        if (second === 'apps' && third) return { href: `/apps/${third}` };
        // The Studio editor address of a webpage. `/app/studio/webpages/<id>`
        // is minted by core/appPaths.webpageEditorPath (the side-panel AI
        // context) and is frozen in the web-side FROZEN_LEGACY; until now it
        // fell through to /automations, which is not close enough — a page is
        // not a routine.
        if (second === 'webpages') return { href: third ? `/webpages/${third}` : '/webpages' };
        // Meeting notes. NOT a repair like the webpages row above: no server
        // writer mints /app/studio/meeting-notes/<id> today. It is here
        // because that segment is the one the Studio rail navigates to and the
        // section it names has a native twin (/recordings/<id>, the same
        // screen the transcriptions/meetings rows below open), so a link that
        // starts being minted tomorrow lands instead of falling into the
        // /automations catch-all. There is no /recordings index screen — the
        // Record tab is the list.
        if (second === 'meeting-notes') return { href: third ? `/recordings/${third}` : '/(tabs)/record' };
        // NOT web-only, and it never should have been: approving is the most
        // phone-shaped action in this product — you are away from a desk and a
        // routine has stopped on a yes-or-no. The link carries an APPROVAL id,
        // which is why this could not simply point at a run screen: run ids are
        // different, and an App Studio approval has no run at all.
        if (second === 'approvals' && third) return { href: `/approvals/${third}` };
        // Skills. Minted by projects/completeness.js:98 (DEEP_LINK.skill), which
        // encodes the id itself — so `third` is passed on as it arrived, like
        // every row above. Until now a "your skill is missing X" notification
        // opened the routine list, even though the phone has the screen.
        if (second === 'skills') return { href: third ? `/skills/${third}` : '/skills' };
        // Solutions — the Studio's word for a project, minted by
        // routes/studio/attentionChecks.js:234 (solutionDeepLink). Its own
        // comment two lines up (:222) is the warning this row has to answer:
        // the shared finding kind folds synthetic APPROVAL nodes onto
        // 'solution', so `/app/studio/solutions/approval:xyz` can reach a
        // client and is not a page anywhere.
        //
        // Such an id is deliberately NOT repaired into `/approvals/<rest>`: it
        // is not an approval id to begin with. projects/graph.js:85 mints it as
        // `approval:<ownerType>:<ownerId>:<stepId>`, three fields that do not
        // contain one — splitting it would hand /approvals/:id a step id and
        // 404. It goes to the project LIST instead: a list that does not
        // contain the item is a smaller lie than a detail screen that fails to
        // load, and the person can still find their way from there.
        if (second === 'solutions') {
            if (third && decodeSegment(third).startsWith('approval:')) return { href: '/projects' };
            return { href: third ? `/projects/${third}` : '/projects' };
        }
        return { href: '/automations' };
    }

    // `/app/webpages/<id>` — the shape core/appPaths.webpagePath ACTUALLY
    // mints (integrations/webpageBuilderTools.js and webpageAutomationTools.js
    // hand it back as the result of "I made you a page"). It matched no branch
    // at all and fell to the `return null` at the bottom: a dead tap with no
    // reason on it. The Studio-nested form above is the editor address; this
    // is the one people are actually sent.
    if (head === 'webpages') return { href: second ? `/webpages/${second}` : '/webpages' };
    if (head === 'notebooks') return { href: second ? `/notebooks/${second}` : '/notebooks' };
    if (head === 'projects') return { href: second ? `/projects/${second}` : '/projects' };
    if (head === 'knowledge' || head === 'kb') return { href: second ? `/knowledge/${second}` : '/knowledge' };
    if (head === 'transcriptions' || head === 'meetings') {
        return { href: second ? `/recordings/${second}` : '/(tabs)/record' };
    }
    if (head === 'chat' && second) return { href: `/chat/${second}` };

    if (head === 'settings') {
        // The thread id in `?thread=` is dropped rather than passed on: the
        // native support screen lists the threads and opens one in place, so it
        // has nothing to do with a param, and a query string that is silently
        // ignored is a lie told to the next person reading this table.
        if (second === 'help_support') return { href: '/support' };
        if (second === 'learning') return WEB_ONLY('The Learning Center');
        // Security is the one section that means the same thing on both sides
        // and has a screen here (app/settings/security.tsx). It became a real
        // web address only now — /app/settings/security used to fall through to
        // Preferences on the web too — so this row is the translation arriving
        // with the segment rather than a release behind it.
        if (second === 'security') return { href: '/settings/security' };
        // The rest of the web app's settings sections do not map one-to-one
        // onto the phone's (its 'account' is a profile screen; the web's is the
        // consumer billing group), so an unrecognised one lands on the settings
        // index rather than guessing at a sub-screen.
        return { href: '/settings' };
    }

    if (head === 'admin') return { href: '/admin' };

    return null;
}
