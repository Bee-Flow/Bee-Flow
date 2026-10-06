// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mergeStepPatchIntoDefinition } from './switchCaseOps';

/**
 * A Condition that works through a list hands its OUTPUTS on (W3-W5, and the
 * "Send what doesn't match to Otherwise" flip of BFSF-485 F2): when its
 * outputs change shape, the steps reading an output follow it in the same
 * definition update the editor saves, so one Undo takes back both.
 */
const MESSAGES = 'steps.read_many.output.messages';
const PDF_RULE = 'anyOf(fileType(item.attachments[*]), "equals", "pdf")';

const filterStep = (extra = {}) => ({ id: 'cond', type: 'filter', label: 'Condition', arrayRef: MESSAGES, expr: PDF_RULE, ...extra });
const switchStep = (names, extra = {}) => ({
    id: 'cond', type: 'switch', label: 'Condition', arrayRef: MESSAGES, routeStyle: 'rules', defaultBranch: null,
    cases: names.map(name => ({ name, expr: `equals(fileType(item), "${name}")` })),
    ...extra,
});

/** Read many → Condition → Read attachment, plus a step that reads another list. */
function definition(route, readAttachmentOverRef, parents = null) {
    const edgeOut = route.type === 'filter'
        ? { from: 'cond', to: 'read_attachment' }
        : { from: 'cond', to: 'read_attachment', label: `case:${route.cases[0].name}`, caseName: route.cases[0].name };
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'read_many', type: 'integration_action', tool: 'gmail_read_many', label: 'Read many' },
            route,
            {
                id: 'read_attachment', type: 'integration_action', tool: 'gmail_read_attachment', label: 'Read attachment',
                forEach: { overRef: readAttachmentOverRef, itemVar: 'attachment', ...(parents ? { parents } : {}) },
                inputs: { messageId: { kind: 'ref', path: 'loop.attachment.messageId' } },
            },
            {
                id: 'unrelated', type: 'notification', label: 'Notify',
                forEach: { overRef: 'steps.read_many.output.messages[*].attachments', itemVar: 'file' },
            },
        ],
        edges: [
            { from: 'trg', to: 'read_many' },
            { from: 'read_many', to: 'cond' },
            edgeOut,
            { from: 'read_many', to: 'unrelated' },
        ],
    };
}

const stepOf = (def, id) => def.steps.find(s => s.id === id);
const overRefOf = (def) => stepOf(def, 'read_attachment').forEach.overRef;

describe('mergeStepPatchIntoDefinition — the steps after a list Condition follow its outputs', () => {
    it('W3: one output → several moves the reader from items to the first output', () => {
        const def = definition(filterStep(), 'steps.cond.output.items[*].attachments');
        const next = mergeStepPatchIntoDefinition(def, filterStep(), switchStep(['pdf', 'word']));
        expect(overRefOf(next)).toBe('steps.cond.output.matchesByCase.pdf[*].attachments');
        expect(next.edges).toContainEqual(expect.objectContaining({ from: 'cond', to: 'read_attachment', caseName: 'pdf' }));
    });

    it('W3: several outputs → one moves the reader of the first output back to items', () => {
        const sw = switchStep(['pdf', 'word']);
        const def = definition(sw, 'steps.cond.output.matchesByCase.pdf[*].attachments');
        const { cases: _c, routeStyle: _r, defaultBranch: _d, ...rest } = sw;
        const next = mergeStepPatchIntoDefinition(def, sw, { ...rest, type: 'filter', expr: PDF_RULE, cases: undefined });
        expect(overRefOf(next)).toBe('steps.cond.output.items[*].attachments');
    });

    it('F2: "Send what doesn\'t match to Otherwise" on and off re-points the reader both ways', () => {
        const def = definition(filterStep(), 'steps.cond.output.items[*].attachments');
        const keepRest = { type: 'switch', routeStyle: 'rules', cases: [{ name: 'keep', expr: PDF_RULE }], defaultBranch: null };
        const on = mergeStepPatchIntoDefinition(def, filterStep(), keepRest);
        expect(overRefOf(on)).toBe('steps.cond.output.matchesByCase.keep[*].attachments');

        const asSwitch = stepOf(on, 'cond');
        const off = mergeStepPatchIntoDefinition(on, asSwitch, { type: 'filter', expr: PDF_RULE });
        expect(overRefOf(off)).toBe('steps.cond.output.items[*].attachments');
    });

    it('W4: renaming an output rewrites every reader of it', () => {
        const sw = switchStep(['pdf', 'word']);
        const def = definition(sw, 'steps.cond.output.matchesByCase.pdf');
        const renamed = [{ ...sw.cases[0], name: 'invoices' }, sw.cases[1]];
        const next = mergeStepPatchIntoDefinition(def, sw, { cases: renamed });
        expect(overRefOf(next)).toBe('steps.cond.output.matchesByCase.invoices');
        expect(next.edges).toContainEqual(expect.objectContaining({ from: 'cond', to: 'read_attachment', caseName: 'invoices' }));
    });

    it('W5: the list one level deeper drops the [*].k tail and the parent that no longer leads', () => {
        const def = definition(filterStep(), 'steps.cond.output.items[*].attachments',
            [{ itemVar: 'message', overRef: 'steps.cond.output.items' }]);
        const next = mergeStepPatchIntoDefinition(def, filterStep(), {
            arrayRef: `${MESSAGES}[*].attachments`, expr: 'equals(fileType(item), "pdf")',
        });
        const fe = stepOf(next, 'read_attachment').forEach;
        expect(fe.overRef).toBe('steps.cond.output.items');
        expect(fe.parents || []).toEqual([]);
    });

    it('deleting or adding a case never re-points another output\'s reader', () => {
        const sw = switchStep(['pdf', 'word', 'excel']);
        const def = definition(sw, 'steps.cond.output.matchesByCase.word');
        def.edges[2] = { from: 'cond', to: 'read_attachment', label: 'case:word', caseName: 'word' };
        for (const names of [['word', 'excel'], ['pdf', 'word'], ['pdf', 'new', 'word', 'excel']]) {
            const next = mergeStepPatchIntoDefinition(def, sw, { cases: switchStep(names).cases });
            expect(overRefOf(next)).toBe('steps.cond.output.matchesByCase.word');
            expect(next.edges).toContainEqual(expect.objectContaining({ from: 'cond', to: 'read_attachment', caseName: 'word' }));
        }
    });

    it('reordering the outputs keeps the reader and its edge on its own output', () => {
        const sw = switchStep(['pdf', 'word']);
        const def = definition(sw, 'steps.cond.output.matchesByCase.pdf');
        const next = mergeStepPatchIntoDefinition(def, sw, { cases: switchStep(['word', 'pdf']).cases });
        expect(overRefOf(next)).toBe('steps.cond.output.matchesByCase.pdf');
        expect(next.edges).toContainEqual(expect.objectContaining({ from: 'cond', to: 'read_attachment', caseName: 'pdf' }));
    });

    it('"The whole run" again points the reader back at the list the Condition was given', () => {
        const def = definition(filterStep(), 'steps.cond.output.items[*].attachments');
        const next = mergeStepPatchIntoDefinition(def, filterStep(), { type: 'condition', arrayRef: undefined });
        expect(overRefOf(next)).toBe(`${MESSAGES}[*].attachments`);
    });

    it('leaves a step that reads another list alone', () => {
        const def = definition(filterStep(), 'steps.cond.output.items[*].attachments');
        const next = mergeStepPatchIntoDefinition(def, filterStep(), switchStep(['pdf']));
        expect(stepOf(next, 'unrelated')).toEqual(stepOf(def, 'unrelated'));
    });

    it('changes nothing downstream when a whole-run Condition is edited', () => {
        const cond = { id: 'cond', type: 'condition', label: 'Condition', expr: 'trigger.output.ok == true' };
        const def = definition(filterStep(), 'steps.read_many.output.messages[*].attachments');
        def.steps[1] = cond;
        const next = mergeStepPatchIntoDefinition(def, cond, { expr: 'trigger.output.ok == false' });
        expect(stepOf(next, 'read_attachment')).toEqual(stepOf(def, 'read_attachment'));
    });
});
