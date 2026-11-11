import { createRequire } from 'node:module';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import AiChecksField, { AI_CHECK_KINDS, AI_CHECK_SCRIPTS, AiReliabilityFields, type AiCheck } from './AiChecksField';

const require = createRequire(import.meta.url);
const reliability = require('../../../../../../../server/core/automationModel/aiStepReliabilitySpec.js');
const { LIMITS } = require('../../../../../../../server/appStudio/componentSpecs/limits.js');

/**
 * The answer checks of an AI step (schema v3): the editor writes the automation ai_step's
 * shapes, writes nothing for an empty list, and the reliability fields of a bare AI action
 * write nothing when left blank.
 */

function Controlled({ initial, spy }: { initial?: AiCheck[]; spy: (v: AiCheck[] | undefined) => void }) {
    const [value, setValue] = useState<AiCheck[] | undefined>(initial);
    return <AiChecksField value={value} onChange={(v) => { spy(v); setValue(v); }} />;
}

describe('AiChecksField', () => {
    it('mirrors the server vocabulary', () => {
        expect([...AI_CHECK_KINDS]).toEqual([...reliability.CHECK_KINDS]);
        expect([...AI_CHECK_SCRIPTS]).toEqual([...reliability.SCRIPTS]);
    });

    it('adds a check, changes its kind (dropping the other kind’s keys) and removes it to nothing', async () => {
        const user = userEvent.setup();
        const spy = vi.fn();
        render(<Controlled spy={spy} />);
        await user.click(screen.getByRole('button', { name: 'Add a check' }));
        expect(spy).toHaveBeenLastCalledWith([{ kind: 'allowedFrom', field: '' }]);

        await user.type(screen.getByRole('textbox', { name: 'Answer field of check 1' }), 'category');
        await user.type(screen.getByRole('textbox', { name: 'Data to compare with, check 1' }), 'vars.c');
        expect(spy).toHaveBeenLastCalledWith([{ kind: 'allowedFrom', field: 'category', ref: 'vars.c' }]);

        await user.selectOptions(screen.getByRole('combobox', { name: 'Kind of check 1' }), 'script');
        expect(spy).toHaveBeenLastCalledWith([{ kind: 'script', field: 'category', script: 'latin' }]);

        await user.click(screen.getByRole('button', { name: 'Remove check 1' }));
        expect(spy).toHaveBeenLastCalledWith(undefined);
    });

    it('an items check takes counts as numbers, and a blank count is no key', async () => {
        const user = userEvent.setup();
        const spy = vi.fn();
        render(<Controlled spy={spy} initial={[{ kind: 'items', field: 'rows', minItems: 2 }]} />);
        await user.type(screen.getByRole('spinbutton', { name: 'At most this many items, check 1' }), '5');
        expect(spy).toHaveBeenLastCalledWith([{ kind: 'items', field: 'rows', minItems: 2, maxItems: 5 }]);
        await user.clear(screen.getByRole('spinbutton', { name: 'At least this many items, check 1' }));
        expect(spy).toHaveBeenLastCalledWith([{ kind: 'items', field: 'rows', maxItems: 5 }]);
    });
});

describe('AiReliabilityFields (bare AI action)', () => {
    it('temperature is a number or nothing; repair rounds show only with checks, 0..max', async () => {
        const user = userEvent.setup();
        const set = vi.fn();
        const { rerender } = render(<AiReliabilityFields action={{}} set={set} disabled={false} />);
        expect(screen.queryByRole('combobox', { name: 'Repair rounds' })).toBeNull();
        await user.type(screen.getByRole('spinbutton', { name: 'Temperature' }), '0');
        expect(set).toHaveBeenLastCalledWith({ temperature: 0 });

        rerender(<AiReliabilityFields action={{ temperature: 0, checks: [{ kind: 'script', field: 'text', script: 'latin' }] }} set={set} disabled={false} />);
        await user.clear(screen.getByRole('spinbutton', { name: 'Temperature' }));
        expect(set).toHaveBeenLastCalledWith({ temperature: undefined });
        const rounds = screen.getByRole('combobox', { name: 'Repair rounds' });
        expect(rounds.querySelectorAll('option')).toHaveLength(LIMITS.MAX_AI_REPAIR_ROUNDS + 2);
        await user.selectOptions(rounds, '0');
        expect(set).toHaveBeenLastCalledWith({ repairRounds: 0 });
        await user.selectOptions(rounds, '');
        expect(set).toHaveBeenLastCalledWith({ repairRounds: undefined });
    });

    it('removing the last check also removes repairRounds', async () => {
        const user = userEvent.setup();
        const set = vi.fn();
        render(<AiReliabilityFields action={{ repairRounds: 2, checks: [{ kind: 'script', field: 'text', script: 'latin' }] }} set={set} disabled={false} />);
        await user.click(screen.getByRole('button', { name: 'Remove check 1' }));
        expect(set).toHaveBeenLastCalledWith({ checks: undefined, repairRounds: undefined });
    });
});
