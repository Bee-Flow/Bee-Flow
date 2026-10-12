/**
 * JSON nested at several levels — an HTTP body (text) holding a payload (text)
 * holding list items whose meta is text again, down to a fenced AI answer
 * (the fixture of server/shared/expr/path.test.mjs). The editor treats every
 * such path as an ordinary path: a pill with a short leaf label, a preview
 * through all the text levels, and Formula ⇄ Text ⇄ condition round trips
 * that keep the path intact.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import { getPath } from '@shared/expr/path.mjs';
import BindingFieldJs, { translateForMode } from './BindingField';
import previewBinding from './bindingPreview';
import { classifyRef, fieldTailLabel } from './refTokens';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';
import { bindingFromInput, buildConditionExpr, parseSimpleCondition, walkPath } from '../../../../utils/bindingHelpers';
import { parseExprToRows, serializeRows } from '../utils/conditionModel';
import { editor } from '../../../../test/refEditor';

type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const BindingField = BindingFieldJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

const lvl3 = '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7' } }) + '\n```';
const lvl2 = JSON.stringify({ items: [{ sku: 'A1', meta: JSON.stringify({ tags: ['x', 'y'], ai: lvl3 }) }, { sku: 'B2', meta: '{"tags":["z"]}' }] });
const ROOT = { steps: { http: { output: { body: JSON.stringify({ data: { payload: lvl2 } }) } } } };
const base = 'steps.http.output.body.data.payload';
const CASES: Array<[string, unknown, string]> = [
    [`${base}.items[0].sku`, 'A1', 'Sku'],
    [`${base}.items[0].meta.tags[1]`, 'y', 'Tags ▸ 2nd'],
    [`${base}.items[0].meta.ai.verdict.score`, 0.93, 'Score'],
    [`${base}.items[0].meta.ai.verdict["reason code"]`, 'R-7', 'Reason code'],
    [`${base}.items[*].meta.tags`, ['x', 'y', 'z'], 'Tags'],
    [`${base}.items[sku="B2"].meta.tags[0]`, 'z', 'Tags ▸ 1st'],
];

afterEach(() => cleanup());

describe.each(CASES)('%s', (path, want, label) => {
    it('previews through every text level, exactly as the run resolves', () => {
        expect(walkPath(path, ROOT)).toEqual(want);
        expect(getPath(ROOT, path)).toEqual(want);
        expect(previewBinding({ kind: 'ref', path }, ROOT)).not.toMatch(/no sample/);
    });

    it('is one pill with a short leaf label', () => {
        const ref = classifyRef(path);
        expect(ref).toMatchObject({ source: 'steps', stepId: 'http' });
        expect(fieldTailLabel(ref!.fieldPath)).toBe(label);
    });

    it('survives Formula → Text → Formula and the condition builder', () => {
        const asText = translateForMode(path, 'fixed');
        expect(asText).toBe(`{{${path}}}`);
        expect(translateForMode(asText, 'expression')).toBe(path);
        expect(bindingFromInput(path, 'expression')).toEqual({ kind: 'ref', path });
        const expr = buildConditionExpr('trigger.output.x', '==', { kind: 'template', value: asText });
        expect(expr).toBe(`trigger.output.x == ${path}`);
        expect(evaluate(path, ROOT)).toEqual(want);
        const cond = `${path} != ""`;
        expect(parseSimpleCondition(cond)).toMatchObject({ leftPath: path });
        const rows = parseExprToRows(cond);
        if (!path.includes('[*]')) expect(serializeRows(rows!.rows, rows!.join)).toBe(cond);
    });
});

describe('in the field itself', () => {
    it('the reason-code pick flips to Text and back without losing a level', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const path = `${base}.items[0].meta.ai.verdict["reason code"]`;
        render(
            <VariablePickerProvider groups={[]} previewSample={ROOT} stepLabelById={new Map([['http', 'HTTP']])} stepTypeById={null}>
                <BindingField label="Code" value={{ kind: 'ref', path }} onChange={onChange} />
            </VariablePickerProvider>,
        );
        expect(editor(document.body)?.textContent).toContain('Reason code');
        expect(screen.getByText('R-7')).toBeTruthy();
        await user.click(screen.getByTitle(/^Plain text/));
        expect(onChange.mock.lastCall?.[0]).toEqual({ kind: 'template', value: `{{${path}}}` });
        await user.click(screen.getByTitle(/^Expression/));
        expect(onChange.mock.lastCall?.[0]).toEqual({ kind: 'ref', path });
    });
});
