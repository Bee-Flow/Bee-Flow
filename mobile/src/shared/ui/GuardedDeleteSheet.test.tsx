/**
 * The guard sheet, rendered for real.
 *
 * What it must never do is present an incomplete answer as a complete one, or
 * let the red button through before the name was typed against a list of what
 * breaks. Both are sentences and a disabled state, so both are rendered here
 * rather than reasoned about.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/shared/ui/GuardedDeleteSheet.test.tsx
 */

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { DeleteGuard } from '@/core/api/deleteGuard';
import { ThemeProvider } from '@/core/theme/ThemeProvider';

import { GuardedDeleteSheet, needsTypedName, typedNameMatches } from './GuardedDeleteSheet';

// The sheet pads for the gesture bar; with no native module to measure it, the
// provider is handed a zero inset up front instead.
const METRICS = {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

// The Modal mounts from cold under full-suite load; see AuthShell.test.tsx.
// `render` and `fireEvent` are both async in @testing-library/react-native 14:
// an un-awaited changeText has not re-rendered by the next line.
jest.setTimeout(30_000);

const guard = (over: Partial<DeleteGuard> = {}): DeleteGuard => ({
    blocked: true,
    usage: [],
    unchecked: [],
    readable: true,
    ...over,
});

async function draw(props: Partial<React.ComponentProps<typeof GuardedDeleteSheet>> = {}) {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await render(
        <SafeAreaProvider initialMetrics={METRICS}>
            <ThemeProvider>
                <GuardedDeleteSheet
                    guard={guard()}
                    name="Weekly sync"
                    onConfirm={onConfirm}
                    onCancel={onCancel}
                    {...props}
                />
            </ThemeProvider>
        </SafeAreaProvider>,
    );
    return { onConfirm, onCancel };
}

const confirmButton = () => screen.getByTestId('guarded-delete-confirm');

describe('needsTypedName', () => {
    it('asks when something was found, when the answer was unreadable, or when the caller insists', () => {
        expect(needsTypedName(guard({ usage: [{ kind: 'agent' }] }), 'X')).toBe(true);
        expect(needsTypedName(guard({ readable: false }), 'X')).toBe(true);
        expect(needsTypedName(guard({ unchecked: ['notebook'] }), 'X', true)).toBe(true);
    });

    it('does not ask when only a kind went unchecked and the caller did not insist', () => {
        // DangerZone's rule on the web: the name is the price of breaking
        // something FOUND. The unchecked kinds are still named on the sheet.
        expect(needsTypedName(guard({ unchecked: ['template'] }), 'X')).toBe(false);
    });

    it('never asks for an empty name — a button that cannot enable is a dead end', () => {
        expect(needsTypedName(guard({ usage: [{ kind: 'agent' }] }), '  ', true)).toBe(false);
    });

    it('matches trimmed, case kept', () => {
        expect(typedNameMatches('Weekly sync ', 'Weekly sync')).toBe(true);
        expect(typedNameMatches('weekly sync', 'Weekly sync')).toBe(false);
    });
});

describe('GuardedDeleteSheet', () => {
    it('keeps the button asleep until the recording title is typed', async () => {
        const { onConfirm } = await draw({ guard: guard({ unchecked: ['notebook'] }), requireName: true });

        await fireEvent.press(confirmButton());
        expect(onConfirm).not.toHaveBeenCalled();
        expect(confirmButton().props.accessibilityState).toMatchObject({ disabled: true });

        await fireEvent.changeText(screen.getByTestId('guarded-delete-name'), 'Weekly sync');
        await fireEvent.press(confirmButton());
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('names what could not be checked and never says "nothing uses this"', async () => {
        await draw({ guard: guard({ unchecked: ['notebook', 'automation'] }), requireName: true });
        expect(screen.getByText(/not everything could be checked/)).toBeTruthy();
        expect(screen.getByText('Could not be checked: notebooks, routines.')).toBeTruthy();
        expect(screen.queryByText(/Nothing uses this\./)).toBeNull();
    });

    it('lists what was found, and says the list is incomplete when a kind was not checked', async () => {
        await draw({
            guard: guard({
                usage: [
                    { kind: 'agent', id: 'a1', title: 'Helpdesk' },
                    { kind: 'automation', id: 'r1', title: null, foreign: true },
                ],
                unchecked: ['template'],
            }),
            name: 'Policies',
        });
        expect(screen.getByText('2 things use this and will start failing:')).toBeTruthy();
        expect(screen.getByText('Helpdesk')).toBeTruthy();
        // A row owned by someone else arrives untitled; its kind stands in.
        expect(screen.getByText('routine')).toBeTruthy();
        expect(screen.getByText(/not the whole story/)).toBeTruthy();
        expect(screen.getByText('Could not be checked: templates.')).toBeTruthy();
        // Something was found, so the name is asked for even without requireName.
        expect(screen.getByTestId('guarded-delete-name')).toBeTruthy();
    });

    it('tells two rows for the same routine apart by their site', async () => {
        // skillStore.listSkillUsage sends one row per AI step, under the
        // routine's id: two steps, two rows, one id.
        await draw({
            guard: guard({
                usage: [
                    { kind: 'automation', id: 'r1', title: 'Weekly digest', siteLabel: 'step 2', stepId: 's2' },
                    { kind: 'automation', id: 'r1', title: 'Weekly digest', siteLabel: 'step 5', stepId: 's5' },
                    { kind: 'datatable', id: 't1', title: 'Leads' },
                ],
            }),
            name: 'Summarise',
        });
        expect(screen.getAllByText('Weekly digest')).toHaveLength(2);
        expect(screen.getByText('routine · step 2')).toBeTruthy();
        expect(screen.getByText('routine · step 5')).toBeTruthy();
        expect(screen.getByText('table')).toBeTruthy();
    });

    it('lets an unchecked-only refusal through without typing when the caller did not insist', async () => {
        const { onConfirm } = await draw({ guard: guard({ unchecked: ['support'] }), name: 'Policies' });
        expect(screen.queryByTestId('guarded-delete-name')).toBeNull();
        await fireEvent.press(confirmButton());
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('says so when the check did not answer at all', async () => {
        await draw({ guard: guard({ readable: false, unchecked: ['agent', 'automation'] }) });
        expect(screen.getByText(/did not answer at all/)).toBeTruthy();
    });
});
