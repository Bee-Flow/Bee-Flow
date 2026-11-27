// Unit tests of gui-screenshots.mjs: the addresses it takes from the inventory goldens (made-up ones here, and
// the real ones of the tree) and the file names; the browser part needs a running stack and is not run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryRoutes, shotName } from './gui-screenshots.mjs';

const FAKE = {
    'src/authedApp/appRoutes.inventory.golden.json': {
        routes: [{ pattern: '/app/notebooks', redirect: '/app/studio/documents' }, { pattern: '/app', page: 'agents' }],
        pages: [{ page: 'agents', path: '/app' }, { page: 'notebooks', path: '/app/notebooks' }, { page: 'appRun' }],
    },
    'src/authedApp/settingsRoutes.inventory.golden.json': { topLevel: [{ path: '/app/settings/preferences' }] },
    'src/components/admin/Studio/studioSections.inventory.golden.json': { start: { urlSegment: 'start' }, sections: [{ urlSegment: 'agents' }] },
    'src/components/admin/dashboard/adminTabs.inventory.golden.json': {
        tabs: [{ id: 'agents' }, { id: 'organisation' }], railRows: { agents: [{ section: 'chat' }] },
    },
    'src/components/admin/organisation/orgSections.inventory.golden.json': { sections: [{ id: 'info' }] },
};

test('the addresses: pages with an address of their own, then settings, Studio, admin and organisation', () => {
    assert.deepEqual(inventoryRoutes((p) => FAKE[p]), [
        '/app', '/app/settings/preferences', '/app/studio/start', '/app/studio/agents',
        '/app/admin/agents', '/app/admin/agents/chat', '/app/admin/organisation/info',
    ]);
});

test('the real goldens give every screen once', () => {
    const all = inventoryRoutes();
    assert.ok(all.length > 80, `only ${all.length} addresses`);
    assert.equal(new Set(all).size, all.length);
    assert.ok(all.every((a) => a.startsWith('/app')));
});

test('a file name per address', () => {
    assert.equal(shotName('/app/admin/security/sso'), 'app__admin__security__sso.png');
    assert.equal(shotName('/'), 'root.png');
});
