/**
 * The push-tap contract: whatever the payload carries, the answer is a route
 * that exists. The bug this pins down: _layout.tsx used to push the server's
 * raw web path (`/app/studio/automations/<id>?view=runs`) straight into
 * expo-router, which matches nothing in app/ and lands on the auto-injected
 * +not-found screen.
 */

import { PUSH_FALLBACK_ROUTE, routeForPushLink } from './pushRoute';

describe('routeForPushLink', () => {
    it('translates a known web path to its native screen', () => {
        expect(routeForPushLink('/app/cowork/abc123')).toBe('/cowork/abc123');
    });

    it('carries the id through on a path with one', () => {
        // automation/approvalHooks.js — the most phone-shaped notification
        // in the product: a routine stopped on a yes-or-no.
        expect(routeForPushLink('/app/studio/approvals/apr-42')).toBe('/approvals/apr-42');
    });

    it('honours the query string, run params and all', () => {
        // The exact shape execution.js writes — and the exact link that used
        // to land on +not-found.
        expect(routeForPushLink('/app/studio/automations/a1?view=runs&run=r9&step=s2')).toBe(
            '/automations/a1/runs',
        );
        // A thread param the native screen has no use for is dropped, not fatal.
        expect(routeForPushLink('/app/settings/help_support?thread=t7')).toBe('/support');
    });

    it('sends an unknown path to the inbox, never +not-found', () => {
        expect(routeForPushLink('/app/some/screen/added/next/year')).toBe(PUSH_FALLBACK_ROUTE);
        // Web-only destinations too: the inbox row is where the "only on the
        // web app" explanation lives, so that is where the tap goes.
        expect(routeForPushLink('/app/settings/learning')).toBe(PUSH_FALLBACK_ROUTE);
        expect(routeForPushLink('https://elsewhere.example/app/cowork/x')).toBe(PUSH_FALLBACK_ROUTE);
    });

    it('shrugs off an empty or garbage payload', () => {
        expect(routeForPushLink(null)).toBe(PUSH_FALLBACK_ROUTE);
        expect(routeForPushLink(undefined)).toBe(PUSH_FALLBACK_ROUTE);
        expect(routeForPushLink('')).toBe(PUSH_FALLBACK_ROUTE);
        expect(routeForPushLink('   ')).toBe(PUSH_FALLBACK_ROUTE);
        expect(routeForPushLink('%%%not-a-path%%%')).toBe(PUSH_FALLBACK_ROUTE);
        // Payload data crosses a process boundary; a non-string is not a crash.
        expect(routeForPushLink(42)).toBe(PUSH_FALLBACK_ROUTE);
        expect(routeForPushLink({ link: '/app/cowork/x' })).toBe(PUSH_FALLBACK_ROUTE);
    });

    it('lands the bare app root on the main screen', () => {
        // jobs/ncOnboardingReminder.js writes a plain '/app'.
        expect(routeForPushLink('/app')).toBe('/(tabs)');
    });

    it('never answers with something unnavigable', () => {
        // The summary notification sends { link: null }; every writer in the
        // server tree sends one of the shapes above. Whatever future writers
        // do, the contract is: a string, absolute, and never the 404 hook.
        const inputs = [
            '/app/studio/automations/a1?view=runs',
            '/app/notebooks/n1',
            '/app/admin/compliance/incidents/i1',
            '/app/brand/new/surface',
            null,
            'garbage',
        ];
        for (const input of inputs) {
            const route = routeForPushLink(input);
            expect(typeof route).toBe('string');
            expect(route.startsWith('/')).toBe(true);
            expect(route.includes('not-found')).toBe(false);
        }
    });
});
