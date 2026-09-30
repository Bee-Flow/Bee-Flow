/**
 * The upgrade port held to its two sources (textual lockstep): the kinds an
 * upgrade can compare are the server's REPLACEABLE_KINDS and the web's
 * COMPARED_KINDS, and "newer" is the server's isNewer rule. The web client
 * imports React and its API layer, so both files are read as TEXT.
 *
 * Then the behaviour, on the fixtures the web's upgradeClient.test.jsx uses:
 * the scope check before a banner may promise anything, and the split of
 * `plan.skip` into "you changed it" and "never compared".
 */

import fs from 'node:fs';
import path from 'node:path';

import type { BlueprintMeta } from './package';
import { COMPARED_KINDS, isNewer, planRows, planTouchesNothing, readReport, updateAvailability } from './upgrade';

const REPO = path.resolve(__dirname, '../../../../..');
const WEB = fs.readFileSync(path.join(REPO, 'agent-hub/src/components/admin/Studio/Solutions/upgradeClient.jsx'), 'utf8');
const SERVER = fs.readFileSync(path.join(REPO, 'server/projects/packaging/upgrade.js'), 'utf8');

const setLiteral = (src: string, name: string): string[] => {
    const m = new RegExp(`${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(src);
    return m ? [...(m[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string).sort() : [];
};

describe('the upgrade port matches its sources', () => {
    it('compares exactly the kinds the server can replace, as the web does', () => {
        const ours = [...COMPARED_KINDS].sort();
        expect(setLiteral(SERVER, 'REPLACEABLE_KINDS')).toEqual(ours);
        expect(setLiteral(WEB, 'COMPARED_KINDS')).toEqual(ours);
    });

    it('uses the server rule for "newer": equal is not an upgrade', () => {
        expect(SERVER).toContain('Number.isInteger(blueprintVersion) && blueprintVersion > (installedVersion || 0)');
        expect(isNewer(2, 3)).toBe(true);
        expect(isNewer(3, 3)).toBe(false);
        expect(isNewer(null, 1)).toBe(true);
        expect(isNewer(1, 1.5)).toBe(false);
    });
});

const blueprint = (over: Partial<BlueprintMeta>): BlueprintMeta => ({
    id: 'bp1',
    name: 'Intake',
    description: '',
    icon: null,
    version: 3,
    solutionKey: 'sol_p0',
    createdBy: 'u1',
    sourceProjectId: 'p0',
    updatedAt: null,
    ...over,
});

describe('updateAvailability', () => {
    const base = { installedFromBlueprintId: 'bp1', installedVersion: 2, blueprints: [blueprint({})] };

    it('says nothing for a Solution built here', () => {
        expect(updateAvailability({ ...base, installedFromBlueprintId: null }).state).toBe('none');
    });

    it('is unknown — never available — when the gallery could not be read or does not list it', () => {
        expect(updateAvailability({ ...base, blueprints: null }).state).toBe('unknown');
        expect(updateAvailability({ ...base, blueprints: [blueprint({ id: 'other' })] }).state).toBe('unknown');
        expect(updateAvailability({ ...base, installedVersion: null }).state).toBe('unknown');
        expect(updateAvailability({ ...base, blueprints: [blueprint({ version: 0 })] }).blueprintId).toBeNull();
    });

    it('offers the newer version, and carries the id only once the scope passed', () => {
        expect(updateAvailability(base)).toEqual({ state: 'available', blueprintId: 'bp1', installedVersion: 2, latestVersion: 3 });
        expect(updateAvailability({ ...base, installedVersion: 3 }).state).toBe('current');
    });
});

describe('planRows', () => {
    const body = {
        ok: true,
        plan: {
            add: [{ ref: 'n1', kind: 'automation' }],
            replace: [{ ref: 'r1', kind: 'app' }],
            skip: [
                { ref: 'e1', kind: 'webpage', why: 'You edited this after installing it.' },
                { ref: 't1', kind: 'datatable', why: 'You edited this after installing it.' },
                { ref: 'e2', kind: 'agent', why: 'Could not be read.' },
            ],
            missing: [{ ref: 'g1', kind: 'automation' }],
        },
        manifest: {
            solution: {
                entities: {
                    automations: [{ ref: 'n1', title: 'New flow' }, { ref: 'g1', name: '  Gone  ' }],
                    apps: [{ ref: 'r1', name: 'Portal' }],
                    datatables: [{ ref: 't1', key: 'leads' }],
                },
            },
        },
    };

    it('names every row and claims "you changed it" only where both signals agree', () => {
        const rows = planRows(body);
        expect(rows.added).toEqual([{ ref: 'n1', kind: 'automation', name: 'New flow' }]);
        expect(rows.changed).toEqual([{ ref: 'r1', kind: 'app', name: 'Portal' }]);
        expect(rows.kept.map((r) => r.ref)).toEqual(['e1']);
        // A table is never compared, whatever `why` says; an agent that could not be read was not either.
        expect(rows.undetermined.map((r) => [r.ref, r.name])).toEqual([['t1', 'leads'], ['e2', 'e2']]);
        expect(rows.gone).toEqual([{ ref: 'g1', kind: 'automation', name: 'Gone' }]);
        expect(planTouchesNothing(rows)).toBe(false);
    });

    it('reads a body with no plan as a plan that touches nothing', () => {
        const rows = planRows(null);
        expect(rows).toEqual({ added: [], changed: [], kept: [], undetermined: [], gone: [] });
        expect(planTouchesNothing(rows)).toBe(true);
    });
});

describe('readReport', () => {
    it('keeps counts and the server sentences, nothing else', () => {
        expect(
            readReport({
                replaced: ['a', 'b'],
                added: { automations: [{}], apps: [{}, {}], note: 'x' },
                failed: [{ ref: 'r1', why: 'Locked', secret: 'x' }, 'junk'],
                warnings: ['Check the table.', '', 4],
            }),
        ).toEqual({ replaced: 2, added: 3, failed: [{ ref: 'r1', why: 'Locked' }], warnings: ['Check the table.'] });
        expect(readReport(undefined)).toEqual({ replaced: 0, added: 0, failed: [], warnings: [] });
    });
});
