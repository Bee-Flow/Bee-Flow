import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { basenameOf, defaultSettings, mergeSettings, MAX_RECENT_SERVERS, normaliseSettings, settingsForServerPage } from './schema.ts';

describe('defaultSettings', () => {
    it('keeps the last window open on macOS and hides to the tray elsewhere', () => {
        assert.equal(defaultSettings('darwin').launch.closeToTray, false);
        assert.equal(defaultSettings('win32').launch.closeToTray, true);
        assert.equal(defaultSettings('linux').launch.closeToTray, true);
    });

    it('uses the platform modifier for the quick-ask accelerator', () => {
        assert.equal(defaultSettings('darwin').shortcuts.quickAsk, 'Command+Shift+Space');
        assert.equal(defaultSettings('linux').shortcuts.quickAsk, 'Control+Shift+Space');
    });
});

describe('normaliseSettings', () => {
    it('returns usable settings for junk input', () => {
        for (const junk of [null, undefined, 42, 'nope', [], { server: 'not-an-object' }]) {
            const settings = normaliseSettings(junk, 'linux');
            assert.equal(settings.server.url, '');
            assert.deepEqual(settings.server.recent, []);
            assert.equal(settings.updates.channel, 'stable');
        }
    });

    it('keeps values it understands and replaces the ones it does not', () => {
        const settings = normaliseSettings(
            {
                server: { url: 'https://bee.example.com/' },
                updates: { channel: 'nightly', enabled: 'yes' },
                appearance: { theme: 'dark', zoomLevel: 99 },
            },
            'linux',
        );
        assert.equal(settings.server.url, 'https://bee.example.com');
        assert.equal(settings.updates.channel, 'stable', 'unknown channel falls back');
        assert.equal(settings.updates.enabled, true, 'non-boolean falls back to the default');
        assert.equal(settings.appearance.theme, 'dark');
        assert.equal(settings.appearance.zoomLevel, 5, 'zoom is clamped, not discarded');
    });

    it('drops the current server from the recent list and de-duplicates it', () => {
        const settings = normaliseSettings(
            {
                server: {
                    url: 'https://a.example',
                    recent: ['https://a.example/', 'https://b.example', 'https://b.example', 7, 'https://c.example'],
                },
            },
            'linux',
        );
        assert.deepEqual(settings.server.recent, ['https://b.example', 'https://c.example']);
    });

    it("keeps the server's single sign-on origin only alongside the server itself", () => {
        const kept = normaliseSettings({ server: { url: 'https://bee.example.com', apiOrigin: 'https://api.bee.example.com/auth' } }, 'linux');
        assert.equal(kept.server.apiOrigin, 'https://api.bee.example.com', 'reduced to an origin');
        for (const [url, apiOrigin] of [
            ['', 'https://api.bee.example.com'],
            ['https://bee.example.com', 'https://bee.example.com'],
            ['https://bee.example.com', 'javascript:alert(1)'],
            ['https://bee.example.com', 42],
        ] as const) {
            assert.equal(normaliseSettings({ server: { url, apiOrigin } }, 'linux').server.apiOrigin, '', `${url} / ${String(apiOrigin)}`);
        }
    });

    it('caps the recent list', () => {
        const recent = Array.from({ length: 30 }, (_, i) => `https://host-${i}.example`);
        const settings = normaliseSettings({ server: { url: '', recent } }, 'linux');
        assert.equal(settings.server.recent.length, MAX_RECENT_SERVERS);
    });

    it('rejects watched folders that could never do anything', () => {
        const settings = normaliseSettings(
            {
                nextcloud: {
                    watchedFolders: [
                        { id: 'a', path: '/home/tom/Nextcloud/Work', knowledgeBaseId: 'kb-1' },
                        { id: 'b', path: '', knowledgeBaseId: 'kb-2' },
                        { id: 'c', path: '/home/tom/Nextcloud/Other', knowledgeBaseId: '' },
                        { id: 'a', path: '/home/tom/Nextcloud/Dup', knowledgeBaseId: 'kb-3' },
                    ],
                },
            },
            'linux',
        );
        assert.equal(settings.nextcloud.watchedFolders.length, 1);
        assert.equal(settings.nextcloud.watchedFolders[0]?.label, 'Work', 'label defaults to the folder name');
        assert.equal(settings.nextcloud.watchedFolders[0]?.enabled, true);
    });
});

describe('mergeSettings', () => {
    it('merges one level into a section without dropping its siblings', () => {
        const current = defaultSettings('linux');
        const next = mergeSettings(current, { notifications: { enabled: false } }, 'linux');
        assert.equal(next.notifications.enabled, false);
        assert.equal(next.notifications.onlyWhenUnfocused, current.notifications.onlyWhenUnfocused);
    });

    it('replaces arrays instead of merging them, so a removal is expressible', () => {
        const current = normaliseSettings(
            { nextcloud: { watchedFolders: [{ id: 'a', path: '/x', knowledgeBaseId: 'kb' }] } },
            'linux',
        );
        const next = mergeSettings(current, { nextcloud: { watchedFolders: [] } }, 'linux');
        assert.deepEqual(next.nextcloud.watchedFolders, []);
    });

    it('ignores undefined values rather than writing them over real ones', () => {
        const current = normaliseSettings({ server: { url: 'https://a.example' } }, 'linux');
        const next = mergeSettings(current, { server: undefined }, 'linux');
        assert.equal(next.server.url, 'https://a.example');
    });
});

describe('basenameOf', () => {
    it('handles both separators regardless of the host platform', () => {
        assert.equal(basenameOf('/home/tom/Nextcloud/Work/'), 'Work');
        assert.equal(basenameOf('C:\\Users\\tom\\Nextcloud\\Work'), 'Work');
        assert.equal(basenameOf('Work'), 'Work');
    });
});

describe('settingsForServerPage', () => {
    it("hides the user's other servers and the Nextcloud client's paths from the workspace", () => {
        const full = normaliseSettings(
            {
                server: { url: 'https://work.example', recent: ['https://other-employer.example'], apiOrigin: 'https://api.work.example' },
                nextcloud: { configPath: '/home/tom/.config/Nextcloud/nextcloud.cfg', socketPath: '/run/user/1000/Nextcloud/socket', saveFolder: '/home/tom/Nextcloud/Bee Flow' },
            },
            'linux',
        );
        const view = settingsForServerPage(full);
        assert.deepEqual(view.server, { url: 'https://work.example', recent: [], apiOrigin: '' });
        assert.equal(view.nextcloud.configPath, '');
        assert.equal(view.nextcloud.socketPath, '');
        assert.equal(view.nextcloud.saveFolder, '/home/tom/Nextcloud/Bee Flow', 'what the page can act on stays');
        assert.deepEqual(view.appearance, full.appearance);
        assert.deepEqual(full.server.recent, ['https://other-employer.example'], 'the original is not touched');
    });
});
