import fs from 'node:fs';
import { isEntryPoint } from './entry-point.mjs';
const isCommitSha = (s) => typeof s === 'string' && s.length === 40 && [...s].every((c) => '0123456789abcdef'.includes(c));
export function verifyRun(run, path) {
    if (run?.path !== path || run.head_branch !== 'main' || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success'
        || !isCommitSha(run.head_sha || '') || !Number.isInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('Release evidence must come from a successful trusted manual workflow on main');
    return run.head_sha;
}
async function main() {
    const [runId, workflowPath] = process.argv.slice(2);
    if (!/^[1-9][0-9]*$/.test(runId || '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.env.GITHUB_REPOSITORY || '')) throw new Error('Invalid workflow provenance request');
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`, { headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Cannot verify workflow provenance (${response.status})`);
    const run = await response.json();
    const commit = verifyRun(run, workflowPath);
    if (!Number.isInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('Invalid workflow attempt');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\nattempt=${run.run_attempt}\n`);
}
if (isEntryPoint(import.meta.url)) await main();
