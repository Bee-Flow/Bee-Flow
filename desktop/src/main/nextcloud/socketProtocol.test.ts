import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatCommand, LineBuffer, normaliseSyncState, parseLine } from './socketProtocol.ts';
import { isNamedPipe, socketCandidates } from './socketPath.ts';

describe('parseLine', () => {
    it('splits a command from its argument', () => {
        assert.deepEqual(parseLine('REGISTER_PATH:/home/tom/Nextcloud'), {
            command: 'REGISTER_PATH',
            args: ['/home/tom/Nextcloud'],
            rest: '/home/tom/Nextcloud',
        });
    });

    it('does not truncate a path that contains a colon', () => {
        const message = parseLine('STATUS:OK:/home/tom/Nextcloud/notes: draft/a.txt');
        assert.deepEqual(message?.args, ['OK', '/home/tom/Nextcloud/notes: draft/a.txt']);
    });

    it('keeps a menu item title intact', () => {
        const message = parseLine('MENU_ITEM:SHARE:d:Share with Nextcloud: options');
        assert.deepEqual(message?.args, ['SHARE', 'd', 'Share with Nextcloud: options']);
    });

    it('reads a version reply', () => {
        assert.deepEqual(parseLine('VERSION:3.18.2:1.1')?.args, ['3.18.2', '1.1']);
    });

    it('handles a command with no argument', () => {
        assert.deepEqual(parseLine('GET_STRINGS'), { command: 'GET_STRINGS', args: [], rest: '' });
        assert.deepEqual(parseLine('SHARE_MENU_TITLE:')?.args, ['']);
    });

    it('ignores a blank line', () => {
        assert.equal(parseLine(''), null);
        assert.equal(parseLine('   \r\n'), null);
    });
});

describe('LineBuffer', () => {
    it('joins a message split across two reads', () => {
        const buffer = new LineBuffer();
        assert.deepEqual(buffer.push('STATUS:OK:/home/tom/Next'), []);
        const messages = buffer.push('cloud/a.txt\n');
        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0]?.args, ['OK', '/home/tom/Nextcloud/a.txt']);
    });

    it('splits several messages that arrived in one read', () => {
        const messages = new LineBuffer().push('VERSION:3.18.2:1.1\nSTATUS:SYNC:/a\nSTATUS:OK:/b\n');
        assert.deepEqual(messages.map((m) => m.command), ['VERSION', 'STATUS', 'STATUS']);
    });

    it('tolerates CRLF', () => {
        const messages = new LineBuffer().push('STATUS:OK:/a\r\n');
        assert.deepEqual(messages[0]?.args, ['OK', '/a']);
    });

    it('does not grow without bound on a line that never ends', () => {
        const buffer = new LineBuffer();
        buffer.push('X'.repeat(100_000));
        assert.deepEqual(buffer.push('STATUS:OK:/a\n').map((m) => m.command), ['STATUS']);
    });
});

describe('formatCommand', () => {
    it('always terminates with a newline', () => {
        assert.equal(formatCommand('RETRIEVE_FILE_STATUS', '/home/tom/a.txt'), 'RETRIEVE_FILE_STATUS:/home/tom/a.txt\n');
        assert.equal(formatCommand('GET_STRINGS'), 'GET_STRINGS:\n');
    });
});

describe('normaliseSyncState', () => {
    it('maps the client vocabulary onto ours', () => {
        assert.equal(normaliseSyncState('OK'), 'OK');
        assert.equal(normaliseSyncState('ok'), 'OK');
        assert.equal(normaliseSyncState('SYNC'), 'SYNC');
        assert.equal(normaliseSyncState('NONE'), 'NOP');
    });

    it('drops the suffix the client adds for shared items', () => {
        assert.equal(normaliseSyncState('OK+SWM'), 'OK');
    });

    it('says UNKNOWN rather than inventing a state', () => {
        assert.equal(normaliseSyncState('SOMETHING_NEW_IN_3_20'), 'UNKNOWN');
        assert.equal(normaliseSyncState(''), 'UNKNOWN');
    });
});

describe('socketCandidates', () => {
    it('starts from the XDG runtime directory on Linux', () => {
        const paths = socketCandidates({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux', '/home/tom');
        assert.equal(paths[0], '/run/user/1000/Nextcloud/socket');
        assert.ok(paths.some((p) => p.includes('com.nextcloud.desktopclient.nextcloud')), 'flatpak');
        assert.ok(paths.some((p) => p.includes('snap/nextcloud-desktop-client')), 'snap');
    });

    it('falls back the way Qt does when there is no runtime directory', () => {
        const paths = socketCandidates({ USER: 'tom' }, 'linux', '/home/tom');
        assert.ok(paths.includes('/tmp/runtime-tom/Nextcloud/socket'));
    });

    it('offers named pipes on Windows', () => {
        const paths = socketCandidates({ USERNAME: 'tom' }, 'win32', 'C:/Users/tom');
        assert.ok(paths.every(isNamedPipe), 'every Windows candidate is a pipe');
        assert.ok(paths.includes('\\\\.\\pipe\\Nextcloud-tom'));
    });

    it('uses TMPDIR on macOS, where Qt puts the runtime directory', () => {
        const paths = socketCandidates({ TMPDIR: '/var/folders/ab/T/' }, 'darwin', '/Users/tom');
        assert.equal(paths[0], '/var/folders/ab/T/Nextcloud/socket');
    });

    it('lists every candidate once', () => {
        const paths = socketCandidates({ XDG_RUNTIME_DIR: '/run/user/1000', USER: 'tom' }, 'linux', '/home/tom');
        assert.equal(new Set(paths).size, paths.length);
    });
});

describe('isNamedPipe', () => {
    it('tells a pipe from a socket file', () => {
        assert.equal(isNamedPipe('\\\\.\\pipe\\Nextcloud'), true);
        assert.equal(isNamedPipe('/run/user/1000/Nextcloud/socket'), false);
    });
});
