/**
 * Links and images inside a chat answer.
 *
 * The server writes both relative to itself, because the web app is served by
 * it. Before this, a tapped `/app/studio/webpages/wp1` went to Linking.openURL
 * and failed silently, and a stored image rendered a broken data: tile.
 */

import { translateWebLink } from '@/features/notifications/model/route';

import { imageSource, isAppLink, linkTarget as resolveLink, servedOnPhoneWeb } from './links';

/** The app's own table, as the root layout hands it to MarkdownLinkProvider. */
const linkTarget = (href: string, serverUrl: string | null) => resolveLink(href, serverUrl, translateWebLink);

const SERVER = 'https://ai.acme.example';

describe('linkTarget', () => {
    it('opens a relative app path on its native screen', () => {
        expect(linkTarget('/app/studio/webpages/wp1', SERVER)).toEqual({ kind: 'route', href: '/webpages/wp1' });
        expect(linkTarget('/app/cowork/c1', SERVER)).toEqual({ kind: 'route', href: '/cowork/c1' });
        expect(linkTarget('/app', SERVER)).toEqual({ kind: 'route', href: '/(tabs)' });
    });

    it('treats an absolute link to the configured server the same way', () => {
        expect(linkTarget(`${SERVER}/app/studio/automations/a1?view=runs`, SERVER)).toEqual({
            kind: 'route',
            href: '/automations/a1/runs',
        });
    });

    it('honours a server installed under a path', () => {
        const base = 'https://host.example/beeflow';
        expect(linkTarget('https://host.example/beeflow/app/chat/c1', base)).toEqual({ kind: 'route', href: '/chat/c1' });
        // Same host, outside the install: not an app link.
        expect(linkTarget('https://host.example/app/chat/c1', base)).toEqual({
            kind: 'browser',
            url: 'https://host.example/app/chat/c1',
        });
    });

    it('opens nothing for an app path with no native screen that the web does not draw on a phone', () => {
        // The web's /app/* catch-all draws the Agents chat, not this page — and
        // only after a sign-in the Custom Tab does not share with the app.
        expect(linkTarget(`${SERVER}/app/some/future/screen`, SERVER)).toBeNull();
        expect(linkTarget('/app/billing', SERVER)).toBeNull();
    });

    it('opens nothing for the Learning Center, which the web hides on a phone', () => {
        // The Learning Center is a Settings page, and 'settings' is a page the
        // web serves a phone — but its settings screen swaps the Learning
        // Center for Preferences at phone width (SETTINGS_DESKTOP_ONLY_TABS),
        // so a browser tab would land there, after a sign-in.
        expect(linkTarget('/app/settings/learning', SERVER)).toBeNull();
        expect(linkTarget(`${SERVER}/app/settings/learning?course=c1`, SERVER)).toBeNull();
        expect(linkTarget('/app/settings/learning', null)).toBeNull();
    });

    it('opens an agent or direct chat in the app, never in a browser tab that is not signed in', () => {
        expect(linkTarget('/app/agent/ag-1', SERVER)).toEqual({ kind: 'route', href: '/agents/ag-1' });
        // A short id the phone cannot resolve: the nearest list.
        expect(linkTarget('/app/a/abc123', SERVER)).toEqual({ kind: 'route', href: '/agents' });
        expect(linkTarget('/app/a/abc123', null)).toEqual({ kind: 'route', href: '/agents' });
        expect(linkTarget('/app/d/abc123', SERVER)).toEqual({ kind: 'route', href: '/chats' });
    });

    it('opens a Studio knowledge base, agent, data table or document on its native screen', () => {
        // projects/completeness.js mints the first three; each used to open
        // the routine list through the Studio catch-all.
        expect(linkTarget('/app/studio/knowledge/kb1', SERVER)).toEqual({ kind: 'route', href: '/knowledge/kb1' });
        expect(linkTarget('/app/studio/agents/ag1', SERVER)).toEqual({ kind: 'route', href: '/agents/ag1' });
        expect(linkTarget('/app/studio/datatables/d1', SERVER)).toEqual({ kind: 'route', href: '/datatables/d1' });
        expect(linkTarget('/app/studio/documents/doc1', SERVER)).toEqual({ kind: 'route', href: '/documents/doc1' });
    });

    it('opens the nearest native screen for an address the table can only approximate, never the web', () => {
        // A Studio section this build does not know: the Studio hub, where a
        // module's row says where it lives. On a phone the web would bounce
        // Studio to the chat, after a sign-in.
        expect(linkTarget('/app/studio/some-new-section/x1', SERVER)).toEqual({ kind: 'route', href: '/studio' });
        expect(linkTarget(`${SERVER}/app/studio/some-new-section`, SERVER)).toEqual({ kind: 'route', href: '/studio' });
        // An admin tab with no organisation-side twin: the organisation index.
        expect(linkTarget('/app/admin/some-tab', SERVER)).toEqual({ kind: 'route', href: '/org' });
        // The routine list itself is not a guess.
        expect(linkTarget('/app/studio/automations', SERVER)).toEqual({ kind: 'route', href: '/automations' });
    });

    it('keeps an external link external, even when its path looks like an app path', () => {
        expect(linkTarget('https://elsewhere.example/app/cowork/x', SERVER)).toEqual({
            kind: 'browser',
            url: 'https://elsewhere.example/app/cowork/x',
        });
        expect(linkTarget('https://example.com/article', SERVER)).toEqual({
            kind: 'browser',
            url: 'https://example.com/article',
        });
    });

    it('resolves any other server path, and hands other schemes to the system', () => {
        expect(linkTarget('/uploads/generated/a.png', SERVER)).toEqual({
            kind: 'browser',
            url: `${SERVER}/uploads/generated/a.png`,
        });
        expect(linkTarget('mailto:dpo@acme.example', SERVER)).toEqual({ kind: 'system', url: 'mailto:dpo@acme.example' });
        expect(linkTarget('tel:+31201234567', SERVER)).toEqual({ kind: 'system', url: 'tel:+31201234567' });
    });

    it('does not hand an arbitrary scheme to the system', () => {
        // An answer can quote a web page; `intent:` would launch any app.
        expect(linkTarget('intent://scan/#Intent;scheme=zxing;end', SERVER)).toBeNull();
        expect(linkTarget('javascript:alert(1)', SERVER)).toBeNull();
    });

    it('matches schemes and the /app prefix exactly, whatever the case', () => {
        expect(linkTarget('HTTPS://ai.acme.example/app/cowork/c1', SERVER)).toEqual({ kind: 'route', href: '/cowork/c1' });
        expect(linkTarget('MailTo:someone@example.com', SERVER)).toEqual({
            kind: 'system',
            url: 'MailTo:someone@example.com',
        });
        // `/apple` is a server path, not the app's address space.
        expect(linkTarget('/apple', SERVER)).toEqual({ kind: 'browser', url: `${SERVER}/apple` });
        expect(linkTarget('/app?x=1', SERVER)?.kind).toBe('route');
    });

    it('does nothing with a link it cannot place', () => {
        expect(linkTarget('', SERVER)).toBeNull();
        expect(linkTarget('#section', SERVER)).toBeNull();
        expect(linkTarget('docs/readme', SERVER)).toBeNull();
        // No server configured: a relative path has nothing to resolve against.
        expect(linkTarget('/uploads/a.png', null)).toBeNull();
        // …but an app path with a native twin still needs no server.
        expect(linkTarget('/app/chat/c1', null)).toEqual({ kind: 'route', href: '/chat/c1' });
    });

    it('opens nothing on the web without a translation table unless the web draws the page on a phone', () => {
        const bare = (href: string) => resolveLink(href, SERVER, () => null);
        expect(bare('/app/studio/webpages/wp1')).toBeNull();
        expect(bare('/app/notebooks/n1')).toBeNull();
        expect(bare('/app/cowork/c1')).toEqual({ kind: 'browser', url: `${SERVER}/app/cowork/c1` });
        expect(bare('/app/studio/approvals/ap1')).toEqual({ kind: 'browser', url: `${SERVER}/app/studio/approvals/ap1` });
        expect(bare('/app/settings/appearance')).toEqual({ kind: 'browser', url: `${SERVER}/app/settings/appearance` });
        // The two Settings sections the web draws only on a computer.
        expect(bare('/app/settings/learning')).toBeNull();
        expect(bare('/app/settings/integrations')).toBeNull();
    });
});

describe('isAppLink', () => {
    it('knows an address of the web app, relative or on the configured server', () => {
        expect(isAppLink('/app/billing', SERVER)).toBe(true);
        expect(isAppLink(` ${SERVER}/app/settings/learning?course=c1`, SERVER)).toBe(true);
        expect(isAppLink('/app/settings/learning', null)).toBe(true);
    });

    it('does not count a link that is no app address', () => {
        for (const href of ['www.acme.nl', 'docs/setup', 'javascript:alert(1)', '', '/apple', '/uploads/a.png',
            'https://elsewhere.example/app/cowork/x']) {
            expect({ href, app: isAppLink(href, SERVER) }).toEqual({ href, app: false });
        }
    });
});

describe('servedOnPhoneWeb', () => {
    it('knows the web pages a phone is shown, by their own addresses', () => {
        for (const path of ['/app', '/app/', '/app?x=1', '/app/a/s1', '/app/agent/a1', '/app/d/c1', '/app/settings', '/app/settings/appearance',
            '/app/apps', '/app/apps/', '/app/apps/p1', '/app/forms', '/app/forms/tok', '/app/cowork', '/app/cowork/c1', '/app/work/c1',
            '/app/studio/cowork/c1', '/app/studio/approvals', '/app/studio/approvals/ap1#top']) {
            expect({ path, served: servedOnPhoneWeb(path) }).toEqual({ path, served: true });
        }
    });

    it('does not count the rest of the web, nor its catch-all chat', () => {
        for (const path of ['/app/studio', '/app/studio/automations/a1', '/app/studio/approvalsx', '/app/admin/security/users', '/app/org-settings',
            '/app/notebooks/n1', '/app/projects/p1', '/app/webpages/w1', '/app/billing', '/app/routines', '/app/a', '/app/some/future/screen',
            '/app/settingsx', '/app/workbench']) {
            expect({ path, served: servedOnPhoneWeb(path) }).toEqual({ path, served: false });
        }
    });

    it('does not count the Settings sections the web hides on a phone', () => {
        // At phone width the web's settings screen shows Preferences instead.
        for (const path of ['/app/settings/learning', '/app/settings/learning/', '/app/settings/learning?course=c1',
            '/app/settings/learning/c1', '/app/settings/integrations', '/app/settings/integrations#github']) {
            expect({ path, served: servedOnPhoneWeb(path) }).toEqual({ path, served: false });
        }
        expect(servedOnPhoneWeb('/app/settings/help_support')).toBe(true);
    });
});

describe('imageSource', () => {
    const HEADERS = { 'X-Beeflow-Client': 'android', 'X-Session-Token': 'tok' };

    it('loads a stored image from the server, with the session headers', () => {
        expect(imageSource({ url: '/api/storage/proxy/u1/images/a.png', mimeType: 'image/png' }, SERVER, HEADERS)).toEqual({
            uri: `${SERVER}/api/storage/proxy/u1/images/a.png`,
            headers: HEADERS,
        });
        expect(imageSource({ url: `${SERVER}/uploads/generated/a.png`, mimeType: 'image/png' }, SERVER, HEADERS)).toEqual({
            uri: `${SERVER}/uploads/generated/a.png`,
            headers: HEADERS,
        });
    });

    it('never sends the session headers to another host', () => {
        expect(imageSource({ url: 'https://cdn.provider.example/x.png', mimeType: 'image/png' }, SERVER, HEADERS)).toEqual({
            uri: 'https://cdn.provider.example/x.png',
        });
    });

    it('draws inline data when there is no URL, and a data: URL as it is', () => {
        expect(imageSource({ data: 'AAA', mimeType: 'image/jpeg' }, SERVER, HEADERS)).toEqual({
            uri: 'data:image/jpeg;base64,AAA',
        });
        expect(imageSource({ url: 'data:image/png;base64,BBB', mimeType: 'image/png' }, SERVER, HEADERS)).toEqual({
            uri: 'data:image/png;base64,BBB',
        });
    });

    it('answers null when there is nothing it can load', () => {
        expect(imageSource({ mimeType: 'image/png' }, SERVER, HEADERS)).toBeNull();
        expect(imageSource({ url: '/api/storage/a.png', mimeType: 'image/png' }, null, HEADERS)).toBeNull();
    });

    it('falls back to inline data when a relative URL cannot be resolved', () => {
        expect(imageSource({ url: '/api/storage/a.png', data: 'AAA', mimeType: 'image/png' }, null, HEADERS)).toEqual({
            uri: 'data:image/png;base64,AAA',
        });
    });
});
