import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The server image carries neither wget nor curl (scripts/check-release-container.sh
// fails the release if either is back), so a compose healthcheck for /api/health
// that calls one of them leaves the container "unhealthy" for good after an
// upgrade. Use Node's own fetch, like the image's HEALTHCHECK.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const composeFiles = readdirSync(root).filter(f => /^docker-compose.*\.yml$/.test(f));

test('there are compose files to check', () => {
    assert.ok(composeFiles.length > 0);
});

for (const file of composeFiles) {
    test(`${file}: the server healthcheck needs no wget or curl`, () => {
        const offenders = readFileSync(join(root, file), 'utf8').split('\n')
            .map((text, i) => ({ text, line: i + 1 }))
            .filter(({ text }) => /\/api\/health/.test(text) && /\b(wget|curl)\b/.test(text) && !/^\s*#/.test(text));
        assert.deepEqual(offenders, [], `${file} uses wget/curl on /api/health`);
    });
}
