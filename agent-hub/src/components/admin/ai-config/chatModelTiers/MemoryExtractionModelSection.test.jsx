import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The admin section for the dedicated memory-extraction model. Pinned:
 *
 *   1. unset shows the Fast-tier fallback label — an empty picker must never
 *      read as "no extraction";
 *   2. the picker's choice reaches setMemoryModel and Save reaches
 *      saveMemoryModel — the same prop contract as TitleModelSection;
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

import MemoryExtractionModelSection from './MemoryExtractionModelSection';

const chatModels = [
    { id: 'qwen2.5:1.5b', providerName: 'Ollama' },
    { id: 'gpt-5-mini', providerName: 'OpenAI' },
];

const renderSection = (over = {}) => {
    const props = {
        memoryModel: '', setMemoryModel: vi.fn(), memoryModelSaving: false, memoryModelMessage: null,
        saveMemoryModel: vi.fn(), chatModels, byProvider: { Ollama: [chatModels[0]], OpenAI: [chatModels[1]] },
        hiddenModelIds: [], toggleHiddenModel: vi.fn(),
        ...over,
    };
    render(<MemoryExtractionModelSection {...props} />);
    return props;
};

afterEach(cleanup);

describe('MemoryExtractionModelSection', () => {
    it('unset reads as the Fast-tier fallback, never as "off"', () => {
        renderSection();
        expect(screen.getByRole('heading', { name: 'Memory Extraction Model' })).toBeTruthy();
        expect(screen.getByTestId('picker').textContent).toBe('— Use Fast tier model —');
    });

    it('a picked model shows by display name (id when there is none) and reaches setMemoryModel; Save reaches saveMemoryModel', () => {
        const props = renderSection({ memoryModel: 'qwen2.5:1.5b' });
        expect(screen.getByTestId('picker').textContent).toBe('Qwen 2.5 1.5B');
        cleanup();
        renderSection({ memoryModel: 'gpt-5-mini' });
        expect(screen.getByTestId('picker').textContent).toBe('gpt-5-mini');
        cleanup();
        const propsAgain = renderSection({ memoryModel: 'qwen2.5:1.5b' });
        Object.assign(props, propsAgain);
        fireEvent.click(screen.getByTestId('picker'));
        expect(props.setMemoryModel).toHaveBeenCalledWith('qwen2.5:1.5b');
        fireEvent.click(screen.getByRole('button', { name: 'Save Memory Extraction Model' }));
        expect(props.saveMemoryModel).toHaveBeenCalledTimes(1);
    });

    it('shows the result message and disables Save while saving', () => {
        renderSection({ memoryModelMessage: { type: 'success', text: 'Memory extraction model saved' } });
        expect(screen.getByText('Memory extraction model saved')).toBeTruthy();
        cleanup();
        renderSection({ memoryModelSaving: true });
        const btn = screen.getByRole('button', { name: 'Saving...' });
        expect(btn.disabled).toBe(true);
    });
});
