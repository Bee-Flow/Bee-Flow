import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SettingsForm from './SettingsForm';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import { buildPatch } from './settings/formState';
import { defaultTriggerLabel, isGeneratedTriggerLabel, triggerTypeLabel } from './triggerLabels';
import type { ComponentProps } from 'react';
import userEvent from '@testing-library/user-event';

// BFSF-339 — switching a trigger's kind left the canvas node and this modal's
// own header both reading "Manual", because `label` was stored by the palette
// and never derived. The rename now follows the kind, unless the user named
// the node themselves.

const noIssues = { errors: [], warnings: [] };

function renderTrigger(step: ComponentProps<typeof SettingsForm>['step'], { onPatch = vi.fn() } = {}) {
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null} onPatch={onPatch} groups={[]} />
        </VariablePickerProvider>,
    );
    return { onPatch, ...utils };
}

const trigger = (over = {}) => ({ id: 'trg', type: 'trigger', kind: 'manual', label: 'Manual', output: {}, ...over });
const kindSelect = () => screen.getAllByRole('combobox')[0];
const nameField = () => screen.getByLabelText('Step name');

beforeEach(() => cleanup());

describe('triggerLabels', () => {
    it('keeps the node name and the type kicker distinct', () => {
        expect(defaultTriggerLabel('schedule')).toBe('Schedule');
        expect(triggerTypeLabel({ kind: 'schedule' })).toBe('Schedule trigger');
    });

    it('specialises the type kicker per app event', () => {
        expect(triggerTypeLabel({ kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }))
            .toBe('New email (Gmail)');
        expect(triggerTypeLabel({ kind: 'app_event', appEvent: { provider: 'zzz', event: 'nope' } }))
            .toBe('App-event trigger');
    });

    it('recognises every generated name, not just the current kind\'s', () => {
        // A trigger switched once already carries the PREVIOUS kind's name —
        // exactly the case the rewrite has to catch.
        expect(isGeneratedTriggerLabel('Manual')).toBe(true);
        expect(isGeneratedTriggerLabel('Webhook trigger')).toBe(true);
        expect(isGeneratedTriggerLabel('New email (Gmail)')).toBe(true);
        expect(isGeneratedTriggerLabel('')).toBe(true);
        expect(isGeneratedTriggerLabel('Every morning at 9')).toBe(false);
    });
});

describe('SettingsForm — trigger label follows the kind', () => {
    it('renames the node when the kind changes', async () => {
        const user = userEvent.setup();
        renderTrigger(trigger());
        expect((nameField() as HTMLInputElement).value).toBe('Manual');
        await user.selectOptions(kindSelect(), 'schedule');
        expect((nameField() as HTMLInputElement).value).toBe('Schedule');
    });

    it('leaves a hand-typed name alone', async () => {
        const user = userEvent.setup();
        renderTrigger(trigger());
        await user.clear(nameField());
        await user.type(nameField(), 'Every morning at 9');
        await user.selectOptions(kindSelect(), 'schedule');
        expect((nameField() as HTMLInputElement).value).toBe('Every morning at 9');
    });

    it('renames a trigger that already carries an earlier kind\'s name', async () => {
        const user = userEvent.setup();
        renderTrigger(trigger({ kind: 'schedule', label: 'Manual' }));
        await user.selectOptions(kindSelect(), 'webhook');
        expect((nameField() as HTMLInputElement).value).toBe('Webhook');
    });

    it('does not lock the generated name against the AI auto-namer', () => {
        // buildPatch marks a changed label as hand-picked; a name it generated
        // itself must not trip that, or the node freezes at whatever kind it
        // happened to pass through.
        const step = trigger();
        const patch = buildPatch(step, { label: 'Schedule', icon: '', kind: 'schedule' });
        expect(patch.label).toBe('Schedule');
        expect(patch.labelManual).toBeNull();
    });

    it('still locks a name the user typed', () => {
        const step = trigger();
        const patch = buildPatch(step, { label: 'Every morning at 9', icon: '', kind: 'schedule' });
        expect(patch.labelManual).toBe(true);
    });
});
