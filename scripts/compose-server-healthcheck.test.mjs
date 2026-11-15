import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The server image carries neither wget nor curl (scripts/check-release-container.sh
// fails the release if either is back), so a compose healthcheck for /api/health
// or /api/ready that calls one of them leaves the container "unhealthy" for good
// after an upgrade. Use Node's own fetch, like the image's HEALTHCHECK.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const composeFiles = readdirSync(root).filter(f => /^docker-compose.*\.yml$/.test(f));
const read = (file) => readFileSync(join(root, file), 'utf8').split('\n').map((text, i) => ({ text, line: i + 1 }));
const isComment = (text) => /^\s*#/.test(text);

test('there are compose files to check', () => {
    assert.ok(composeFiles.length > 0);
});

for (const file of composeFiles) {
    test(`${file}: the server healthcheck needs no wget or curl`, () => {
        const offenders = read(file)
            .filter(({ text }) => /\/api\/(health|ready)/.test(text) && /\b(wget|curl)\b/.test(text) && !isComment(text));
        assert.deepEqual(offenders, [], `${file} uses wget/curl on the server's probe`);
    });
}

// The stacks that run the server image probe readiness (/api/ready: 503 until the
// schema and boot migrations have run, and during shutdown), not liveness.
for (const file of ['docker-compose.yml', 'docker-compose.from-registry.yml']) {
    test(`${file}: the server healthcheck asks /api/ready through node`, () => {
        const probes = read(file).filter(({ text }) => /\/api\/(health|ready)\b/.test(text) && !isComment(text));
        assert.equal(probes.length, 1, 'one server probe');
        assert.match(probes[0].text, /"CMD", "node", "-e", "fetch\('http:\/\/localhost:\$\{SERVER_PORT:-3001\}\/api\/ready'/);
    });
}
