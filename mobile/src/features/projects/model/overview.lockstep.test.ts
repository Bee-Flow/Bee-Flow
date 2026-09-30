/**
 * The overview model held to the web's (differential): the web's
 * admin/Studio/Solutions/solutionOverviewModel.js and this port run on the
 * same rows and must answer the same states. When this fails, the web side
 * changed — update overview.ts, do not loosen the test.
 */

import path from 'node:path';

import { chipsOf, healthOf, partitionSolutions, runsOf, tabOf, updateOf } from './overview';
import type { SolutionRow } from './solution';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require(path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/Solutions/solutionOverviewModel.js'));

function row(over: Partial<SolutionRow>): SolutionRow {
    return {
        id: 'p1',
        name: 'Intake',
        description: '',
        icon: null,
        permission: 'owner',
        installedFromBlueprintId: null,
        updatedAt: null,
        counts: {},
        runs: null,
        completeness: null,
        update: null,
        ...over,
    };
}

const CHECKS = { blocked: false, complete: true, findings: 0, errors: 0, warnings: 0 };

const ROWS: SolutionRow[] = [
    row({}),
    row({ id: 'a', installedFromBlueprintId: 'bp1', update: { installedVersion: 2, latestVersion: 3, available: true } }),
    row({ id: 'b', installedFromBlueprintId: 'bp1', update: { installedVersion: 3, latestVersion: 3, available: false } }),
    row({ id: 'c', installedFromBlueprintId: 'bp1', update: { installedVersion: null, latestVersion: null, available: null } }),
    row({ id: 'd', completeness: CHECKS }),
    row({ id: 'e', completeness: { ...CHECKS, complete: false, errors: 2, findings: 2 } }),
    row({ id: 'f', completeness: { ...CHECKS, errors: 2, findings: 3, warnings: 1 } }),
    row({ id: 'g', completeness: { ...CHECKS, warnings: 4, findings: 4 } }),
    row({ id: 'h', completeness: { ...CHECKS, findings: 1 } }),
    row({ id: 'i', runs: { today: 0, failed: 0 } }),
    row({ id: 'j', runs: { today: 5, failed: 0 } }),
    row({ id: 'k', runs: { today: 5, failed: 2 } }),
    row({ id: 'l', runs: { today: null, failed: 0 } }),
    row({ id: 'm', counts: { automations: 3, apps: 0, webpages: null, datatables: 1, agents: 2, knowledgeBases: 1, notebooks: 0 } }),
    row({ id: 'n', counts: { apps: 2 } }),
];

describe('the overview model matches the web on the same rows', () => {
    it.each(ROWS.map((r) => [r.id, r] as const))('row %s', (_id, r) => {
        expect(tabOf(r)).toBe(web.tabOf(r));
        expect(healthOf(r)).toEqual(web.healthOf(r));
        expect(runsOf(r)).toEqual(web.runsOf(r));
        expect(chipsOf(r)).toEqual(web.chipsOf(r));
        expect(updateOf(r)).toEqual(web.updateOf(r));
    });

    it('partitions every row into exactly one tab, as the web does', () => {
        const ours = partitionSolutions(ROWS);
        const theirs = web.partitionSolutions(ROWS);
        expect(ours.ours.map((r) => r.id)).toEqual(theirs.ours.map((r: SolutionRow) => r.id));
        expect(ours.installed.map((r) => r.id)).toEqual(theirs.installed.map((r: SolutionRow) => r.id));
        expect(ours.ours.length + ours.installed.length).toBe(ROWS.length);
    });
});
