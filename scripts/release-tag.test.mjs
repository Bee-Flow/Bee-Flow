/**
 * scripts/release-tag.sh: when the synced downstream checkout is missing, the
 * error is the operator's only instruction, so it has to name the real
 * precondition (the downstream-repo sync filling $SYNC_ROOT), not a script
 * that is not in the repository.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasBash = process.platform !== 'win32' && !spawnSync('bash', ['-c', 'exit 0']).error;
const skip = hasBash ? false : 'bash is not available';

test('a missing synced checkout names $SYNC_ROOT and the sync, and exits 1', { skip }, (t) => {
    const syncRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tag-'));
    t.after(() => fs.rmSync(syncRoot, { recursive: true, force: true }));
    const res = spawnSync('bash', [path.join(REPO, 'scripts/release-tag.sh'), 'connector', '--dry-run'], {
        encoding: 'utf8',
        env: { ...process.env, SYNC_ROOT: syncRoot },
    });
    assert.strictEqual(res.status, 1);
    // A plain substring check: the temp path is not a regex and may hold its metacharacters.
    assert.ok(res.stderr.includes(`connector repo not found at ${syncRoot}/connector`), res.stderr);
    assert.match(res.stderr, /downstream-repo sync/);
    assert.match(res.stderr, /SYNC_ROOT defaults to \/tmp\/bee-flow-sync/);
    assert.doesNotMatch(res.stderr, /deploy-all/);
});
