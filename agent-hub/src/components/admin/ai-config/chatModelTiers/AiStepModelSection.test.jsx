import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The admin section for the TEMPORARY ai_step model override. Pinned:
 *
 *   1. unset shows the Fast-tier fallback label — an empty picker must never
 *      read as "no extraction";
 *   2. the picker's choice reaches setAiStepModel and Save reaches
 *      saveAiStepModel — the same prop contract as TitleModelSection;
 *   3. a saved/failed message renders, and Save is disabled while saving.
 */

// Display names come from a registry; pin one so the "display name when it
// differs from the id, else the id" rule is what the test reads.
vi.mock('../../../../utils/modelMeta', () => ({
    getModelDisplayName: (m) => (m.id === 'qwen2.5:1.5b' ? 'Qwen 2.5 1.5B' : m.id),
}));

vi.mock('../../shared/SearchableModelSelect', () => ({
    default: ({ label, onChange }) => (
        <button type="button" data-testid="picker" onClick={() => onChange({ modelId: 'qwen2.5:1.5b' })}>{label}</button>
    ),
}));

import AiStepModelSection from './AiStepModelSection';

const chatModels = [
    { id: 'qwen2.5:1.5b', providerName: 'Ollama' },
    { id: 'gpt-5-mini', providerName: 'OpenAI' },
];

const renderSection = (over = {}) => {
    const props = {
        aiStepModel: '', setAiStepModel: vi.fn(), aiStepModelSaving: false, aiStepModelMessage: null,
        saveAiStepModel: vi.fn(), chatModels, byProvider: { Ollama: [chatModels[0]], OpenAI: [chatModels[1]] },
        hiddenModelIds: [], toggleHiddenModel: vi.fn(),
        ...over,
    };
    render(<AiStepModelSection {...props} />);
    return props;
};

afterEach(cleanup);

describe('AiStepModelSection', () => {
    it('unset reads as the step tier fallback, never as off', () => {
        renderSection();
        expect(screen.getByRole('heading', { name: 'AI Step Model (temporary override)' })).toBeTruthy();
        expect(screen.getByTestId('picker').textContent).toBe("— Use the step's own tier —");
    });

    it('a picked model shows by display name (id when there is none) and reaches setAiStepModel; Save reaches saveAiStepModel', () => {
        const props = renderSection({ aiStepModel: 'qwen2.5:1.5b' });
        expect(screen.getByTestId('picker').textContent).toBe('Qwen 2.5 1.5B');
        cleanup();
        renderSection({ aiStepModel: 'gpt-5-mini' });
        expect(screen.getByTestId('picker').textContent).toBe('gpt-5-mini');
        cleanup();
        const propsAgain = renderSection({ aiStepModel: 'qwen2.5:1.5b' });
        Object.assign(props, propsAgain);
        fireEvent.click(screen.getByTestId('picker'));
        expect(props.setAiStepModel).toHaveBeenCalledWith('qwen2.5:1.5b');
        fireEvent.click(screen.getByRole('button', { name: 'Save AI Step Model' }));
        expect(props.saveAiStepModel).toHaveBeenCalledTimes(1);
    });

    it('shows the result message and disables Save while saving', () => {
        renderSection({ aiStepModelMessage: { type: 'success', text: 'AI step model saved' } });
        expect(screen.getByText('AI step model saved')).toBeTruthy();
        cleanup();
        renderSection({ aiStepModelSaving: true });
        const btn = screen.getByRole('button', { name: 'Saving...' });
        expect(btn.disabled).toBe(true);
    });
});
