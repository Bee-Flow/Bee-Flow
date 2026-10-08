import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRun } from './release-workflow-evidence.mjs';
const path = '.github/workflows/build-push-ghcr.yml';
const good = { path, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40), run_attempt: 1 };
test('release evidence accepts only a completed successful manual main workflow', () => {
    assert.equal(verifyRun(good,path), good.head_sha);
    for (const patch of [{ path: 'another-workflow.yml' }, { head_branch: 'unreviewed' }, { event: 'pull_request' },
        { status: 'in_progress' }, { conclusion: 'failure' }, { head_sha: 'main' }, { run_attempt: 0 }]) {
        assert.throws(() => verifyRun({ ...good, ...patch }, path));
    }
});
