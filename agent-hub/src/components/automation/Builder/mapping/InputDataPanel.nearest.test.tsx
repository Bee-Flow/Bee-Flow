import { render, screen, cleanup } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import InputDataPanelJs from './InputDataPanel';

const InputDataPanel = InputDataPanelJs as unknown as ComponentType<Record<string, unknown>>;

const group = (id: string, label: string, kind: string, basePath: string, keys: string[]) => ({
    id, label, kind, basePath,
    sample: Object.fromEntries(keys.map(k => [k, `v-${k}`])),
    fields: keys.map(k => ({ key: k, path: `${basePath}.${k}`, sample: `v-${k}` })),
});

const TRIGGER = group('trg', 'Trigger (manual)', 'trigger', 'trigger.output', ['trigger_note']);
const STEP = group('s1', 'Code', 'code', 'steps.s1.output', ['result_text']);
const INFO = group('__trigger_meta', 'Trigger info', 'trigger_meta', 'trigger', ['ticket_ref']);
// The walk pushes "Trigger info" after every step, not after the trigger.
const renderPanel = (groups: unknown[]) => render(
    <InputDataPanel groups={groups} previewSample={null} onPick={vi.fn()} />,
);
const titles = () => screen.getAllByTestId('input-group').map(el => el.textContent || '');

describe('InputDataPanel: which group starts open', () => {
    beforeEach(cleanup);

    it('opens the step that feeds this one and keeps Trigger info collapsed', () => {
        renderPanel([TRIGGER, STEP, INFO]);
        expect(screen.getByText('Result text')).toBeTruthy();
        expect(screen.queryByText('Trigger note')).toBeNull();
        expect(screen.queryByText('Ticket ref')).toBeNull();
    });

    it('also opens the nearest step WITH fields when the direct one never ran', () => {
        const NOT_RUN = { id: 's2', label: 'List mailboxes', kind: 'integration_action', basePath: 'steps.s2.output', sample: null, fields: [] };
        renderPanel([TRIGGER, STEP, NOT_RUN, INFO]);
        expect(screen.getByText('Result text')).toBeTruthy();
        expect(screen.queryByText('Trigger note')).toBeNull();
    });

    it('lists Trigger info after the steps, not before the nearest one', () => {
        renderPanel([TRIGGER, STEP, INFO]);
        const order = titles().map(t => (t.includes('Trigger info') ? 'info' : t.includes('Trigger (manual)') ? 'trigger' : 'step'));
        expect(order).toEqual(['step', 'trigger', 'info']);
    });

    it('opens the trigger and its info when the trigger IS the direct predecessor', () => {
        renderPanel([TRIGGER, INFO]);
        expect(screen.getByText('Trigger note')).toBeTruthy();
        expect(screen.getByText('Ticket ref')).toBeTruthy();
    });
});
