import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegexRule, RuleCollection } from './patternTypes';
import PatternsView from './PatternsView';
import { apiJson, saveRegexGuardrails } from '../api/guardrailsApi';

vi.mock('../api/guardrailsApi', () => ({
    apiJson: vi.fn(),
    saveRegexGuardrails: vi.fn(async () => ({})),
    generateRegexWithAi: vi.fn(),
}));
vi.mock('@/components/shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationMock'));

let latest: { rules: RegexRule[]; collections: RuleCollection[] } = { rules: [], collections: [] };

function Harness() {
    const [rules, setRules] = useState<RegexRule[]>([]);
    const [collections, setCollections] = useState<RuleCollection[]>([]);
    latest = { rules, collections };
    return <PatternsView rules={rules} setRules={setRules} collections={collections} setCollections={setCollections} />;
}

beforeEach(() => {
    vi.mocked(apiJson).mockResolvedValue({ tiers: { fast: { modelId: 'm' } } });
});
afterEach(cleanup);

describe('PatternsView', () => {
    it('adds a rule, groups it in a collection, and drops it from the collection on delete', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.type(screen.getByLabelText('Name'), 'IBAN');
        await user.type(screen.getByLabelText('Pattern…'), 'NL\\d{{2}');
        await user.click(screen.getByRole('button', { name: 'Add' }));
        expect(latest.rules).toHaveLength(1);
        expect(latest.rules[0]).toMatchObject({ name: 'IBAN', pattern: 'NL\\d{2}' });

        await user.type(screen.getByLabelText('New collection name…'), 'Banking{Enter}');
        expect(latest.collections).toHaveLength(1);
        await user.click(screen.getByRole('button', { name: 'Edit' }));
        await user.click(screen.getByRole('checkbox'));
        expect(latest.collections[0].ruleIds).toEqual([latest.rules[0].id]);

        await user.click(screen.getByRole('button', { name: 'Delete rule' }));
        expect(latest.rules).toHaveLength(0);
        expect(latest.collections[0].ruleIds).toEqual([]);
    });

    it('stages a starter set and saves the whole library', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const starter = screen.getByRole('region', { name: 'Start from a template' });
        await user.click(starter.querySelector('button') as HTMLButtonElement);
        expect(latest.rules.length).toBeGreaterThan(0);
        expect(latest.collections).toHaveLength(1);
        await user.click(screen.getByRole('button', { name: 'admin.guard_save_all' }));
        await waitFor(() => expect(saveRegexGuardrails).toHaveBeenCalledWith({ rules: latest.rules, collections: latest.collections }));
    });
});
