import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ValidationLine } from './formPrimitives';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';

/**
 * The drawer's half of "one failure, one language" (the canvas half is
 * flow/nodes/StepNodeBase.errorLanguage.test.jsx).
 *
 * The canvas pill said `Step "Is it urgent?": unknown type`; this line, one
 * click later, said `Step cond_a3f91b: unknown type` — the same record, with
 * the author's own step name traded back for the hex id they never chose. The
 * pill is where the user clicked BECAUSE it named their step, so the drawer
 * turning that sentence into a different one made it read as a second problem.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const LABELS = new Map([['trg', 'Start'], ['cond_a3f91b', 'Is it urgent?']]);

function renderLine(record, labels = LABELS) {
    return render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={labels} stepTypeById={new Map()}>
            <ValidationLine record={record} />
        </VariablePickerProvider>,
    );
}

describe('ValidationLine — the drawer says what the pill said', () => {
    beforeEach(cleanup);

    it('swaps known step ids for the names the author typed', () => {
        const { container } = renderLine({
            severity: 'error',
            code: 'step.unknown_type',
            message: 'Step cond_a3f91b: unknown type "conditie"',
        });
        // Byte for byte the sentence the canvas dot shows — see
        // StepNodeBase.errorLanguage.test.jsx, which asserts the same string.
        expect(container.textContent).toContain('Step "Is it urgent?": unknown type "conditie"');
        expect(container.textContent).not.toContain('cond_a3f91b');
    });

    it('humanises the fix line too — the hint names steps just as often', () => {
        const { container } = renderLine({
            severity: 'warning',
            code: 'ref.forward',
            message: 'Reads from cond_a3f91b, which runs later',
            hint: 'Move this step after cond_a3f91b',
        });
        expect(container.textContent).toContain('Move this step after "Is it urgent?"');
    });

    it('keeps the machine code reachable — on the marker dot, not in the sentence', () => {
        renderLine({ severity: 'error', code: 'BF-1042', message: 'Step cond_a3f91b: unknown type' });
        const dot = screen.getByLabelText('Code BF-1042');
        expect(dot.title).toBe('BF-1042');
        expect(screen.getByText(/unknown type/).textContent.startsWith('BF-1042')).toBe(false);
    });

    /**
     * Humanising rewrites the server's sentence, and two validators word the
     * id as something to COPY rather than as prose — `field_name_unbindable`
     * prints the path that will not resolve, `id_unbindable` reports that the
     * id itself is illegal (server/automation/validate/fieldChecks.js). Read
     * humanised, the first hands out `steps."Is it urgent?".output.x-y` (not a
     * path anyone can paste) and the second reports a token the reader can no
     * longer see. So the record as it was sent stays on the row's tooltip.
     */
    it('keeps the sentence as the server worded it one hover away', () => {
        const { container } = renderLine({
            severity: 'warning',
            code: 'ai_step.field_name_unbindable',
            message: 'Step cond_a3f91b: field name "x-y" cannot be referenced as steps.cond_a3f91b.output.x-y — that path means something else to the expression grammar.',
            hint: 'Rename it to letters, digits and underscores.',
        });
        const row = container.querySelector('div[title]');
        expect(row.title).toContain('steps.cond_a3f91b.output.x-y');
        // The words are still what is on screen — the id is demoted, not back.
        expect(row.textContent).toContain('Step "Is it urgent?": field name "x-y"');
    });

    it('humanises the hint into the tooltip too, arrow and all', () => {
        const { container } = renderLine({
            severity: 'warning',
            code: 'ref.forward',
            message: 'Reads from cond_a3f91b, which runs later',
            hint: 'Move this step after cond_a3f91b',
        });
        expect(container.querySelector('div[title]').title)
            .toBe('Reads from cond_a3f91b, which runs later\n\u2192 Move this step after cond_a3f91b');
    });

    it('adds no tooltip when nothing was swapped — it would only echo the line', () => {
        const { container } = renderLine({ severity: 'error', code: 'trigger.missing', message: 'Missing or invalid trigger.' });
        expect(container.querySelector('div[title]')).toBeNull();
    });

    it('leaves an id it has no name for alone, and survives outside the provider', () => {
        const { container } = renderLine({ severity: 'error', message: 'Step ghost_99 not found' }, new Map());
        expect(container.textContent).toContain('Step ghost_99 not found');
        cleanup();
        // No VariablePickerProvider at all (App Studio renders these primitives
        // too): the context default is an empty Map, and the record is shown
        // exactly as it arrived rather than blowing up.
        const bare = render(<ValidationLine record={{ severity: 'error', message: 'Step ghost_99 not found' }} />);
        expect(bare.container.textContent).toContain('Step ghost_99 not found');
    });
});

describe('the drawer is actually inside the provider that holds the labels', () => {
    /**
     * The humanising above is only real if something upstream hands the panel a
     * label map. NodeDetailView does — it builds one with `buildStepLabelMap`,
     * the very call FloatingValidationPill makes — and this pins that wiring,
     * because a render test of this component alone would keep passing on the
     * day someone unwraps the provider and the drawer silently starts printing
     * hex ids again.
     */
    it('NodeDetailView wraps the settings host in VariablePickerProvider with stepLabelById', () => {
        const src = fs.readFileSync(path.join(HERE, '..', '..', 'NodeDetailView.jsx'), 'utf8');
        expect(src).toMatch(/const stepLabelById = useMemo\(\(\) => buildStepLabelMap\(definition\)/);
        expect(src).toMatch(/<VariablePickerProvider[^>]*stepLabelById=\{stepLabelById\}/s);
    });
});
