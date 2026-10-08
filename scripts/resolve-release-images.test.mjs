import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const script = path.resolve('e2e/ci/resolve-images.sh');
function resolve(candidate, built = 'server,agent-hub') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'bee-flow-release-images-'));
    const calls = path.join(directory,'calls');
    fs.writeFileSync(path.join(directory,'docker'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_CALLS"\n',{ mode: 0o755 });
    try {
        const result = spawnSync('bash',[script], { cwd: directory, encoding: 'utf8', env: { ...process.env,
            PATH: `${directory}:${process.env.PATH}`, DOCKER_CALLS: calls, BUILT: built, SHA: 'a'.repeat(40), CANDIDATE_DIGESTS: JSON.stringify(candidate) } });
        return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls,'utf8') : '' };
    } finally { fs.rmSync(directory,{ recursive: true,force: true }); }
}
test('the blocking smoke suite boots the newly built immutable digests before any SHA tag', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const result = resolve({ server: { outputs: { digest } }, 'agent-hub': { outputs: { digest } } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls,new RegExp(`pull ghcr.io/bee-flow/server@${digest}`));
    assert.match(result.calls,new RegExp(`pull ghcr.io/bee-flow/agent-hub@${digest}`));
    assert.doesNotMatch(result.calls,/:sha-/);
});
test('missing or mutable candidate outputs cannot fall back to a previous production image', () => {
    for (const candidate of [{}, { server: { outputs: { digest: 'prod' } } }]) assert.notEqual(resolve(candidate).status, 0);
});
test('the browser service boots the pwt-runner this run built, not a :prod fallback', () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const result = resolve({ 'pwt-runner': { outputs: { digest } } }, 'pwt-runner');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls,new RegExp(`pull ghcr.io/bee-flow/pwt-runner@${digest}`));
    assert.match(result.calls,/tag \S+ ghcr\.io\/bee-flow\/pwt-runner:smoke/);
});
