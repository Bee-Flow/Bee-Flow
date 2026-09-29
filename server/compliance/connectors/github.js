/**
 * GitHub evidence connector — repository security posture for the org's
 * source repositories. Config-state depth only: counts, booleans and ages —
 * never code, alert bodies or contributor lists.
 *
 * Credential: an integration_connections row, provider 'github', kind
 * 'bearer' or 'api_key'. Both kinds store the PAT as { token } (the same
 * shape githubSyncService reads via configStore); `secret.apiKey` is read as
 * a defensive fallback. Token permissions needed (fine-grained PAT):
 *   - Metadata: read            — repo lookup + default branch
 *   - Dependabot alerts: read   — classic PAT: `security_events` scope
 *   - Administration: read      — branch protection + security_and_analysis
 *                                 (classic PAT: `repo` scope with admin on the repo)
 *   - Pull requests: read       — merge/review sample
 *   - Actions: read             — CI run conclusions
 * Missing permissions never fake evidence: the affected section records
 * { accessible: false } — and branch protection records { protected: false },
 * matching GitHub's own semantics (the protection endpoint answers 404 both
 * when the branch is unprotected and when the token lacks admin read).
 *
 * Per repo (subject_id 'owner/repo') the snapshot asserts:
 *   - open Dependabot alerts: counts by severity + age of the oldest ones
 *   - default-branch protection: required reviews, enforce_admins, force pushes
 *   - secret scanning + push protection status (security_and_analysis)
 *   - sample of the last 20 merged PRs into the default branch: how many had
 *     an approving review from someone else, how many were self-merged
 *   - conclusions of the last 20 completed Actions runs
 */

const GITHUB_API = 'https://api.github.com';
const MAX_REPOS = 10;
const PR_SAMPLE = 20;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

async function _gh(safeFetch, token, endpoint) {
    const res = await safeFetch(`${GITHUB_API}${endpoint}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'BeeFlow-ISO-Evidence',
        },
        signal: AbortSignal.timeout(30000),
    });
    if (res.status === 401) throw new Error('GitHub token invalid or expired');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        throw new Error('GitHub API rate limit exceeded — retry on the next sweep');
    }
    // 403/404 = no access / not found / feature disabled — the caller records
    // this honestly instead of failing the whole sweep.
    if (res.status === 403 || res.status === 404) return { ok: false, status: res.status, data: null };
    if (!res.ok) throw new Error(`GitHub API error ${res.status} on ${endpoint}`);
    return { ok: true, status: res.status, data: await res.json() };
}

function _ageDays(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

async function _dependabot(safeFetch, token, repo) {
    const res = await _gh(safeFetch, token, `/repos/${repo}/dependabot/alerts?state=open&per_page=100`);
    if (!res.ok) return { accessible: false, status: res.status };
    const alerts = Array.isArray(res.data) ? res.data : [];
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    let oldestDays = null;
    let oldestHighCritDays = null;
    for (const alert of alerts) {
        const sev = String(alert?.security_vulnerability?.severity || alert?.security_advisory?.severity || '').toLowerCase();
        if (bySeverity[sev] !== undefined) bySeverity[sev]++;
        const age = _ageDays(alert?.created_at);
        if (age === null) continue;
        if (oldestDays === null || age > oldestDays) oldestDays = age;
        if ((sev === 'critical' || sev === 'high') && (oldestHighCritDays === null || age > oldestHighCritDays)) {
            oldestHighCritDays = age;
        }
    }
    return {
        accessible: true,
        open_total: alerts.length,
        by_severity: bySeverity,
        oldest_open_days: oldestDays,
        oldest_high_critical_days: oldestHighCritDays,
        truncated: alerts.length === 100,
    };
}

async function _branchProtection(safeFetch, token, repo, branch) {
    const res = await _gh(safeFetch, token, `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`);
    if (!res.ok) return { branch, protected: false, status: res.status };
    const p = res.data || {};
    return {
        branch,
        protected: true,
        required_reviews: p.required_pull_request_reviews?.required_approving_review_count ?? 0,
        enforce_admins: p.enforce_admins?.enabled === true,
        allow_force_pushes: p.allow_force_pushes?.enabled === true,
    };
}

async function _mergedPrSample(safeFetch, token, repo, branch) {
    const res = await _gh(safeFetch, token,
        `/repos/${repo}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=50`);
    if (!res.ok) return { accessible: false, status: res.status, sampled: 0 };
    const merged = (Array.isArray(res.data) ? res.data : []).filter(p => p?.merged_at).slice(0, PR_SAMPLE);
    let approved = 0;
    let selfMerged = 0;
    let flagged = 0;
    const sampleNumbers = [];
    for (const pr of merged) {
        const author = pr.user?.login || null;
        // Sequential on purpose — gentle on the rate limit; this is a 6-hourly sweep.
        const reviews = await _gh(safeFetch, token, `/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`);
        const hasApproval = reviews.ok && (Array.isArray(reviews.data) ? reviews.data : []).some(r =>
            r?.state === 'APPROVED' && r?.user?.login && r.user.login !== author);
        // merged_by only appears on the single-PR resource, not the list.
        const detail = await _gh(safeFetch, token, `/repos/${repo}/pulls/${pr.number}`);
        const mergedBy = detail.ok ? (detail.data?.merged_by?.login || null) : null;
        const isSelfMerge = !!(mergedBy && author && mergedBy === author);
        if (hasApproval) approved++;
        if (isSelfMerge) selfMerged++;
        if (!hasApproval || isSelfMerge) flagged++;
        if (sampleNumbers.length < 5) sampleNumbers.push(pr.number);
    }
    return {
        accessible: true,
        sampled: merged.length,
        approved,
        self_merged: selfMerged,
        unapproved_or_self_merged: flagged,
        sample_numbers: sampleNumbers,
    };
}

async function _ciRuns(safeFetch, token, repo) {
    const res = await _gh(safeFetch, token, `/repos/${repo}/actions/runs?status=completed&per_page=20`);
    if (!res.ok) return { accessible: false, status: res.status };
    const runs = Array.isArray(res.data?.workflow_runs) ? res.data.workflow_runs : [];
    let success = 0;
    let failure = 0;
    let other = 0;
    for (const run of runs) {
        if (run?.conclusion === 'success') success++;
        else if (run?.conclusion === 'failure') failure++;
        else other++;
    }
    return { accessible: true, sampled: runs.length, success, failure, other };
}

module.exports = {
    id: 'github',
    titleKey: 'compliance.connector.github.title',
    descKey: 'compliance.connector.github.desc',
    coveredControls: ['A.8.4', 'A.8.8', 'A.8.28', 'A.8.29', 'A.8.31', 'A.8.32'],
    checks: [
        'ISO27001-A.8.8-vuln-mgmt',
        'ISO27001-A.8.4-source-protection',
        'ISO27001-A.8.28-secure-coding',
        'ISO27001-A.8.32-change-management',
    ],
    credential: { provider: 'github', kinds: ['bearer', 'api_key'] },
    settingsHint: 'repos: ["owner/repo"]',

    async collect({ secret, settings, safeFetch }) {
        const token = secret?.token || secret?.apiKey || secret?.api_key || null;
        if (!token) throw new Error('GitHub connection has no token');
        const repos = (Array.isArray(settings?.repos) ? settings.repos : [])
            .map(r => String(r).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, ''))
            .filter(r => REPO_RE.test(r))
            .slice(0, MAX_REPOS);
        if (!repos.length) return [];

        const out = [];
        for (const repo of repos) {
            const repoRes = await _gh(safeFetch, token, `/repos/${repo}`);
            if (!repoRes.ok) {
                out.push({ subject_id: repo, payload: { repo, accessible: false, status: repoRes.status } });
                continue;
            }
            const defaultBranch = repoRes.data?.default_branch || 'main';
            // security_and_analysis is only present when the token may see it —
            // absence is recorded as known: false, never guessed.
            const saa = repoRes.data?.security_and_analysis || null;
            out.push({
                subject_id: repo,
                payload: {
                    repo,
                    accessible: true,
                    default_branch: defaultBranch,
                    private: repoRes.data?.private === true,
                    dependabot: await _dependabot(safeFetch, token, repo),
                    branch_protection: await _branchProtection(safeFetch, token, repo, defaultBranch),
                    security_and_analysis: {
                        known: !!saa,
                        secret_scanning: saa?.secret_scanning?.status || null,
                        push_protection: saa?.secret_scanning_push_protection?.status || null,
                    },
                    merged_prs: await _mergedPrSample(safeFetch, token, repo, defaultBranch),
                    ci_runs: await _ciRuns(safeFetch, token, repo),
                },
            });
        }
        return out;
    },
};
