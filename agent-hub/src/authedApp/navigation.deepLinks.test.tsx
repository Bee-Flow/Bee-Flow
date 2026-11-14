/**
 * The navigation contract, part one: what a cold load of an address shows.
 *
 * Every row of INVENTORY (navigationInventory.ts) is loaded from its address
 * and must show its page and keep (or rewrite to) its address; then the edges
 * — unknown paths, the marketing gate on a self-hosted install, a member on an
 * admin page, signed out, the phone allow-list — and the Nextcloud and desktop
 * entry points. Part two (navigation.history.test.tsx) is the navigation call
 * and Back/Forward.
 */
import { afterEach, describe, it, vi } from 'vitest';
import { HISTORY_FLOOR, MEMBER, QUICK, WAIT, back, bootAt, expectAt, expectShows, onAPhone } from './navigationHarness';
import { APP_ID, INVENTORY, landing } from './navigationInventory';

afterEach(() => { vi.unstubAllGlobals(); });

describe('a cold load of the address shows the page', () => {
    for (const row of INVENTORY) {
        const fails = row.fails?.load;
        const wait = fails ? QUICK : WAIT;
        (fails ? it.fails : it)(`${row.url} → ${row.page}${fails ? ` (fails: ${fails})` : ''}`, async () => {
            await bootAt(row.url, row.shows, {}, wait);
            await expectAt(landing(row), wait);
            // Still there once the address settled: a page that flashes and is replaced does not count.
            await expectShows(row.shows, wait);
        });
    }
});

describe('the public paths AppRoutes answers before the app', () => {
    it.each([
        ['the data-subject request form', '/dsr', { heading: 'Privacy request' }],
        ['its address in a privacy notice', '/privacy/requests', { heading: 'Privacy request' }],
        ['the embedded agent chat', '/chat/agent-1', { testId: 'embed-ai-disclosure' }],
    ] as const)('%s (%s), signed out', async (_what, url, shows) => {
        await bootAt(url, shows, { user: null });
        await expectAt(url);
    });
});

describe('the edges', () => {
    it.each([
        ['an unknown /app path', '/app/unknown'],
        ['an unknown multi-segment path (read as agent "b")', '/a/b/c'],
        ['the /login alias the server mails', '/login'],
        ['the /login alias with its query', '/login?verified=1'],
    ])('%s shows the home page and keeps the address', async (_what, url) => {
        await bootAt(url);
        await expectAt(url);
    });

    it.each([
        ['a one-segment path', '/about'],
        ['the legacy ?page= at the root (the marketing gate answers first)', '/?page=settings'],
        ['a refused Nextcloud ?ncPath=', '/?ncPath=%2F%2Fexample.org'],
    ])('on a self-hosted install, %s hands over to /app', async (_what, url) => {
        await bootAt(url);
        await expectAt('/app');
    });

    it('a legacy ?page= on a path nothing else claims opens that page', async () => {
        await bootAt('/x/y?page=settings', { current: 'settings-nav-preferences' });
        await expectAt('/x/y?page=settings');
    });

    describe('a member (no admin rights)', () => {
        const member = { user: MEMBER };
        it('on an admin dashboard address sees the access-denied page, at the same address', async () => {
            await bootAt('/app/admin/ai-config', { testId: 'admin-access-denied-whole' }, member);
            await expectAt('/app/admin/ai-config');
        });
        it('on organisation settings sees its access-denied text', async () => {
            await bootAt('/app/org-settings', { text: "You don't have permission to access organisation settings." }, member);
            await expectAt('/app/org-settings');
        });
        it('on the agent editor sees its no-access page', async () => {
            await bootAt('/app/agent-designer/ag1', { text: 'No access to the Agent Editor' }, member);
            await expectAt('/app/agent-designer/ag1');
        });
    });

    it('signed out, a deep link shows the sign-in page and keeps the address', async () => {
        await bootAt('/app/studio/agents', { heading: 'Sign in to continue' }, { user: null });
        await expectAt('/app/studio/agents');
    });

    describe('on a phone (the mobile allow-list)', () => {
        it('a desktop-only address bounces to /app', async () => {
            onAPhone();
            await bootAt('/app/studio/agents');
            await expectAt('/app');
        });
        it('the approvals slice of Studio stays open', async () => {
            onAPhone();
            await bootAt('/app/studio/approvals/apr1', { text: 'All approvals' });
            await expectAt('/app/studio/approvals/apr1');
        });
    });
});

describe('the Nextcloud and desktop entry points', () => {
    // HaRP's proxy root: inside Nextcloud the pathname never names a screen.
    const NC_ROOT = '/exapps/bee_flow/';

    it('?ncStudioApp=<id> at the proxy root boots into that app', async () => {
        await bootAt(`${NC_ROOT}?ncStudioApp=${APP_ID}`, { text: 'This app is not available to you' });
        await expectAt(`${NC_ROOT}?ncStudioApp=${APP_ID}`);
    });
    it('an ?ncStudioApp that is not an app id falls back to the home page', async () => {
        await bootAt(`${NC_ROOT}?ncStudioApp=not-an-id`);
    });
    it('?ncPath= swaps the address for the in-app path before the first render', async () => {
        await bootAt('/?ncPath=%2Fapp%2Fcowork', { testId: 'cowork-welcome' });
        await expectAt('/app/cowork');
    });

    // The desktop client turns beeflow://<verb>/<id> into an SPA address
    // (desktop/src/main/deepLink.ts) and loads it; agent-hub reads no
    // beeflow:// link itself. These are the addresses it hands over.
    it('beeflow://documents/<id> → /app/documents/<id> opens the document', async () => {
        await bootAt('/app/documents/d1', { text: 'Document not found.' });
    });
    it('beeflow://automations/<id> → /app/automations/<id> opens Studio automations', async () => {
        await bootAt('/app/automations/t1', { current: 'rail-aiTasks' });
    });
    it('beeflow://knowledge/<id> → /app/knowledge/<id> opens that knowledge base in Studio, at its own address', async () => {
        await bootAt('/app/knowledge/kb1', { testId: 'kb-detail-page' });
        await expectAt('/app/studio/knowledge/kb1');
    });
    it('beeflow://chat/<id> → /app/chat/<id> opens that conversation, at its own address', async () => {
        await bootAt('/app/chat/c1', { testId: 'chat-input-form' });
        await expectAt('/app/d/c1');
    });
    // A task is a Cowork item (the run notification links /app/cowork/<id>).
    it('beeflow://tasks/<id> → /app/tasks/<id> opens that Cowork item, at its own address', async () => {
        await bootAt('/app/tasks/cw1', { testId: 'cowork-welcome' });
        await expectAt('/app/cowork/cw1');
    });
    it('the forwarding address is not a history entry: Back from the target leaves the app page', async () => {
        await bootAt('/app/knowledge/kb1', { testId: 'kb-detail-page' });
        await expectAt('/app/studio/knowledge/kb1');
        await back();
        await expectAt(HISTORY_FLOOR);
    });
});
