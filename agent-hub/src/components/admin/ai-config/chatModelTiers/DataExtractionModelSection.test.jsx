import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The admin section for the routine Extract data step's model. Pinned:
 *
 *   1. unset shows the Fast-tier fallback label — an empty picker must never
 *      read as "no extraction";
 *   2. the picker's choice reaches setDataExtractionModel and Save reaches
 *      saveDataExtractionModel — the same prop contract as the memory section;
 *   3. a saved/failed message renders, and Save is disabled while saving;
 *   4. the copy says what the key decides: every Data extraction step, whatever
 *      tier the routine uses.
 */

vi.mock('../../../../utils/modelMeta', () => ({
    getModelDisplayName: (m) => (m.id === 'qwen2.5:1.5b' ? 'Qwen 2.5 1.5B' : m.id),
}));

vi.mock('../../shared/SearchableModelSelect', () => ({
    default: ({ label, onChange }) => (
        <button type="button" data-testid="picker" onClick={() => onChange({ modelId: 'qwen2.5:1.5b' })}>{label}</button>
    ),
}));

import DataExtractionModelSection from './DataExtractionModelSection';

const chatModels = [
    { id: 'qwen2.5:1.5b', providerName: 'Ollama' },
    { id: 'gpt-5-mini', providerName: 'OpenAI' },
];

const renderSection = (over = {}) => {
    const props = {
        dataExtractionModel: '', setDataExtractionModel: vi.fn(), dataExtractionModelSaving: false, dataExtractionModelMessage: null,
        saveDataExtractionModel: vi.fn(), chatModels, byProvider: { Ollama: [chatModels[0]], OpenAI: [chatModels[1]] },
        hiddenModelIds: [], toggleHiddenModel: vi.fn(),
        ...over,
    };
    render(<DataExtractionModelSection {...props} />);
    return props;
};

afterEach(cleanup);

describe('DataExtractionModelSection', () => {
    it('unset reads as the Fast-tier fallback, never as off, and says whose model this is', () => {
        renderSection();
        expect(screen.getByRole('heading', { name: 'Data Extraction Model' })).toBeTruthy();
        expect(screen.getByTestId('picker').textContent).toBe('— Use Fast tier model —');
        expect(screen.getByText(/every Data extraction step in a routine runs on, whatever tier/)).toBeTruthy();
    });

    it('a picked model shows by display name (id when there is none) and reaches setDataExtractionModel; Save reaches saveDataExtractionModel', () => {
        renderSection({ dataExtractionModel: 'qwen2.5:1.5b' });
        expect(screen.getByTestId('picker').textContent).toBe('Qwen 2.5 1.5B');
        cleanup();
        renderSection({ dataExtractionModel: 'gpt-5-mini' });
        expect(screen.getByTestId('picker').textContent).toBe('gpt-5-mini');
        cleanup();
        const props = renderSection({ dataExtractionModel: 'qwen2.5:1.5b' });
        fireEvent.click(screen.getByTestId('picker'));
        expect(props.setDataExtractionModel).toHaveBeenCalledWith('qwen2.5:1.5b');
        fireEvent.click(screen.getByRole('button', { name: 'Save Data Extraction Model' }));
        expect(props.saveDataExtractionModel).toHaveBeenCalledTimes(1);
    });

    it('shows the result message and disables Save while saving', () => {
        renderSection({ dataExtractionModelMessage: { type: 'success', text: 'Data extraction model saved' } });
        expect(screen.getByText('Data extraction model saved')).toBeTruthy();
        cleanup();
        renderSection({ dataExtractionModelSaving: true });
        const btn = screen.getByRole('button', { name: 'Saving...' });
        expect(btn.disabled).toBe(true);
    });
});
