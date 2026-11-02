import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Images that need no root at run time declare an unprivileged USER in their
// final stage. scripts/check-release-container.sh checks the built image; this
// catches a Dockerfile change before any image is built.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The instructions of the last stage, as [keyword, rest] pairs. */
function finalStage(relPath) {
    const instructions = readFileSync(join(root, relPath), 'utf8')
        .replace(/\\\n/g, ' ')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => { const m = /^(\w+)\s+(.*)$/.exec(l); return m ? [m[1].toUpperCase(), m[2]] : [l.toUpperCase(), '']; });
    const lastFrom = instructions.map(([k]) => k).lastIndexOf('FROM');
    return instructions.slice(lastFrom);
}

/** The user the final stage runs as ('root' when it never sets one). */
function runtimeUser(relPath) {
    const users = finalStage(relPath).filter(([k]) => k === 'USER').map(([, v]) => v.trim());
    return users.at(-1) ?? 'root';
}

test('the Playwright runner image runs as pwuser', () => {
    assert.equal(runtimeUser('server/pwt-runner/Dockerfile'), 'pwuser');
});

test('the connector image ships su-exec for harp-start.sh to drop root', () => {
    const runs = finalStage('nextcloud-connector/Dockerfile').filter(([k]) => k === 'RUN').map(([, v]) => v);
    assert.ok(runs.some(r => /apk add\b.*\bsu-exec\b/.test(r)), 'no apk add ... su-exec in the runtime stage');
});
