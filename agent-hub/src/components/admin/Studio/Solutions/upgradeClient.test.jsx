import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

import UpgradeDialog, {
    PlanBody, UpdateBanner, fetchUpgradePlan, isNewer, nameIndex,
    planRows, planTouchesNothing, readReport, runUpgrade, updateAvailability,
} from './upgradeClient';

/**
 * The upgrade client: the banner, the plan, and the confirmation.
 *
 * Three things are pinned here, and all three are a promise that this screen may
 * not break:
 *
 *   1. THE PLAN SAYS WHAT HAPPENS TO YOUR CHANGES — and where that cannot be
 *      established, it says so. A table that “stays” without more would claim that
 *      it was checked; that is exactly what did NOT happen, because the upgrade never
 *      compares tables and knowledge bases.
 *   2. THE BANNER PROMISES NOTHING OUTSIDE THE SCOPE. The Blueprint must be in the
 *      org-scoped gallery list before a version number appears on the screen.
 *   3. THE CLIENT SENDS THE ID, NEVER THE MANIFEST. Only then does a `canRead` run
 *      over it on the server side.
 */

const MANIFEST = {
    solution: {
        version: 4,
        entities: {
            automations: [{ ref: 'aut_1', title: 'Nightly invoices' }],
            apps: [{ ref: 'app_1', name: 'Desk' }],
            webpages: [],
            datatables: [{ ref: 'dt_1', key: 'orders', name: 'Orders' }],
            agents: [{ ref: 'agt_1', name: 'Helper' }],
            knowledgeBases: [{ ref: 'kb_1', name: 'Handbook' }],
        },
    },
};

/** Een plan waarin alle vijf de uitkomsten één keer voorkomen. */
const PLAN_BODY = {
    ok: true,
    toVersion: 4,
    manifest: MANIFEST,
    plan: {
        add: [{ ref: 'agt_1', kind: 'agent' }],
        replace: [{ ref: 'app_1', kind: 'app', entityId: 'a1' }],
        skip: [
            { ref: 'aut_1', kind: 'automation', entityId: 'x1', why: 'edited since it was installed' },
            { ref: 'dt_1', kind: 'datatable', entityId: 'd1', why: 'already installed, and an update never rewrites one — it holds live data' },
            { ref: 'kb_1', kind: 'knowledge_base', entityId: 'k1', why: 'already installed, and an update never rewrites one — it holds live data' },
        ],
        missing: [{ ref: 'web_1', kind: 'webpage', entityId: 'w1' }],
    },
};

beforeEach(() => { globalThis.__authFetch = vi.fn(); });

// ── 1. The plan, and the row that cannot be determined ──────────────────────────

describe('the named rows', () => {
    it('maps the four server lists onto added / changed / stays / gone', () => {
        const rows = planRows(PLAN_BODY);
        expect(rows.added.map(r => r.name)).toEqual(['Helper']);
        expect(rows.changed.map(r => r.name)).toEqual(['Desk']);
        expect(rows.kept.map(r => r.name)).toEqual(['Nightly invoices']);
        expect(rows.gone.map(r => r.ref)).toEqual(['web_1']);
    });

    it('A TABLE THAT STAYS IS NOT A TABLE WE CHECKED — it lands on `undetermined`', () => {
        const rows = planRows(PLAN_BODY);
        // Both are kinds for which the upgrade has no live payload, so whether the
        // installer changed them is not determinable here.
        expect(rows.undetermined.map(r => r.name).sort()).toEqual(['Handbook', 'Orders']);
        expect(rows.kept.map(r => r.name)).not.toContain('Orders');
    });

    it('a skip on a comparable kind whose reason does NOT mention editing falls back to undetermined', () => {
        // Two signals must agree. If the server changes its sentence, then this screen
        // promises less instead of something untrue.
        const rows = planRows({
            manifest: MANIFEST,
            plan: { skip: [{ ref: 'aut_1', kind: 'automation', why: 'held back for reasons' }] },
        });
        expect(rows.kept).toEqual([]);
        expect(rows.undetermined.map(r => r.name)).toEqual(['Nightly invoices']);
    });

    it('an entity kind this screen does not know reads as undetermined, never as untouched', () => {
        const rows = planRows({
            manifest: MANIFEST,
            plan: { skip: [{ ref: 'zz_1', kind: 'gadget', why: 'edited since it was installed' }] },
        });
        expect(rows.kept).toEqual([]);
        expect(rows.undetermined.map(r => r.ref)).toEqual(['zz_1']);
    });

    it('survives a body with no plan at all rather than throwing', () => {
        const rows = planRows(undefined);
        expect(rows).toEqual({ added: [], changed: [], kept: [], undetermined: [], gone: [] });
    });

    it('names come from the manifest the plan carried; a ref without one stays the ref', () => {
        const index = nameIndex(MANIFEST);
        expect(index.get('aut_1')).toBe('Nightly invoices');
        expect(index.get('dt_1')).toBe('Orders');
        expect(nameIndex(null).size).toBe(0);
    });

    it('"nothing would change" counts only what is written, not what is left alone', () => {
        expect(planTouchesNothing(planRows(PLAN_BODY))).toBe(false);
        const untouched = planRows({ manifest: MANIFEST, plan: { skip: PLAN_BODY.plan.skip, missing: PLAN_BODY.plan.missing } });
        expect(planTouchesNothing(untouched)).toBe(true);
    });
});

describe('the plan as it is shown before the button', () => {
    it('states, in words, that these were not checked', () => {
        // The group catches more than tables and knowledge bases: also a comparable kind
        // whose server `why` does not carry the word “edited” — an automation that could
        // not be READ, for example (upgrade.js deliberately puts it there rather than at
        // “deleted by you”). The explanation may therefore not be a statement about
        // tables ALONE.
        const { getByTestId } = render(<PlanBody rows={planRows(PLAN_BODY)} />);
        const note = getByTestId('upgrade-group-undetermined').textContent;
        expect(note).toMatch(/without checking whether you changed them/);
        expect(note).toMatch(/not a statement that you did not/);
        expect(note).toMatch(/could not read is left alone/);
        expect(getByTestId('upgrade-group-kept').textContent).toMatch(/Your version is kept/);
    });

    it('a group with nothing in it renders no heading at all', () => {
        const { queryByTestId } = render(
            <PlanBody rows={planRows({ manifest: MANIFEST, plan: { add: [{ ref: 'agt_1', kind: 'agent' }] } })} />,
        );
        expect(queryByTestId('upgrade-group-added')).toBeTruthy();
        expect(queryByTestId('upgrade-group-undetermined')).toBeNull();
        expect(queryByTestId('upgrade-group-gone')).toBeNull();
    });
});

// ── 2. De banner, en de scope ──────────────────────────────────────────────

describe('may the banner promise anything', () => {
    const listed = [{ id: 'bp1', version: 5 }];

    it('a Solution that came from no Blueprint has no question to answer', () => {
        expect(updateAvailability({ installedFromBlueprintId: null, installedVersion: 2, blueprints: listed }).state)
            .toBe('none');
    });

    it('A BLUEPRINT THIS READER MAY NOT SEE IS UNKNOWN — never "available"', () => {
        // `blueprints` is the org-scoped list. An id that is not in it has either been
        // deleted or belongs to another organisation, and in both cases this screen may
        // not claim anything about it.
        const out = updateAvailability({ installedFromBlueprintId: 'bp_other', installedVersion: 2, blueprints: listed });
        expect(out.state).toBe('unknown');
        expect(out.latestVersion).toBeNull();
        // …and the id does not travel along, so no plan can be requested for it.
        expect(out.blueprintId).toBeNull();
    });

    it('a gallery listing that could not be read is unknown, not up to date', () => {
        expect(updateAvailability({ installedFromBlueprintId: 'bp1', installedVersion: 2, blueprints: null }).state)
            .toBe('unknown');
    });

    it('AN UNKNOWN INSTALLED VERSION IS UNKNOWN — the server\'s `|| 0` trap is not repeated', () => {
        // isNewer itself reads a missing version as 0, so every v1 would be “newer”.
        // The banner first requires a read number.
        expect(isNewer({ installedVersion: undefined, blueprintVersion: 1 })).toBe(true);
        expect(updateAvailability({ installedFromBlueprintId: 'bp1', installedVersion: null, blueprints: [{ id: 'bp1', version: 1 }] }).state)
            .toBe('unknown');
    });

    it('equal versions are not an upgrade', () => {
        expect(updateAvailability({ installedFromBlueprintId: 'bp1', installedVersion: 5, blueprints: listed }).state)
            .toBe('current');
        expect(updateAvailability({ installedFromBlueprintId: 'bp1', installedVersion: 4, blueprints: listed }).state)
            .toBe('available');
    });

    it('names the version only in the available state', () => {
        const { getByTestId } = render(
            <UpdateBanner availability={{ state: 'available', latestVersion: 5, installedVersion: 4 }} onOpen={() => {}} />,
        );
        expect(getByTestId('solution-update-available').textContent).toMatch(/Version 5/);
    });

    it('the unknown state says so and offers no button', () => {
        // Unknown offers no button: there is nothing to update of which we do not know
        // whether it exists.
        const { getByTestId, queryByTestId } = render(<UpdateBanner availability={{ state: 'unknown' }} />);
        expect(getByTestId('solution-update-unknown')).toBeTruthy();
        expect(queryByTestId('solution-update-open')).toBeNull();
    });

    it('an up-to-date Solution gets no banner of any kind', () => {
        const { queryByTestId } = render(<UpdateBanner availability={{ state: 'current' }} />);
        expect(queryByTestId('solution-update-available')).toBeNull();
        expect(queryByTestId('solution-update-unknown')).toBeNull();
    });

    it('without a handler the sentence stays and the button goes', () => {
        const { getByTestId, queryByTestId } = render(
            <UpdateBanner availability={{ state: 'available', latestVersion: 5, installedVersion: 4 }} />,
        );
        expect(getByTestId('solution-update-available')).toBeTruthy();
        expect(queryByTestId('solution-update-open')).toBeNull();
    });
});

// ── 3. De twee requests ────────────────────────────────────────────────────

describe('what travels to the server', () => {
    it('NAMES THE BLUEPRINT AND NEVER SENDS A MANIFEST', () => {
        globalThis.__authFetch = vi.fn(async () => ({ ok: true, json: async () => PLAN_BODY }));
        return fetchUpgradePlan({ projectId: 'p1', blueprintId: 'bp1' }).then(() => {
            const [url, init] = globalThis.__authFetch.mock.calls[0];
            expect(url).toBe('/api/projects/p1/package/upgrade/plan');
            const body = JSON.parse(init.body);
            // Only the id: then `canRead` on the server decides whether this reader may have
            // that Blueprint. A manifest sent along would bypass that.
            expect(Object.keys(body)).toEqual(['blueprintId']);
            expect(body.manifest).toBeUndefined();
        });
    });

    it('a 404 or a refusal is an error, not an empty plan', async () => {
        globalThis.__authFetch = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Not found' }) }));
        expect((await fetchUpgradePlan({ projectId: 'p1', blueprintId: 'bp1' })).status).toBe('error');
    });

    it('a body that says ok:false is an error even on a 200', async () => {
        globalThis.__authFetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, errors: ['bad'] }) }));
        expect((await fetchUpgradePlan({ projectId: 'p1', blueprintId: 'bp1' })).status).toBe('error');
    });

    it('a thrown fetch is an error rather than an exception', async () => {
        globalThis.__authFetch = vi.fn(async () => { throw new Error('offline'); });
        expect((await runUpgrade({ projectId: 'p1', blueprintId: 'bp1' })).status).toBe('error');
    });

    it('the report is read from an allow-list of counts and the server\'s own sentences', () => {
        const report = readReport({
            replaced: [{ ref: 'app_1' }],
            added: { automations: ['a'], apps: [], webpages: ['w', 'w2'], datatables: [], agents: [], knowledgeBases: [] },
            failed: [{ ref: 'x', kind: 'app', why: 'App Studio is not part of this plan.' }],
            warnings: ['"web_1" was installed once and is gone now'],
            projectName: 'Secret project',
        });
        expect(report).toEqual({
            replaced: 1,
            added: 3,
            failed: [{ ref: 'x', why: 'App Studio is not part of this plan.' }],
            warnings: ['"web_1" was installed once and is gone now'],
        });
        expect(JSON.stringify(report)).not.toMatch(/Secret project/);
    });
});

// ── 4. De bevestiging ──────────────────────────────────────────────────────

describe('the dialog', () => {
    it('shows the plan first and only then a confirm button', async () => {
        globalThis.__authFetch = vi.fn(async () => ({ ok: true, json: async () => PLAN_BODY }));
        const { getByTestId, findByTestId } = render(
            <UpgradeDialog open projectId="p1" blueprintId="bp1" onClose={() => {}} />,
        );
        await findByTestId('upgrade-group-changed');
        expect(getByTestId('upgrade-group-undetermined')).toBeTruthy();
        expect(getByTestId('upgrade-confirm')).toBeTruthy();
    });

    it('A PLAN THAT COULD NOT BE READ OFFERS NO CONFIRM AT ALL', async () => {
        globalThis.__authFetch = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Request failed' }) }));
        const { findByTestId, queryByTestId } = render(
            <UpgradeDialog open projectId="p1" blueprintId="bp1" onClose={() => {}} />,
        );
        await findByTestId('upgrade-plan-unreadable');
        expect(queryByTestId('upgrade-confirm')).toBeNull();
    });

    it('a plan that changes and adds nothing says so and offers no button', async () => {
        globalThis.__authFetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ ok: true, toVersion: 4, manifest: MANIFEST, plan: { skip: PLAN_BODY.plan.skip } }),
        }));
        const { findByTestId, queryByTestId } = render(
            <UpgradeDialog open projectId="p1" blueprintId="bp1" onClose={() => {}} />,
        );
        await findByTestId('upgrade-plan-empty');
        expect(queryByTestId('upgrade-confirm')).toBeNull();
    });

    it('confirming posts to the upgrade route and reports what happened', async () => {
        const user = userEvent.setup();
        globalThis.__authFetch = vi.fn(async (url) => {
            if (url.endsWith('/upgrade/plan')) return { ok: true, json: async () => PLAN_BODY };
            return {
                ok: true,
                json: async () => ({
                    ok: true, toVersion: 4,
                    report: { replaced: [{ ref: 'app_1' }], added: { agents: ['x'] }, failed: [], warnings: [] },
                }),
            };
        });
        const onDone = vi.fn();
        const { findByTestId, getByTestId } = render(
            <UpgradeDialog open projectId="p1" blueprintId="bp1" onClose={() => {}} onDone={onDone} />,
        );
        await user.click(await findByTestId('upgrade-confirm'));
        await waitFor(() => expect(getByTestId('upgrade-report')).toBeTruthy());
        expect(getByTestId('upgrade-report').textContent).toMatch(/1 replaced, 1 added/);
        expect(onDone).toHaveBeenCalled();
        const [url, init] = globalThis.__authFetch.mock.calls[1];
        expect(url).toBe('/api/projects/p1/package/upgrade');
        expect(Object.keys(JSON.parse(init.body))).toEqual(['blueprintId']);
    });

    it('a failed apply says nothing was rolled back, and does not claim success', async () => {
        const user = userEvent.setup();
        globalThis.__authFetch = vi.fn(async (url) => (
            url.endsWith('/upgrade/plan')
                ? { ok: true, json: async () => PLAN_BODY }
                : { ok: false, json: async () => ({ error: 'Request failed' }) }
        ));
        const onDone = vi.fn();
        const { findByTestId, getByTestId, queryByTestId } = render(
            <UpgradeDialog open projectId="p1" blueprintId="bp1" onClose={() => {}} onDone={onDone} />,
        );
        await user.click(await findByTestId('upgrade-confirm'));
        await waitFor(() => expect(getByTestId('upgrade-apply-failed')).toBeTruthy());
        expect(queryByTestId('upgrade-report')).toBeNull();
        expect(onDone).not.toHaveBeenCalled();
    });

    it('asks for nothing while it is closed', () => {
        render(<UpgradeDialog open={false} projectId="p1" blueprintId="bp1" onClose={() => {}} />);
        expect(globalThis.__authFetch).not.toHaveBeenCalled();
    });

    it('asks for nothing without a Blueprint the scope resolved', () => {
        render(<UpgradeDialog open projectId="p1" blueprintId={null} onClose={() => {}} />);
        expect(globalThis.__authFetch).not.toHaveBeenCalled();
    });
});
