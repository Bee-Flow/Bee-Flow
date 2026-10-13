import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { revealDecision, type RevealContext } from './reveal.ts';

const home = path.resolve('/home/ada');
const sync = path.join(home, 'Nextcloud');
const downloads = path.join(home, 'Downloads');
const logFile = path.join(home, '.config', 'Bee Flow', 'logs', 'main.log');
const settingsFile = path.join(home, '.config', 'Bee Flow', 'settings.json');

const context: RevealContext = {
    ownFiles: [logFile, settingsFile],
    isInsideSyncFolder: (resolved) => resolved.startsWith(sync + path.sep),
    downloads,
};

describe('revealDecision', () => {
    it('reveals a file in a sync folder or in Downloads', () => {
        assert.deepEqual(revealDecision(path.join(sync, 'report.pdf'), context), { ok: true, path: path.join(sync, 'report.pdf') });
        assert.deepEqual(revealDecision(path.join(downloads, 'a.zip'), context), { ok: true, path: path.join(downloads, 'a.zip') });
    });

    it('resolves the path before deciding, so .. cannot climb out', () => {
        const sneaky = `${sync}${path.sep}..${path.sep}.ssh${path.sep}id_ed25519`;
        assert.deepEqual(revealDecision(sneaky, context), { ok: false, refused: path.join(home, '.ssh', 'id_ed25519') });
    });

    it('refuses anything that is not an absolute local path, naming what it got', () => {
        assert.deepEqual(revealDecision('', context), { ok: false, refused: 'an empty path' });
        assert.deepEqual(revealDecision(42, context), { ok: false, refused: 'an empty path' });
        assert.deepEqual(revealDecision('relative/file.txt', context), { ok: false, refused: 'relative/file.txt' });
        assert.deepEqual(revealDecision('//host/share/x.exe', context), { ok: false, refused: '//host/share/x.exe' });
        assert.deepEqual(revealDecision('\\\\host\\share\\x.exe', context), { ok: false, refused: '\\\\host\\share\\x.exe' });
    });

    it('refuses a path elsewhere by its resolved form', () => {
        assert.deepEqual(revealDecision(path.join(home, '.ssh'), context), { ok: false, refused: path.join(home, '.ssh') });
    });

    it('reveals the app’s own files only when asked for them', () => {
        assert.deepEqual(revealDecision(logFile, context), { ok: false, refused: logFile });
        assert.deepEqual(revealDecision(logFile, context, { ownFiles: true }), { ok: true, path: logFile });
        assert.deepEqual(revealDecision(settingsFile, context, { ownFiles: true }), { ok: true, path: settingsFile });
    });
});
