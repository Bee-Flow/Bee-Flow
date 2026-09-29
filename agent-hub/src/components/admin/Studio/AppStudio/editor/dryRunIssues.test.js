// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import dryRunIssues, { nodeLabel } from './dryRunIssues';

/**
 * The pre-flight check's sentences, and the translation seam under them.
 *
 * The module had no test of its own: PublishModal.test.jsx renders it through
 * the modal and asserts fragments (/could not load its data/i), so nothing
 * pinned the whole sentence — and nothing at all pinned the two shapes this
 * retrofit had to take apart. Both were English grammar in JavaScript:
 *
 *   - the role hint glued a note onto a sentence and lowercased its first word
 *     ("… — check that role's access …") while the note-less form capitalised
 *     it, so a translator would have received half a sentence;
 *   - every message was a template literal, invisible to the Languages panel.
 *
 * So: the English must read exactly as it did before (the fallback path, which
 * is what every existing assertion sees), AND a supplied t() must actually be
 * asked for the right key with the right {placeholders} — otherwise a wrong key
 * name renders its English fallback forever and no test ever goes red.
 */

const APP = {
    screens: [{
        id: 'scr_home',
        name: 'Home',
        sections: [{
            id: 'sec_main',
            children: [
                { id: 'cmp_list', type: 'list', props: { title: 'Order list' } },
                { id: 'cmp_bare', type: 'table', props: {} },
            ],
        }],
    }],
};

const EMPTY = { static: { errors: [], warnings: [] }, bindings: [], roleFindings: [], actions: [] };

/** A t() that records what it was asked for and answers with the fallback. */
function spyT() {
    const calls = [];
    const t = (key, en, params) => {
        calls.push({ key, params });
        return Object.entries(params || {}).reduce(
            (out, [k, v]) => out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
            String(en),
        );
    };
    t.keys = () => calls.map((c) => c.key);
    t.calls = calls;
    return t;
}

describe('dryRunIssues — the sentences the publish modal draws', () => {
    it('is empty for a result that is not one', () => {
        expect(dryRunIssues(null)).toEqual({ errors: [], warnings: [] });
        expect(dryRunIssues('nope')).toEqual({ errors: [], warnings: [] });
        expect(dryRunIssues({})).toEqual({ errors: [], warnings: [] });
    });

    it('passes the static pass straight through, stamped with its severity', () => {
        const out = dryRunIssues({
            ...EMPTY,
            static: {
                errors: [{ code: 'x', message: 'Screen “Home” has no components.', path: 'screens[0]' }],
                warnings: [{ code: 'y', message: 'Two screens share a name.' }],
            },
        });
        expect(out.errors).toEqual([{ code: 'x', message: 'Screen “Home” has no components.', path: 'screens[0]', severity: 'error' }]);
        expect(out.warnings[0]).toMatchObject({ message: 'Two screens share a name.', severity: 'warning' });
    });

    it('names the component in a failed binding, and keeps its own error as the hint', () => {
        const { errors } = dryRunIssues(
            { ...EMPTY, bindings: [{ nodeId: 'cmp_list', ok: false, error: 'no such table: orders' }] },
            APP,
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('“Order list” could not load its data.');
        expect(errors[0].hint).toBe('no such table: orders');
        expect(errors[0].nodeId).toBe('cmp_list');
    });

    it('falls back to its own hint when the server gave no reason', () => {
        const { errors } = dryRunIssues({ ...EMPTY, bindings: [{ nodeId: 'cmp_bare', ok: false }] }, APP);
        expect(errors[0].message).toBe('table could not load its data.');
        expect(errors[0].hint).toBe('Open the component and check where its data comes from.');
    });

    /**
     * Zero rows is a warning, never an error: an unseeded table is normal and
     * must not block a publish. The hint differs for a saved view, because the
     * fix is a different place.
     */
    it('treats no rows as worth a look, with the hint that matches where the rows come from', () => {
        const { errors, warnings } = dryRunIssues({
            ...EMPTY,
            bindings: [
                { nodeId: 'cmp_list', ok: true, rowCount: 0, kind: 'records' },
                { nodeId: 'cmp_bare', ok: true, rowCount: 0, kind: 'dataset' },
            ],
        }, APP);
        expect(errors).toEqual([]);
        expect(warnings[0].message).toBe('“Order list” shows nothing right now — it found no rows.');
        expect(warnings[0].hint).toBe('Add some rows to the table, or loosen the filter on this component.');
        expect(warnings[1].hint).toBe('The saved view is empty: add rows to the table behind it, or loosen its filters.');
    });

    it('says nothing about a binding that was skipped, or one that returned rows', () => {
        const { errors, warnings } = dryRunIssues({
            ...EMPTY,
            bindings: [
                { nodeId: 'cmp_list', ok: true, rowCount: 0, skipped: true },
                { nodeId: 'cmp_bare', ok: true, rowCount: 3 },
            ],
        }, APP);
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);
    });

});

describe('dryRunIssues — what a role would see, and what a step would do', () => {
    /**
     * Two whole sentences, not one sentence with a capital letter swapped. The
     * note-prefixed form lowercases "check" — the shape §2.3 of the i18n
     * conventions bans, because no translation can rebuild a sentence from a
     * fragment and a capital.
     */
    it('gives the role finding a whole sentence either way', () => {
        const withNote = dryRunIssues({
            ...EMPTY,
            roleFindings: [{ role: 'member', nodeId: 'cmp_list', rowCount: 0, note: 'Row rules hide every row' }],
        }, APP).warnings[0];
        expect(withNote.message).toBe('Someone with the “member” role would see nothing in “Order list”.');
        expect(withNote.hint).toBe("Row rules hide every row — check that role's access to the table, or share the rows with everyone in the app.");

        const bare = dryRunIssues({
            ...EMPTY,
            roleFindings: [{ role: 'member', nodeId: 'cmp_list', rowCount: 0 }],
        }, APP).warnings[0];
        expect(bare.hint).toBe("Check that role's access to the table, or share the rows with everyone in the app.");
    });

    it('ignores a role finding that did return rows', () => {
        expect(dryRunIssues({ ...EMPTY, roleFindings: [{ role: 'member', rowCount: 2 }] }, APP).warnings).toEqual([]);
    });

    it('names the step that cannot run, and joins the reasons behind it', () => {
        const { errors } = dryRunIssues({
            ...EMPTY,
            actions: [{ step: 'create_record', ok: false, errors: ['unknown field "amount_due"', 'no such table'] }],
        }, APP);
        expect(errors[0].message).toBe('A step in this app’s logic cannot run: create_record.');
        expect(errors[0].hint).toBe('unknown field "amount_due"; no such table');
    });

    it('still reads as a sentence when the step has no name and no reasons', () => {
        const { errors } = dryRunIssues({ ...EMPTY, actions: [{ ok: false }] }, APP);
        expect(errors[0].message).toBe('A step in this app’s logic cannot run: a step.');
        expect(errors[0].hint).toBe('Open the action and check the table and columns it writes to.');
    });
});

describe('dryRunIssues — the translation seam', () => {
    it('asks t() for each sentence by key, with the values filled in around it', () => {
        const t = spyT();
        dryRunIssues({
            ...EMPTY,
            bindings: [{ nodeId: 'cmp_list', ok: false, error: 'boom' }],
            roleFindings: [{ role: 'member', nodeId: 'cmp_bare', rowCount: 0, note: 'Row rules' }],
            actions: [{ step: 'create_record', ok: false, errors: ['nope'] }],
        }, APP, t);

        expect(t.keys()).toEqual(expect.arrayContaining([
            'app_studio.publish.issue_binding_failed',
            'app_studio.publish.issue_role_empty',
            'app_studio.publish.issue_role_empty_note',
            'app_studio.publish.issue_step',
        ]));
        // The component's own words travel as a PARAMETER, so a translation can
        // put them wherever its grammar wants them.
        expect(t.calls.find((c) => c.key === 'app_studio.publish.issue_binding_failed').params)
            .toEqual({ who: '“Order list”' });
        expect(t.calls.find((c) => c.key === 'app_studio.publish.issue_role_empty').params)
            .toEqual({ role: 'member', node: 'table' });
    });

    it('renders what t() returns, so a translated app really does read translated', () => {
        const t = vi.fn((key, en) => (key === 'app_studio.publish.issue_binding_failed'
            ? 'Kon de gegevens niet laden.'
            : en));
        const { errors } = dryRunIssues({ ...EMPTY, bindings: [{ nodeId: 'cmp_list', ok: false }] }, APP, t);
        expect(errors[0].message).toBe('Kon de gegevens niet laden.');
        // …while the hint beside it, untranslated, still shows English rather
        // than a raw key.
        expect(errors[0].hint).toBe('Open the component and check where its data comes from.');
    });

    it('reads the placeholder-less English when nobody hands it a t()', () => {
        // resolveTarget.test.js calls nodeLabel two-arg; the whole module has to
        // keep working without a translator, or a unit test starts asserting
        // raw keys.
        expect(nodeLabel(APP, null)).toBe('A component');
        expect(nodeLabel(APP, 'cmp_list')).toBe('“Order list”');
        expect(nodeLabel(APP, 'cmp_ghost')).toBe('cmp_ghost');
    });

    it('translates "A component" too when a finding names no node', () => {
        const t = spyT();
        const { errors } = dryRunIssues({ ...EMPTY, bindings: [{ ok: false }] }, APP, t);
        expect(t.keys()).toContain('app_studio.publish.issue_component');
        expect(errors[0].message).toBe('A component could not load its data.');
    });
});
