import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SettingsForm from './SettingsForm';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import type { ComponentProps } from 'react';
import userEvent from '@testing-library/user-event';

// BFSF-345 — the Wait step's duration field.
//
// Two of the three defects were functional, not cosmetic: clamping on every
// keystroke made the field impossible to clear-and-retype, and the unit select
// carried `w-full w-auto` (two utilities racing for one property) which let it
// eat the row and collapse the number input to its spinner.

const noIssues = { errors: [], warnings: [] };

function renderWait(step: ComponentProps<typeof SettingsForm>['step'], { onPatch = vi.fn() } = {}) {
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null} onPatch={onPatch} groups={[]} />
        </VariablePickerProvider>,
    );
    return { onPatch, ...utils };
}

const waitStep = (seconds: number): ComponentProps<typeof SettingsForm>['step'] => ({ id: 'w1', type: 'wait', label: 'Wait', seconds });
const duration = () => screen.getByLabelText('Wait duration');
const unit = () => screen.getByLabelText('Duration unit');

beforeEach(() => cleanup());

describe('SettingsForm — wait duration', () => {
    it('lets you clear the field and type a new value without snapping back to 1', async () => {
        const user = userEvent.setup();
        renderWait(waitStep(5));
        expect((duration() as HTMLInputElement).value).toBe('5');

        // The old handler read Number('') === 0 — not NaN, so its guard never
        // fired — and clamped it straight back to 1 mid-edit.
        await user.clear(duration());
        expect((duration() as HTMLInputElement).value).toBe('');

        await user.clear(duration());
        await user.type(duration(), '90');
        expect((duration() as HTMLInputElement).value).toBe('90');
    });

    it('restores the stored value when the field is left empty', async () => {
        const user = userEvent.setup();
        renderWait(waitStep(30));
        await user.clear(duration());
        fireEvent.blur(duration());
        expect((duration() as HTMLInputElement).value).toBe('30');
    });

    it('keeps the number when the unit changes instead of rounding it to zero', async () => {
        const user = userEvent.setup();
        // 5 seconds shown as hours used to render 0 — below the field's own min.
        renderWait(waitStep(5));
        await user.selectOptions(unit(), 'hours');
        expect((duration() as HTMLInputElement).value).toBe('5');
        expect(Number((duration() as HTMLInputElement).value)).toBeGreaterThanOrEqual(Number((duration() as HTMLInputElement).min));
    });

    it('gives the number field and the unit select their own width', () => {
        renderWait(waitStep(5));
        // `w-full` on the select is what made it swallow the whole row: it beats
        // a co-present `w-auto` by stylesheet order, not class order.
        expect(unit().className).not.toMatch(/\bw-full\b/);
        expect(unit().className).toMatch(/\bw-auto\b/);
        expect(duration().className).toMatch(/\bflex-1\b/);
    });

    it('caps the stored value at 24 hours', async () => {
        const user = userEvent.setup();
        renderWait(waitStep(60));
        await user.selectOptions(unit(), 'hours');
        // Typing is never fought mid-edit…
        await user.clear(duration());
        await user.type(duration(), '48');
        expect((duration() as HTMLInputElement).value).toBe('48');
        // …but dropping the raw text reveals the clamped, stored value.
        fireEvent.blur(duration());
        expect((duration() as HTMLInputElement).value).toBe('24');
    });
});
