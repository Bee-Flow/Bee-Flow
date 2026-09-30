// The four AI modes, what the organisation allows, and how a notice and an
// Auto chat read in the chat list.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { expect, it, vi } from 'vitest';
import type { TeamChatAiMode } from '../../../../api/queries/projectChats';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import AiModeSelector, { aiModeBadge, modeAllowed } from './AiModeSelector';
import { noticeExcerpt } from './SystemNotice';
import { joinReasonText } from './AutoAnswerNote';

const t: TranslateFn = (_key, fallback, params) => String(fallback ?? '').replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? ''));

it('offers off, mention, auto and always, and reports the pick', async () => {
    const onChange = vi.fn();
    render(<AiModeSelector value="mention" onChange={onChange} />);
    expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['Off', 'On mention', 'Auto', 'Always']);
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Auto' }));
    expect(onChange).toHaveBeenCalledWith('auto');
});

it('a mode the organisation does not allow is shown but cannot be picked, unless the chat already has it', async () => {
    const onChange = vi.fn();
    const policy = { autoAllowed: false, alwaysAllowed: false };
    const { rerender } = render(<AiModeSelector value="mention" onChange={onChange} policy={policy} />);
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Always' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Auto' }));
    expect(onChange).not.toHaveBeenCalled();
    rerender(<AiModeSelector value="auto" onChange={onChange} policy={policy} />);
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeEnabled();
    const allowed = (mode: TeamChatAiMode) => modeAllowed(mode, 'off', null);
    expect(['off', 'mention', 'auto', 'always'].every(m => allowed(m as TeamChatAiMode))).toBe(true);
});

it('reads the mode as a badge, and a read-only selector shows only that', () => {
    render(<AiModeSelector value="auto" onChange={vi.fn()} readOnly />);
    expect(screen.getByTestId('team-chat-ai-mode-readonly')).toHaveTextContent('AI joins when it can help');
    expect(aiModeBadge('auto', t)).toBe('AI joins when it can help');
});

it('a notice and a join reason in words', () => {
    expect(noticeExcerpt('ai_auto_on', t)).toBe('The AI now joins by itself');
    expect(noticeExcerpt('something_new', t)).toBe('The chat settings changed');
    expect(joinReasonText('unanswered_question', t)).toBe('a question had gone unanswered');
    expect(joinReasonText('summary_or_next_steps_requested', t)).toBe('someone asked for a summary or next steps');
    expect(joinReasonText(null, t)).toBe('it could help here');
});
