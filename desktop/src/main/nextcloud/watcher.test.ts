import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NextcloudAccount, WatchedFileEvent, WatchedFolder } from '../../shared/types.ts';
import { FolderWatcher, shouldIgnore, type WatcherLike } from './watcher.ts';

describe('shouldIgnore', () => {
    it("leaves the Nextcloud client's own machinery alone", () => {
        for (const name of [
            '._sync_2f1a0c.db',
            '._sync_2f1a0c.db-shm',
            '.owncloudsync.log',
            '.owncloudsync.log.1',
            'rapport.pdf.nextclouddownload',
            'rapport.pdf.~a1b2c3d4',
        ]) {
            assert.equal(shouldIgnore(`/home/tom/Nextcloud/${name}`), true, name);
        }
    });

    it('ignores a virtual-files placeholder, which has no content to ingest', () => {
        assert.equal(shouldIgnore('/home/tom/Nextcloud/jaarverslag.pdf.nextcloud'), true);
        assert.equal(shouldIgnore('/home/tom/Nextcloud/jaarverslag.pdf'), false);
    });

    it('ignores what editors and desktops leave behind', () => {
        for (const name of ['.~lock.offerte.odt#', '~$begroting.xlsx', '.goutputstream-AB12CD', '.DS_Store', 'Thumbs.db', 'desktop.ini', 'notes.txt.swp', 'x.part']) {
            assert.equal(shouldIgnore(`/home/tom/Nextcloud/${name}`), true, name);
        }
    });

    it('does not descend into directories that are never documents', () => {
        assert.equal(shouldIgnore('/home/tom/Nextcloud/project/.git/config'), true);
        assert.equal(shouldIgnore('/home/tom/Nextcloud/app/node_modules/pkg/readme.md'), true);
    });

    it('lets real documents through, including ones with awkward names', () => {
        for (const name of ['rapport.pdf', 'Offerte 2026 — definitief.docx', 'notities.md', 'Überprüfung.odt', 'a.b.c.txt']) {
            assert.equal(shouldIgnore(`/home/tom/Nextcloud/${name}`), false, name);
        }
    });

    it('handles Windows separators', () => {
        assert.equal(shouldIgnore('C:\\Users\\tom\\Nextcloud\\._sync_1a.db'), true);
        assert.equal(shouldIgnore('C:\\Users\\tom\\Nextcloud\\rapport.pdf'), false);
    });
});

/** A watcher that lets a test fire filesystem events by hand. */
class FakeWatcher implements WatcherLike {
    closed = false;
    private listeners = new Map<string, ((value: never) => void)[]>();

    on(event: string, listener: (value: never) => void): this {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
        return this;
    }

    fire(event: string, value: unknown): void {
        for (const listener of this.listeners.get(event) ?? []) (listener as (v: unknown) => void)(value);
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}

const accounts: NextcloudAccount[] = [
    {
        id: '0',
        url: 'https://cloud.example.com',
        user: 'tom',
        davUser: 'tom',
        folders: [{ localPath: '/home/tom/Nextcloud', targetPath: '/', accountId: '0', virtualFiles: false }],
    },
];

function folder(overrides: Partial<WatchedFolder> = {}): WatchedFolder {
    return {
        id: 'w1',
        path: '/home/tom/Nextcloud/Contracten',
        knowledgeBaseId: 'kb-42',
        label: 'Contracten',
        enabled: true,
        recursive: true,
        ...overrides,
    };
}

function harness() {
    const watchers = new Map<string, FakeWatcher>();
    const events: WatchedFileEvent[] = [];
    const warnings: string[] = [];
    const watcher = new FolderWatcher({
        createWatcher: (path) => {
            const fake = new FakeWatcher();
            watchers.set(path, fake);
            return fake;
        },
        onFile: (event) => events.push(event),
        onWarning: (message) => warnings.push(message),
        accounts: () => accounts,
        platform: 'linux',
        debounceMs: 5,
        now: () => 1_700_000_000_000,
    });
    return { watcher, watchers, events, warnings };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

/** The options FolderWatcher hands to its file watcher for one folder. */
async function watchOptions(watched: WatchedFolder): Promise<Record<string, unknown>> {
    const options: Record<string, unknown> = {};
    const watcher = new FolderWatcher({
        createWatcher: (_path, opts) => {
            Object.assign(options, opts);
            return new FakeWatcher();
        },
        onFile: () => undefined,
        accounts: () => accounts,
    });
    await watcher.sync([watched]);
    return options;
}

describe('FolderWatcher', () => {
    it('reports a new file with the Nextcloud reference attached', async () => {
        const { watcher, watchers, events } = harness();
        await watcher.sync([folder()]);

        watchers.get('/home/tom/Nextcloud/Contracten')?.fire('add', '/home/tom/Nextcloud/Contracten/2026/huur.pdf');
        await settle();

        assert.equal(events.length, 1);
        assert.equal(events[0]?.knowledgeBaseId, 'kb-42');
        assert.equal(events[0]?.kind, 'added');
        assert.equal(events[0]?.remote?.remotePath, '/Contracten/2026/huur.pdf');
        assert.equal(events[0]?.remote?.webdavUrl, 'https://cloud.example.com/remote.php/dav/files/tom/Contracten/2026/huur.pdf');
    });

    it('still reports a file in a folder that is not inside Nextcloud', async () => {
        const { watcher, watchers, events } = harness();
        await watcher.sync([folder({ path: '/home/tom/Documenten' })]);

        watchers.get('/home/tom/Documenten')?.fire('add', '/home/tom/Documenten/notulen.md');
        await settle();

        assert.equal(events.length, 1);
        assert.equal(events[0]?.remote, undefined, 'no remote reference, and that is a valid answer');
    });

    it('coalesces the burst of events one save produces', async () => {
        const { watcher, watchers, events } = harness();
        await watcher.sync([folder()]);
        const fake = watchers.get('/home/tom/Nextcloud/Contracten');

        fake?.fire('add', '/home/tom/Nextcloud/Contracten/offerte.odt');
        fake?.fire('change', '/home/tom/Nextcloud/Contracten/offerte.odt');
        fake?.fire('change', '/home/tom/Nextcloud/Contracten/offerte.odt');
        await settle();

        assert.equal(events.length, 1);
        assert.equal(events[0]?.kind, 'changed', 'the last event wins');
    });

    it('does not coalesce two different files', async () => {
        const { watcher, watchers, events } = harness();
        await watcher.sync([folder()]);
        const fake = watchers.get('/home/tom/Nextcloud/Contracten');

        fake?.fire('add', '/home/tom/Nextcloud/Contracten/a.pdf');
        fake?.fire('add', '/home/tom/Nextcloud/Contracten/b.pdf');
        await settle();

        assert.equal(events.length, 2);
    });

    it('never reports the machinery', async () => {
        const { watcher, watchers, events } = harness();
        await watcher.sync([folder()]);
        const fake = watchers.get('/home/tom/Nextcloud/Contracten');

        fake?.fire('add', '/home/tom/Nextcloud/Contracten/._sync_1a2b.db');
        fake?.fire('change', '/home/tom/Nextcloud/Contracten/huur.pdf.~ab12cd34');
        await settle();

        assert.deepEqual(events, []);
    });

    it('waits for the file to stop changing before reading it', async () => {
        const options = await watchOptions(folder());
        assert.equal(options.ignoreInitial, true, 'a new watch is not a thousand new documents');
        assert.ok((options.awaitWriteFinish as { stabilityThreshold: number }).stabilityThreshold >= 1000);
    });

    it('does not descend when the folder is not recursive', async () => {
        const options = await watchOptions(folder({ recursive: false }));
        assert.equal(options.depth, 0);
    });
});

describe('FolderWatcher.sync', () => {
    it('keeps a watcher that did not change and starts one that did', async () => {
        const { watcher, watchers } = harness();
        await watcher.sync([folder()]);
        const first = watchers.get('/home/tom/Nextcloud/Contracten');

        await watcher.sync([folder(), folder({ id: 'w2', path: '/home/tom/Nextcloud/Facturen' })]);

        assert.equal(first?.closed, false, 'the existing watch is not restarted');
        assert.deepEqual(watcher.active.sort(), ['w1', 'w2']);
    });

    it('stops a watcher for a folder that was removed or disabled', async () => {
        const { watcher, watchers } = harness();
        await watcher.sync([folder()]);
        await watcher.sync([folder({ enabled: false })]);

        assert.equal(watchers.get('/home/tom/Nextcloud/Contracten')?.closed, true);
        assert.deepEqual(watcher.active, []);
    });

    it('reports a folder it cannot watch without taking the others down', async () => {
        const events: WatchedFileEvent[] = [];
        const warnings: string[] = [];
        const started: string[] = [];
        const watcher = new FolderWatcher({
            createWatcher: (path) => {
                if (path.includes('Geheim')) throw new Error('EACCES: permission denied');
                started.push(path);
                return new FakeWatcher();
            },
            onFile: (event) => events.push(event),
            onWarning: (message) => warnings.push(message),
            accounts: () => accounts,
        });

        await watcher.sync([folder({ id: 'w1', path: '/home/tom/Nextcloud/Geheim' }), folder({ id: 'w2' })]);

        assert.match(warnings.join(' '), /EACCES/);
        assert.deepEqual(started, ['/home/tom/Nextcloud/Contracten']);
        assert.deepEqual(watcher.active, ['w2']);
    });

    it('stops everything on shutdown', async () => {
        const { watcher, watchers } = harness();
        await watcher.sync([folder(), folder({ id: 'w2', path: '/home/tom/Nextcloud/Facturen' })]);
        await watcher.stopAll();
        assert.deepEqual(watcher.active, []);
        assert.ok([...watchers.values()].every((w) => w.closed));
    });
});
