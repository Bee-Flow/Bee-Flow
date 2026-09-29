import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NextcloudSocketApi, type SocketLike } from './socketApi.ts';

/** A socket that records what was written and lets a test push replies back. */
class FakeSocket implements SocketLike {
    written: string[] = [];
    destroyed = false;
    private listeners = new Map<string, ((...args: never[]) => void)[]>();
    /** When set, the socket accepts the connection and never answers. */
    silent: boolean;

    constructor(options: { silent?: boolean } = {}) {
        this.silent = options.silent ?? false;
    }

    write(data: string): boolean {
        this.written.push(data);
        if (!this.silent && data.startsWith('VERSION:')) {
            queueMicrotask(() => this.emit('data', 'VERSION:3.18.2:1.1\n'));
        }
        return true;
    }

    destroy(): void {
        this.destroyed = true;
    }

    on(event: string, listener: (...args: never[]) => void): this {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
        return this;
    }

    emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) {
            (listener as (...a: unknown[]) => void)(...args);
        }
    }
}

describe('NextcloudSocketApi.connectAny', () => {
    it('keeps the first candidate that greets back', async () => {
        const good = new FakeSocket();
        const api = new NextcloudSocketApi({
            connect: async (path) => {
                if (path === '/run/user/1000/Nextcloud/socket') throw new Error('ENOENT');
                return good;
            },
        });

        const connected = await api.connectAny(['/run/user/1000/Nextcloud/socket', '/tmp/runtime-tom/Nextcloud/socket']);

        assert.equal(connected, true);
        assert.equal(api.socketPath, '/tmp/runtime-tom/Nextcloud/socket');
        assert.equal(api.clientVersion, '3.18.2');
    });

    it('rejects a socket that accepts the connection and then says nothing', async () => {
        const stale = new FakeSocket({ silent: true });
        const api = new NextcloudSocketApi({ connect: async () => stale, timeoutMs: 20 });

        assert.equal(await api.connectAny(['/tmp/stale/socket']), false);
        assert.equal(stale.destroyed, true, 'and it is closed rather than left open');
        assert.equal(api.connected, false);
    });

    it('returns false, not an error, when no candidate exists', async () => {
        const api = new NextcloudSocketApi({
            connect: async () => {
                throw new Error('ENOENT: no such file or directory');
            },
        });
        assert.equal(await api.connectAny(['/a', '/b', '/c']), false);
    });
});

describe('NextcloudSocketApi.registerPaths', () => {
    it('registers each folder once', async () => {
        const socket = new FakeSocket();
        const api = new NextcloudSocketApi({ connect: async () => socket });
        await api.connectAny(['/s']);

        api.registerPaths(['/home/tom/Nextcloud', '/home/tom/Klant']);
        api.registerPaths(['/home/tom/Nextcloud']);

        const registrations = socket.written.filter((line) => line.startsWith('REGISTER_PATH:'));
        assert.deepEqual(registrations, ['REGISTER_PATH:/home/tom/Nextcloud\n', 'REGISTER_PATH:/home/tom/Klant\n']);
    });
});

describe('NextcloudSocketApi.fileStatus', () => {
    it('matches the reply to the path that was asked about', async () => {
        const socket = new FakeSocket();
        const api = new NextcloudSocketApi({ connect: async () => socket });
        await api.connectAny(['/s']);

        const pending = api.fileStatus('/home/tom/Nextcloud/a.txt');
        // An unrelated push arrives first; it must not resolve our query.
        socket.emit('data', 'STATUS:SYNC:/home/tom/Nextcloud/b.txt\n');
        socket.emit('data', 'STATUS:OK:/home/tom/Nextcloud/a.txt\n');

        assert.equal(await pending, 'OK');
    });

    it('gives up quietly when the client does not answer', async () => {
        const socket = new FakeSocket();
        const api = new NextcloudSocketApi({ connect: async () => socket, timeoutMs: 20 });
        await api.connectAny(['/s']);
        assert.equal(await api.fileStatus('/home/tom/Nextcloud/a.txt'), 'UNKNOWN');
    });

    it('answers UNKNOWN without a connection instead of throwing', async () => {
        const api = new NextcloudSocketApi({
            connect: async () => {
                throw new Error('nope');
            },
        });
        assert.equal(await api.fileStatus('/whatever'), 'UNKNOWN');
    });

    it('forwards unsolicited status pushes to the listener', async () => {
        const socket = new FakeSocket();
        const seen: Array<[string, string]> = [];
        const api = new NextcloudSocketApi({
            connect: async () => socket,
            onStatus: (path, state) => seen.push([path, state]),
        });
        await api.connectAny(['/s']);

        socket.emit('data', 'STATUS:SYNC:/home/tom/Nextcloud/big.iso\n');
        socket.emit('data', 'STATUS:OK:/home/tom/Nextcloud/big.iso\n');

        assert.deepEqual(seen, [
            ['/home/tom/Nextcloud/big.iso', 'SYNC'],
            ['/home/tom/Nextcloud/big.iso', 'OK'],
        ]);
    });
});

describe('NextcloudSocketApi — the client going away', () => {
    it('reports the disconnect and resolves everything waiting', async () => {
        const socket = new FakeSocket();
        let disconnects = 0;
        const api = new NextcloudSocketApi({ connect: async () => socket, onDisconnect: () => (disconnects += 1) });
        await api.connectAny(['/s']);

        const pending = api.fileStatus('/home/tom/Nextcloud/a.txt');
        socket.emit('close');

        assert.equal(await pending, 'UNKNOWN', 'no promise is left hanging');
        assert.equal(disconnects, 1);
        assert.equal(api.connected, false);
    });

    it('re-registers folders after reconnecting', async () => {
        const first = new FakeSocket();
        const second = new FakeSocket();
        let nth = 0;
        const api = new NextcloudSocketApi({ connect: async () => (nth++ === 0 ? first : second) });

        await api.connectAny(['/s']);
        api.registerPaths(['/home/tom/Nextcloud']);
        first.emit('close');

        await api.connectAny(['/s']);
        api.registerPaths(['/home/tom/Nextcloud']);

        assert.deepEqual(
            second.written.filter((line) => line.startsWith('REGISTER_PATH:')),
            ['REGISTER_PATH:/home/tom/Nextcloud\n'],
            'the registration is not remembered across a reconnect',
        );
    });

    it('turns a write failure into a disconnect rather than a crash', async () => {
        const socket = new FakeSocket();
        const api = new NextcloudSocketApi({ connect: async () => socket });
        await api.connectAny(['/s']);

        socket.write = () => {
            throw new Error('EPIPE: broken pipe');
        };
        assert.equal(api.share('/home/tom/Nextcloud/a.txt'), false);
        assert.equal(api.connected, false);
    });
});

describe('NextcloudSocketApi — fire-and-forget commands', () => {
    it('asks the client to open its own share dialog', async () => {
        const socket = new FakeSocket();
        const api = new NextcloudSocketApi({ connect: async () => socket });
        await api.connectAny(['/s']);

        assert.equal(api.share('/home/tom/Nextcloud/a.txt'), true);
        assert.equal(api.copyPrivateLink('/home/tom/Nextcloud/a.txt'), true);
        assert.ok(socket.written.includes('SHARE:/home/tom/Nextcloud/a.txt\n'));
        assert.ok(socket.written.includes('COPY_PRIVATE_LINK:/home/tom/Nextcloud/a.txt\n'));
    });

    it('reports false when there is nothing to write to', () => {
        const api = new NextcloudSocketApi({ connect: async () => new FakeSocket() });
        assert.equal(api.share('/home/tom/Nextcloud/a.txt'), false);
    });
});
