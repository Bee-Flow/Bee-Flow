import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DesktopSettings, NextcloudStatus } from '../../shared/types.ts';
import { defaultSettings } from '../config/schema.ts';
import { NextcloudBridge, safeFileName, type BridgeIo } from './bridge.ts';
import type { SocketLike } from './socketApi.ts';

const CONFIG = `[Accounts]
0\\Folders\\1\\localPath=/home/tom/Nextcloud/
0\\Folders\\1\\targetPath=/
0\\dav_user=tom
0\\url=https://cloud.example.com
0\\user=tom
`;

class FakeIo implements BridgeIo {
    files = new Map<string, string | Uint8Array>();
    directories = new Set<string>();
    written: string[] = [];
    realpath?: (file: string) => Promise<string>;

    async readFile(file: string): Promise<string> {
        const value = this.files.get(file);
        if (typeof value !== 'string') {
            const error = new Error(`ENOENT: ${file}`) as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        }
        return value;
    }
    async writeFile(file: string, data: string | Uint8Array): Promise<void> {
        this.written.push(file);
        this.files.set(file, data);
    }
    async mkdir(dir: string): Promise<string | undefined> {
        this.directories.add(dir);
        return undefined;
    }
    async stat(file: string): Promise<{ isDirectory(): boolean }> {
        if (this.directories.has(file)) return { isDirectory: () => true };
        if (this.files.has(file)) return { isDirectory: () => false };
        throw new Error(`ENOENT: ${file}`);
    }
    async access(file: string): Promise<void> {
        if (!this.files.has(file)) throw new Error(`ENOENT: ${file}`);
    }
}

/** A socket that answers the handshake and every status query with OK. */
class FakeSocket implements SocketLike {
    written: string[] = [];
    private listeners = new Map<string, ((value: never) => void)[]>();

    write(data: string): boolean {
        this.written.push(data);
        if (data.startsWith('VERSION:')) queueMicrotask(() => this.emit('data', 'VERSION:3.18.2:1.1\n'));
        if (data.startsWith('RETRIEVE_FILE_STATUS:')) {
            const path = data.slice('RETRIEVE_FILE_STATUS:'.length).trim();
            queueMicrotask(() => this.emit('data', `STATUS:OK:${path}\n`));
        }
        return true;
    }
    destroy(): void {}
    on(event: string, listener: (value: never) => void): this {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
        return this;
    }
    emit(event: string, value?: unknown): void {
        for (const listener of this.listeners.get(event) ?? []) (listener as (v: unknown) => void)(value);
    }
}

function settingsWith(overrides: Partial<DesktopSettings['nextcloud']> = {}): DesktopSettings {
    const base = defaultSettings('linux');
    return { ...base, nextcloud: { ...base.nextcloud, ...overrides } };
}

function makeBridge(options: { io?: FakeIo; socket?: FakeSocket | null; settings?: DesktopSettings } = {}) {
    const io = options.io ?? new FakeIo();
    io.files.set('/home/tom/.config/Nextcloud/nextcloud.cfg', CONFIG);
    const socket = options.socket === undefined ? new FakeSocket() : options.socket;
    const statuses: NextcloudStatus[] = [];
    const warnings: string[] = [];
    const bridge = new NextcloudBridge({
        settings: () => options.settings ?? settingsWith(),
        io,
        platform: 'linux',
        env: { XDG_RUNTIME_DIR: '/run/user/1000' },
        home: '/home/tom',
        connect: async () => {
            if (!socket) throw new Error('ECONNREFUSED');
            return socket;
        },
        onStatusChanged: (status) => statuses.push(status),
        onWarning: (message) => warnings.push(message),
    });
    return { bridge, io, socket, statuses, warnings };
}

describe('NextcloudBridge.refresh', () => {
    it('reads the config and reports the accounts it found', async () => {
        const { bridge, statuses } = makeBridge();
        const status = await bridge.refresh();

        assert.equal(status.installed, true);
        assert.equal(status.running, true);
        assert.equal(status.configPath, '/home/tom/.config/Nextcloud/nextcloud.cfg');
        assert.equal(status.accounts[0]?.url, 'https://cloud.example.com');
        assert.equal(statuses.length, 1, 'and tells anyone listening');
    });

    it('works with the client installed but not running', async () => {
        const { bridge } = makeBridge({ socket: null });
        const status = await bridge.refresh();

        assert.equal(status.installed, true, 'the config is still readable');
        assert.equal(status.running, false);
        assert.equal(status.accounts[0]?.folders.length, 1, 'and everything it needs is in it');
    });

    it('says what to do when there is no Nextcloud client at all', async () => {
        const io = new FakeIo();
        const { bridge } = makeBridge({ io, socket: null });
        io.files.clear();

        const status = await bridge.refresh();
        assert.equal(status.installed, false);
        assert.match(String(status.error), /Install the Nextcloud desktop app/);
    });

    it('does nothing at all when the integration is switched off', async () => {
        const { bridge } = makeBridge({ settings: settingsWith({ enabled: false }) });
        const status = await bridge.refresh();
        assert.deepEqual(status, { installed: false, running: false, accounts: [] });
    });

    it('registers the sync folders with the running client', async () => {
        const { bridge, socket } = makeBridge();
        await bridge.refresh();
        assert.ok(socket?.written.includes('REGISTER_PATH:/home/tom/Nextcloud\n'));
    });

    it('honours an explicit config path from settings', async () => {
        const io = new FakeIo();
        io.files.set('/opt/nc/nextcloud.cfg', CONFIG);
        const { bridge } = makeBridge({ io, settings: settingsWith({ configPath: '/opt/nc/nextcloud.cfg' }) });
        const status = await bridge.refresh();
        assert.equal(status.configPath, '/opt/nc/nextcloud.cfg');
    });
});

describe('NextcloudBridge.resolve', () => {
    it('adds live sync state when the client is running', async () => {
        const { bridge, io } = makeBridge();
        io.files.set('/home/tom/Nextcloud/rapport.pdf', 'pdf bytes');
        await bridge.refresh();

        const [reference] = await bridge.resolve(['/home/tom/Nextcloud/rapport.pdf']);
        assert.equal(reference?.remotePath, '/rapport.pdf');
        assert.equal(reference?.syncState, 'OK');
    });

    it('omits the sync state rather than guessing when the client is down', async () => {
        const { bridge, io } = makeBridge({ socket: null });
        io.files.set('/home/tom/Nextcloud/rapport.pdf', 'pdf bytes');
        await bridge.refresh();

        const [reference] = await bridge.resolve(['/home/tom/Nextcloud/rapport.pdf']);
        assert.equal(reference?.syncState, undefined);
        assert.equal(reference?.webdavUrl, 'https://cloud.example.com/remote.php/dav/files/tom/rapport.pdf');
    });

    it('silently drops paths that are not in a sync folder', async () => {
        const { bridge } = makeBridge();
        await bridge.refresh();
        assert.deepEqual(await bridge.resolve(['/home/tom/Downloads/x.pdf']), []);
    });
});

describe('NextcloudBridge.save', () => {
    it('writes into the sync folder and hands back the reference', async () => {
        const { bridge, io } = makeBridge();
        await bridge.refresh();

        const reference = await bridge.save({ fileName: 'samenvatting.md', data: '# hello' });

        assert.equal(io.written[0], '/home/tom/Nextcloud/samenvatting.md');
        assert.equal(reference?.remotePath, '/samenvatting.md');
    });

    it('never overwrites an existing file', async () => {
        const { bridge, io } = makeBridge();
        await bridge.refresh();
        io.files.set('/home/tom/Nextcloud/nota.md', 'already here');

        const reference = await bridge.save({ fileName: 'nota.md', data: 'new' });

        assert.equal(reference?.localPath, '/home/tom/Nextcloud/nota (2).md');
        assert.equal(io.files.get('/home/tom/Nextcloud/nota.md'), 'already here');
    });

    it('refuses a folder outside the sync folders', async () => {
        const { bridge, io, warnings } = makeBridge();
        await bridge.refresh();

        const reference = await bridge.save({ fileName: 'x.sh', data: 'rm -rf /', folder: '/home/tom/.config/autostart' });

        assert.equal(reference, null);
        assert.deepEqual(io.written, []);
        assert.match(warnings.join(' '), /refusing to save outside/);
    });

    it('refuses a folder that climbs out of the sync folder with ..', async () => {
        // Compared as text this is "inside ~/Nextcloud"; path.join resolves
        // the `..` and writes into autostart, which runs at the next login.
        const { bridge, io } = makeBridge();
        await bridge.refresh();

        for (const folder of ['/home/tom/Nextcloud/../.config/autostart', '/home/tom/Nextcloud/sub/../../.config/autostart', '/home/tom/Nextcloud/./..']) {
            const reference = await bridge.save({ fileName: 'x.desktop', data: '[Desktop Entry]', folder });
            assert.equal(reference, null, folder);
        }
        assert.deepEqual(io.written, []);
    });

    it('refuses a folder inside the sync folder that is a link to somewhere else', async () => {
        const io = new FakeIo();
        io.realpath = async (file: string) =>
            file.startsWith('/home/tom/Nextcloud/escape') ? file.replace('/home/tom/Nextcloud/escape', '/home/tom/.config/autostart') : file;
        const { bridge } = makeBridge({ io });
        await bridge.refresh();

        const reference = await bridge.save({ fileName: 'x.desktop', data: '[Desktop Entry]', folder: '/home/tom/Nextcloud/escape' });

        assert.equal(reference, null);
        assert.deepEqual(io.written, []);
    });

    it('still saves into a real subfolder', async () => {
        const io = new FakeIo();
        io.realpath = async (file: string) => file;
        const { bridge } = makeBridge({ io });
        await bridge.refresh();

        const reference = await bridge.save({ fileName: 'nota.md', data: 'x', folder: '/home/tom/Nextcloud/Werk' });

        assert.equal(reference?.localPath, '/home/tom/Nextcloud/Werk/nota.md');
    });

    it('refuses a file name that tries to climb out', async () => {
        const { bridge, io } = makeBridge();
        await bridge.refresh();

        await bridge.save({ fileName: '../../.ssh/authorized_keys', data: 'ssh-rsa AAAA' });

        assert.equal(io.written[0], '/home/tom/Nextcloud/authorized_keys', 'the path is reduced to a name');
    });

    it('says so rather than throwing when nothing is synced', async () => {
        const io = new FakeIo();
        const { bridge, warnings } = makeBridge({ io, socket: null });
        io.files.clear();
        await bridge.refresh();

        assert.equal(await bridge.save({ fileName: 'x.md', data: 'y' }), null);
        assert.match(warnings.join(' '), /nowhere to save/);
    });
});

describe('safeFileName', () => {
    it('reduces a path to its last segment', () => {
        assert.equal(safeFileName('../../etc/passwd'), 'passwd');
        assert.equal(safeFileName('C:\\Windows\\System32\\drivers\\etc\\hosts'), 'hosts');
    });

    it('replaces characters Windows refuses', () => {
        assert.equal(safeFileName('re:port<1>.txt'), 're_port_1_.txt');
    });

    it('defuses a reserved device name', () => {
        assert.equal(safeFileName('CON'), '_CON');
        assert.equal(safeFileName('nul.txt'), '_nul.txt');
    });

    it('refuses what cannot be a file name at all', () => {
        assert.equal(safeFileName(''), '');
        assert.equal(safeFileName('..'), '');
        assert.equal(safeFileName('   '), '');
        assert.equal(safeFileName('/'), '');
    });

    it('caps a hostile length', () => {
        assert.equal(safeFileName(`${'a'.repeat(500)}.txt`).length, 200);
    });
});

describe('NextcloudBridge.share', () => {
    it('asks the running client rather than creating a share itself', async () => {
        const { bridge, socket } = makeBridge();
        await bridge.refresh();

        assert.equal(bridge.share('/home/tom/Nextcloud/rapport.pdf'), true);
        assert.ok(socket?.written.includes('SHARE:/home/tom/Nextcloud/rapport.pdf\n'));
    });

    it('reports false when the client is not running', async () => {
        const { bridge } = makeBridge({ socket: null });
        await bridge.refresh();
        assert.equal(bridge.share('/home/tom/Nextcloud/rapport.pdf'), false);
    });
});
