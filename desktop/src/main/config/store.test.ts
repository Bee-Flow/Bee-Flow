import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { SettingsStore, type StoreIo } from './store.ts';

/** An in-memory filesystem with the four failure modes this store cares about. */
class FakeFs implements StoreIo {
    files = new Map<string, string>();
    /** Paths whose next read throws something other than ENOENT. */
    unreadable = new Set<string>();
    writes: string[] = [];

    async readFile(file: string): Promise<string> {
        if (this.unreadable.has(file)) {
            const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
        }
        const value = this.files.get(file);
        if (value === undefined) {
            const error = new Error(`ENOENT: no such file ${file}`) as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        }
        return value;
    }

    async writeFile(file: string, data: string): Promise<void> {
        this.writes.push(file);
        this.files.set(file, data);
    }

    async rename(from: string, to: string): Promise<void> {
        const value = this.files.get(from);
        if (value === undefined) throw new Error(`ENOENT: ${from}`);
        this.files.delete(from);
        this.files.set(to, value);
    }

    async mkdir(): Promise<string | undefined> {
        return undefined;
    }

    async unlink(file: string): Promise<void> {
        this.files.delete(file);
    }

    async copyFile(from: string, to: string): Promise<void> {
        const value = this.files.get(from);
        if (value === undefined) {
            const error = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        }
        this.files.set(to, value);
    }
}

const FILE = '/home/tom/.config/Bee Flow/settings.json';

let io: FakeFs;
let warnings: string[];

function makeStore(): SettingsStore {
    return new SettingsStore({ file: FILE, io, platform: 'linux', onWarning: (m) => warnings.push(m) });
}

beforeEach(() => {
    io = new FakeFs();
    warnings = [];
});

describe('SettingsStore.load', () => {
    it('starts from defaults on a first run, without writing anything', async () => {
        const store = makeStore();
        const settings = await store.load();
        assert.equal(settings.server.url, '');
        assert.deepEqual(io.writes, [], 'a read should not create the file');
        assert.deepEqual(warnings, [], 'a missing file on first run is not a warning');
    });

    it('reads what is there', async () => {
        io.files.set(FILE, JSON.stringify({ server: { url: 'https://bee.example.com' } }));
        const settings = await makeStore().load();
        assert.equal(settings.server.url, 'https://bee.example.com');
    });

    it('falls back to the backup when the live file is corrupt, and keeps the corpse', async () => {
        io.files.set(FILE, '{"server": {"url": "https://bee.exa');
        io.files.set(`${FILE}.bak`, JSON.stringify({ server: { url: 'https://bee.example.com' } }));

        const settings = await makeStore().load();

        assert.equal(settings.server.url, 'https://bee.example.com');
        assert.ok(io.files.has(`${FILE}.corrupt`), 'the damaged file is kept for diagnosis');
        assert.equal(warnings.length, 1);
        assert.match(String(io.files.get(FILE)), /bee\.example\.com/, 'the good copy is restored');
    });

    it('falls all the way back to defaults when neither copy can be read', async () => {
        io.files.set(FILE, 'not json at all');
        const settings = await makeStore().load();
        assert.equal(settings.server.url, '');
        assert.ok(io.files.has(`${FILE}.corrupt`));
    });

    it('does not mistake an unreadable file for a missing one', async () => {
        io.files.set(FILE, '{}');
        io.unreadable.add(FILE);
        const settings = await makeStore().load();
        assert.equal(settings.server.url, '');
        assert.match(warnings.join(' '), /EACCES/);
    });
});

describe('SettingsStore.save', () => {
    it('writes through a temporary file and renames it into place', async () => {
        const store = makeStore();
        await store.load();
        await store.patch({ server: { url: 'https://bee.example.com' } });

        assert.equal(io.writes.length, 1);
        assert.match(String(io.writes[0]), /\.tmp$/, 'the bytes land in a temporary file first');
        assert.ok(io.files.has(FILE), 'and are renamed over the real one');
        assert.equal(JSON.parse(String(io.files.get(FILE))).server.url, 'https://bee.example.com');
    });

    it('keeps the previous version as a backup', async () => {
        io.files.set(FILE, JSON.stringify({ server: { url: 'https://old.example' } }));
        const store = makeStore();
        await store.load();
        await store.patch({ server: { url: 'https://new.example' } });

        assert.equal(JSON.parse(String(io.files.get(`${FILE}.bak`))).server.url, 'https://old.example');
        assert.equal(JSON.parse(String(io.files.get(FILE))).server.url, 'https://new.example');
    });

    it('normalises on the way in, so nothing invalid is ever persisted', async () => {
        const store = makeStore();
        await store.load();
        const saved = await store.patch({ updates: { channel: 'nightly' }, appearance: { zoomLevel: 42 } });
        assert.equal(saved.updates.channel, 'stable');
        assert.equal(saved.appearance.zoomLevel, 5);
    });

    it('serialises concurrent saves instead of interleaving them', async () => {
        const store = makeStore();
        await store.load();
        await Promise.all([
            store.patch({ server: { url: 'https://one.example' } }),
            store.patch({ server: { url: 'https://two.example' } }),
            store.patch({ server: { url: 'https://three.example' } }),
        ]);
        await store.flush();
        const onDisk = JSON.parse(String(io.files.get(FILE)));
        assert.equal(onDisk.server.url, 'https://three.example', 'the last write wins, whole');
    });

    it('surfaces a failed write as a warning rather than an unhandled rejection', async () => {
        const store = makeStore();
        await store.load();
        io.rename = async () => {
            throw new Error('EROFS: read-only file system');
        };
        await store.patch({ server: { url: 'https://bee.example.com' } });
        assert.match(warnings.join(' '), /EROFS/);
        assert.equal(store.get().server.url, 'https://bee.example.com', 'the session still works');
    });

    it('tells listeners about every change', async () => {
        const store = makeStore();
        await store.load();
        const seen: string[] = [];
        const off = store.onChange((s) => seen.push(s.server.url));
        await store.patch({ server: { url: 'https://a.example' } });
        off();
        await store.patch({ server: { url: 'https://b.example' } });
        assert.deepEqual(seen, ['https://a.example']);
    });

    it('does not let a throwing listener break the save', async () => {
        const store = makeStore();
        await store.load();
        store.onChange(() => {
            throw new Error('listener exploded');
        });
        const saved = await store.patch({ server: { url: 'https://a.example' } });
        assert.equal(saved.server.url, 'https://a.example');
        assert.match(warnings.join(' '), /listener exploded/);
    });
});
