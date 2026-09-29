/**
 * ISO 27001 A.8.32 — change management: does the review process actually
 * operate? Judged on the github connector's sample of the last merged PRs
 * into each default branch (counts only, never a PR mirror). A merge without
 * an approving review from someone else, or merged by its own author,
 * bypasses four-eyes: more than 30% of the sample failing → fail, any → warn.
 * CI run conclusions ride along as supporting evidence (A.8.29 testing).
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

const FAIL_RATIO = 0.30;

module.exports = {
    id: 'ISO27001-A.8.32-change-management',
    regulation: 'ISO27001',
    article: 'A.8.32',
    controls: ['A.8.32', 'A.8.29'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(e)' }, { regulation: 'CRA', ref: 'Annex I Part II(3)' }],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_change_mgmt.title',
    descriptionKey: 'compliance.checks.iso_change_mgmt.desc',
    remediationKey: 'compliance.checks.iso_change_mgmt.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const config = await isoEvidenceStore.getConfig(orgId, 'github').catch(() => null);
        if (!config?.enabled) {
            return {
                status: 'not_applicable',
                evidence: { connector: 'github', enabled: false },
                details: 'GitHub connector not enabled — link a token and list your repositories under ISO 27001 → Connectors.',
            };
        }
        const snaps = await isoEvidenceStore.listLatestSnapshots(orgId, 'github').catch(() => []);
        if (!snaps.length) {
            return {
                status: 'warn',
                evidence: { connector: 'github', enabled: true, snapshots: 0 },
                details: 'Connector enabled but no snapshot yet — run a sweep or check the configured repositories.',
            };
        }
        const repos = snaps.map(s => s.payload || {});
        let sampled = 0;
        let approved = 0;
        let selfMerged = 0;
        let flagged = 0;
        const ci = { sampled: 0, success: 0, failure: 0, other: 0 };
        const rows = [];
        for (const r of repos) {
            const mp = r.merged_prs || {};
            if (mp.accessible === true) {
                sampled += mp.sampled || 0;
                approved += mp.approved || 0;
                selfMerged += mp.self_merged || 0;
                flagged += mp.unapproved_or_self_merged || 0;
            }
            const runs = r.ci_runs || {};
            if (runs.accessible === true) {
                ci.sampled += runs.sampled || 0;
                ci.success += runs.success || 0;
                ci.failure += runs.failure || 0;
                ci.other += runs.other || 0;
            }
            rows.push({
                repo: r.repo,
                prs_sampled: mp.accessible === true ? (mp.sampled || 0) : null,
                unapproved_or_self_merged: mp.accessible === true ? (mp.unapproved_or_self_merged || 0) : null,
            });
        }
        const evidence = {
            repos: rows,
            merges_sampled: sampled,
            with_approval: approved,
            self_merged: selfMerged,
            unapproved_or_self_merged: flagged,
            ci_runs: ci,
            fetched_at: snaps[0].fetched_at,
        };

        if (sampled === 0) {
            return {
                status: 'warn',
                evidence,
                details: 'No merged pull requests could be sampled — either there are none yet or the token cannot read pull requests.',
            };
        }
        const ratio = flagged / sampled;
        evidence.flagged_ratio = Math.round(ratio * 100) / 100;
        if (ratio > FAIL_RATIO) {
            return {
                status: 'fail',
                evidence,
                details: `${flagged} of ${sampled} sampled merges (${Math.round(ratio * 100)}%) lacked an independent approval or were self-merged — the review process is not operating.`,
            };
        }
        if (flagged > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${flagged} of ${sampled} sampled merges (${Math.round(ratio * 100)}%) lacked an independent approval or were self-merged.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `All ${sampled} sampled merges had an independent approval and were not self-merged (CI: ${ci.success}/${ci.sampled} runs successful).`,
        };
    },
};
