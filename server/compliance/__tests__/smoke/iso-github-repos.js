/**
 * Smoke scenarios — ISO 27001 checks fed by the GitHub connector:
 * A.8.8 dependency vulnerabilities, A.8.4 branch protection, A.8.28 secret
 * scanning and A.8.32 change management on merges.
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');
const log = require('../../../telemetry/log');

module.exports = async function isoGithubRepos() {
    log.info('\n▶ ISO 27001 A.8.8 — Dependency vulnerabilities (GitHub)');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoGithubVuln.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when enabled but never swept', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        assertStatus(await checks.isoGithubVuln.evaluate('x'), 'warn', 'no snapshot yet');
    });
    await t('fail on a critical alert older than 30 days', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                dependabot: { accessible: true, open_total: 2, by_severity: { critical: 1, high: 1, medium: 0, low: 0 }, oldest_open_days: 45, oldest_high_critical_days: 45 },
            },
        }];
        assertStatus(await checks.isoGithubVuln.evaluate('x'), 'fail', 'stale critical');
    });
    await t('fail when Dependabot alerts are unreadable on every repo', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: { repo: 'acme/api', accessible: true, dependabot: { accessible: false, status: 403 } },
        }];
        assertStatus(await checks.isoGithubVuln.evaluate('x'), 'fail', 'vulns invisible');
    });
    await t('warn on a fresh high-severity alert', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                dependabot: { accessible: true, open_total: 1, by_severity: { critical: 0, high: 1, medium: 0, low: 0 }, oldest_open_days: 3, oldest_high_critical_days: 3 },
            },
        }];
        assertStatus(await checks.isoGithubVuln.evaluate('x'), 'warn', 'fresh high');
    });
    await t('warn on a medium/low backlog over 20', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                dependabot: { accessible: true, open_total: 24, by_severity: { critical: 0, high: 0, medium: 18, low: 6 }, oldest_open_days: 60, oldest_high_critical_days: null },
            },
        }];
        assertStatus(await checks.isoGithubVuln.evaluate('x'), 'warn', 'backlog 24 > 20');
    });
    await t('pass with no open critical/high alerts', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                dependabot: { accessible: true, open_total: 2, by_severity: { critical: 0, high: 0, medium: 1, low: 1 }, oldest_open_days: 10, oldest_high_critical_days: null },
            },
        }];
        assertStatus(await checks.isoGithubVuln.evaluate('x'), 'pass', 'clean');
    });

    log.info('\n▶ ISO 27001 A.8.4 — Source code branch protection');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoSourceProtection.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('fail when a default branch is unprotected', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true, default_branch: 'main',
                branch_protection: { branch: 'main', protected: false, status: 404 },
            },
        }];
        assertStatus(await checks.isoSourceProtection.evaluate('x'), 'fail', 'unprotected main');
    });
    await t('warn when protection requires no reviews', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true, default_branch: 'main',
                branch_protection: { branch: 'main', protected: true, required_reviews: 0, enforce_admins: true, allow_force_pushes: false },
            },
        }];
        assertStatus(await checks.isoSourceProtection.evaluate('x'), 'warn', 'no required reviews');
    });
    await t('warn when force pushes are allowed', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true, default_branch: 'main',
                branch_protection: { branch: 'main', protected: true, required_reviews: 2, enforce_admins: true, allow_force_pushes: true },
            },
        }];
        assertStatus(await checks.isoSourceProtection.evaluate('x'), 'warn', 'force pushes allowed');
    });
    await t('pass with reviews required and no force pushes', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true, default_branch: 'main',
                branch_protection: { branch: 'main', protected: true, required_reviews: 1, enforce_admins: true, allow_force_pushes: false },
            },
        }];
        assertStatus(await checks.isoSourceProtection.evaluate('x'), 'pass', 'solid protection');
    });

    log.info('\n▶ ISO 27001 A.8.28 — Secret scanning in repositories');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoSecureCoding.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when the status is invisible to the token', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                security_and_analysis: { known: false, secret_scanning: null, push_protection: null },
            },
        }];
        assertStatus(await checks.isoSecureCoding.evaluate('x'), 'warn', 'status unknown');
    });
    await t('warn when push protection is off', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                security_and_analysis: { known: true, secret_scanning: 'enabled', push_protection: 'disabled' },
            },
        }];
        assertStatus(await checks.isoSecureCoding.evaluate('x'), 'warn', 'push protection off');
    });
    await t('pass when both features are enabled on all repos', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [
            {
                fetched_at: new Date().toISOString(),
                payload: {
                    repo: 'acme/api', accessible: true,
                    security_and_analysis: { known: true, secret_scanning: 'enabled', push_protection: 'enabled' },
                },
            },
            {
                fetched_at: new Date().toISOString(),
                payload: {
                    repo: 'acme/web', accessible: true,
                    security_and_analysis: { known: true, secret_scanning: 'enabled', push_protection: 'enabled' },
                },
            },
        ];
        assertStatus(await checks.isoSecureCoding.evaluate('x'), 'pass', 'both on everywhere');
    });

    log.info('\n▶ ISO 27001 A.8.32 — Change management on merges');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoChangeMgmt.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when no merges could be sampled', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                merged_prs: { accessible: false, status: 403, sampled: 0 },
                ci_runs: { accessible: true, sampled: 20, success: 20, failure: 0, other: 0 },
            },
        }];
        assertStatus(await checks.isoChangeMgmt.evaluate('x'), 'warn', 'empty sample');
    });
    await t('fail when over 30% of merges bypass review', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                merged_prs: { accessible: true, sampled: 20, approved: 10, self_merged: 8, unapproved_or_self_merged: 10, sample_numbers: [101, 100, 99, 98, 97] },
                ci_runs: { accessible: true, sampled: 20, success: 15, failure: 5, other: 0 },
            },
        }];
        assertStatus(await checks.isoChangeMgmt.evaluate('x'), 'fail', '50% flagged');
    });
    await t('warn when a few merges bypass review', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                merged_prs: { accessible: true, sampled: 20, approved: 18, self_merged: 1, unapproved_or_self_merged: 2, sample_numbers: [101, 100, 99, 98, 97] },
                ci_runs: { accessible: true, sampled: 20, success: 19, failure: 1, other: 0 },
            },
        }];
        assertStatus(await checks.isoChangeMgmt.evaluate('x'), 'warn', '10% flagged');
    });
    await t('pass when every sampled merge was reviewed by someone else', async () => {
        resetState();
        _state.isoConnectorConfigs['github'] = { enabled: true };
        _state.isoSnapshots['github'] = [{
            fetched_at: new Date().toISOString(),
            payload: {
                repo: 'acme/api', accessible: true,
                merged_prs: { accessible: true, sampled: 20, approved: 20, self_merged: 0, unapproved_or_self_merged: 0, sample_numbers: [101, 100, 99, 98, 97] },
                ci_runs: { accessible: true, sampled: 20, success: 20, failure: 0, other: 0 },
            },
        }];
        assertStatus(await checks.isoChangeMgmt.evaluate('x'), 'pass', 'clean sample');
    });
    // ═══ end ISO 27001 GitHub connector fragment ════════════════════════════
};
