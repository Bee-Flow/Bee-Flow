import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import scopedStorage, { setCurrentUser } from '@/utils/scopedStorage';
import { stub } from '@/test/mocks';
import { EditorChromeContext } from '@/components/admin/Studio/AppStudio/editor/EditorChromeContext';
import { EDITOR_PREF_KEY } from '@/components/automation/Builder/flow/settings/codeStep/monaco';
import StepSettings from '../index';
import { StepField } from '../StepField';
import { fieldControlFor } from '../fieldTypes';
import { newStep, stepMeta } from '../../stepKinds';
import type { AppAction, AppDefinition } from '@/components/admin/Studio/AppStudio/inspector/appDefinition';
import type { StepFieldProps } from '../../StepSettings.types';

/**
 * The code step in the step editor, with the corpus app that uses it
 * (server/appStudio/compat/corpus/v3-code-step-quote.json), the real step catalog and the real
 * canonicalizer: every field has a control, the code box edits the source, and what it writes is
 * what canonicalize keeps. The plain box stands in for Monaco (the person's own choice, remembered).
 */

const require = createRequire(import.meta.url);
const SERVER = path.resolve(__dirname, '../../../../../../../../../server');
const { canonicalizeAppDefinition } = require(path.join(SERVER, 'appStudio/canonicalize.js'));
const { STEP_SPECS } = require(path.join(SERVER, 'appStudio/componentSpecs.js'));

type Step = AppAction & Record<string, unknown>;
const APP = JSON.parse(fs.readFileSync(path.join(SERVER, 'appStudio/compat/corpus/v3-code-step-quote.json'), 'utf8')) as { definition: AppDefinition & { actions: Record<string, { steps: Step[] }> } };
const CODE_STEP = APP.definition.actions.act_cqquote.steps[0];

function canon(step: Step): Step {
    const def = { schemaVersion: 2, meta: { name: 'T' }, theme: {}, homeScreenId: 'scr', screens: [{ id: 'scr', name: 'T', sections: [] }], actions: { act_probe: { kind: 'sequence', steps: [step] } } };
    return canonicalizeAppDefinition(def).def.actions.act_probe.steps[0];
}

function answer(url: string): unknown {
    if (url.includes('/studio-apps/catalog')) return { components: {}, actions: { stepSpecs: STEP_SPECS } };
    if (url.includes('/data/tables')) return { tables: [] };
    return {};
}

beforeEach(() => {
    setCurrentUser('u_code_test');
    scopedStorage.setItem(EDITOR_PREF_KEY, 'plain');
    setDemoTransport(async (url: string) => new Response(JSON.stringify(answer(String(url))), { status: 200, headers: { 'Content-Type': 'application/json' } }));
});
afterEach(() => { setDemoTransport(null); scopedStorage.removeItem(EDITOR_PREF_KEY); setCurrentUser(null); });

function wrap(ui: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}><EditorChromeContext.Provider value={{ appId: 'app-1' }}>{ui}</EditorChromeContext.Provider></QueryClientProvider>);
}

describe('the code step in the step editor', () => {
    it('is in the palette as a server step, and a fresh one is valid code with a result variable', () => {
        expect(stepMeta('code')).toMatchObject({ label: 'Run code', group: 'Data', server: true });
        const fresh = newStep('code') as Step;
        expect(fresh).toEqual(canon(fresh));
        expect(fresh.code).toContain('function main(inputs, ctx)');
        expect(fresh.resultVar).toBe('result');
        expect(typeof fieldControlFor('code')).toBe('function');
    });

    it('loads the corpus step: the code box, the inputs, the time limit, and no text box over structured data', async () => {
        const onChange = vi.fn();
        const { container } = wrap(<StepSettings step={CODE_STEP} onChange={onChange} definition={APP.definition} />);
        await waitFor(() => expect(container.querySelector('[data-step-control="code"]')).not.toBeNull());
        const box = screen.getByLabelText('JavaScript code') as HTMLTextAreaElement;
        expect(box.value).toBe(CODE_STEP.code);
        expect(screen.getByText('Your code reads: inputs.items, inputs.product, inputs.qty')).toBeTruthy();
        expect(screen.getByText('Time limit (ms)')).toBeTruthy();
        const boxes = [...container.querySelectorAll('input, textarea')] as HTMLInputElement[];
        expect(boxes.filter((b) => b.value.includes('[object Object]'))).toEqual([]);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('typing edits the source, and what it writes is what canonicalize keeps', async () => {
        const user = userEvent.setup();
        const writes: Step[] = [];
        function Harness() {
            const [step, setStep] = useState<Step>({ kind: 'code', code: 'return 1', resultVar: 'r' });
            return (
                <StepField
                    fieldKey="code" fs={STEP_SPECS.code.fields.code} value={step.code} step={step}
                    onChange={(v) => { const next = { ...step, code: v }; writes.push(next); setStep(next); }}
                    definition={APP.definition} node={null} options={{}}
                    references={stub<StepFieldProps['references']>({ fieldsFor: () => [], options: {} })}
                    formFields={[]} disabled={false}
                />
            );
        }
        wrap(<Harness />);
        const box = screen.getByLabelText('JavaScript code');
        await user.type(box, ';');
        expect(writes.at(-1)?.code).toBe('return 1;');
        expect(canon(writes.at(-1) as Step)).toEqual(writes.at(-1));
        expect(screen.getByText('9 of 20000 characters.')).toBeTruthy();
        expect(screen.getByText('No inputs yet: add them under Inputs, each a value, a formula or rows of a table.')).toBeTruthy();
        await user.clear(box);
        // An empty box is no code: the field is left out, so the required check names it.
        expect(writes.at(-1)?.code).toBe(undefined);
    });
});
