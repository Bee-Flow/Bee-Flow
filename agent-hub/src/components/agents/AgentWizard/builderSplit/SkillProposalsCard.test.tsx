/**
 * The skills turn of the refine rail: the NEW skills a refinement proposed,
 * before anything is stored. Per skill the person sees the name, one line of
 * what it does and static/dynamic, and can untick it, switch it, open it and
 * rename it; only what is ticked is handed to onAdd, with the changes made.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/builderSplit/SkillProposalsCard.test.tsx
 */
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

import SkillProposalsCard from './SkillProposalsCard';
import type { PlannedSkill } from '../plannedSkills';
import type { TranslateParams } from '@/hooks/useTranslation';

const t = (key: string | undefined, fallbackOrParams?: string | TranslateParams, paramsArg?: TranslateParams | null) => {
    const hasStringFallback = typeof fallbackOrParams === 'string';
    const params = hasStringFallback ? paramsArg : fallbackOrParams;
    let value = hasStringFallback ? fallbackOrParams : String(key);
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) value = value.split(`{${k}}`).join(String(v));
    }
    return value;
};

afterEach(() => cleanup());

const SKILLS: PlannedSkill[] = [
    {
        id: null, name: 'Reply drafts', description: 'Writes a draft reply', instructions: '', activation: 'dynamic',
        draft: { instructions: 'Use when a new e-mail needs an answer.', steps: [{ text: 'Read the e-mail' }], rulesV2: [{ polarity: 'never', text: 'Never send it yourself' }] },
    },
    { id: null, name: 'House style', description: 'Keeps the tone', instructions: 'Always', activation: 'static' },
];

describe('SkillProposalsCard', () => {
    it('shows name, one line and static/dynamic per skill', () => {
        render(<SkillProposalsCard t={t} skills={SKILLS} state="pending" onAdd={vi.fn()} onSkip={vi.fn()} />);
        const rows = screen.getAllByTestId('skill-proposal');
        expect(rows).toHaveLength(2);
        expect(within(rows[0]).getByText('Reply drafts')).toBeTruthy();
        expect(within(rows[0]).getByText('Writes a draft reply')).toBeTruthy();
        expect(within(rows[0]).getByRole('button', { name: 'When relevant' })).toBeTruthy();
        expect(within(rows[1]).getByRole('button', { name: 'Always on' })).toBeTruthy();
    });

    it('hands only the ticked skills to onAdd, with the switched activation and the new name', async () => {
        const user = userEvent.setup();
        const onAdd = vi.fn();
        render(<SkillProposalsCard t={t} skills={SKILLS} state="pending" onAdd={onAdd} onSkip={vi.fn()} />);
        const [first, second] = screen.getAllByTestId('skill-proposal');

        await user.click(within(second).getByRole('checkbox'));
        await user.click(within(first).getByRole('button', { name: 'When relevant' }));
        await user.click(within(first).getByRole('button', { name: 'Edit' }));
        const name = within(first).getByLabelText('Name');
        await user.clear(name);
        await user.type(name, 'Mail replies');

        await user.click(screen.getByRole('button', { name: 'Add selected skills (1)' }));
        expect(onAdd).toHaveBeenCalledTimes(1);
        const chosen = onAdd.mock.calls[0][0] as PlannedSkill[];
        expect(chosen).toHaveLength(1);
        expect(chosen[0]).toMatchObject({ name: 'Mail replies', activation: 'static', draft: SKILLS[0].draft });
    });

    it('opens a skill to show when to use it, its steps and rules; a plain one says it has none', async () => {
        const user = userEvent.setup();
        render(<SkillProposalsCard t={t} skills={SKILLS} state="pending" onAdd={vi.fn()} onSkip={vi.fn()} />);
        const [first, second] = screen.getAllByTestId('skill-proposal');
        await user.click(within(first).getByRole('button', { name: 'Show details' }));
        expect(within(first).getByText('Use when a new e-mail needs an answer.')).toBeTruthy();
        expect(within(first).getByText('Read the e-mail')).toBeTruthy();
        expect(within(first).getByText(/Never send it yourself/)).toBeTruthy();
        await user.click(within(second).getByRole('button', { name: 'Show details' }));
        expect(within(second).getByText('Instructions only. Add steps and rules in the skill editor.')).toBeTruthy();
    });

    it('"Not now" calls onSkip; a finished turn shows its outcome and no buttons', async () => {
        const user = userEvent.setup();
        const onSkip = vi.fn();
        const { rerender } = render(<SkillProposalsCard t={t} skills={SKILLS} state="pending" onAdd={vi.fn()} onSkip={onSkip} />);
        await user.click(screen.getByRole('button', { name: 'Not now' }));
        expect(onSkip).toHaveBeenCalledTimes(1);

        rerender(<SkillProposalsCard t={t} skills={SKILLS} state="added" addedCount={2} onAdd={vi.fn()} onSkip={onSkip} />);
        expect(screen.getByText('Added 2 skill(s) to this agent.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
    });

    it('a failed add can be tried again', () => {
        render(<SkillProposalsCard t={t} skills={SKILLS} state="failed" onAdd={vi.fn()} onSkip={vi.fn()} />);
        expect(screen.getByText('The skills could not be added. Try again.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Add selected skills (2)' })).toBeTruthy();
    });
});
