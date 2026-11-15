// The worked examples under the safety limit: the organisation's own models
// (the server picks its largest and smallest context window), each line built
// from translatable words rather than a template literal; a neutral size when
// no model is configured; a custom tier keeps the admin's own label. (The text matcher collapses the spaces around
// the separator, so the expectations use single spaces.)

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { jsonAnswer } from '@/test/http';
import OrgAiContextEditor from './OrgAiContextEditor';

afterEach(() => vi.unstubAllGlobals());

function stubServer(contextWindowExamples: unknown[]) {
    vi.stubGlobal('fetch', vi.fn(async () => jsonAnswer({
        compactionEnabled: false,
        compactionThreshold: 16,
        recentWindow: 8,
        contextBudgetPercent: 75,
        configured: false,
        contextBudgetRange: { min: 25, max: 95 },
        contextWindowExamples,
    })));
}

describe('OrgAiContextEditor examples', () => {
    it('names the organisation\'s own tiers and models', async () => {
        stubServer([
            { label: 'Think (Big Model)', contextWindow: 1_000_000, kind: 'tier', tierKey: 'thinking', model: 'Big Model' },
            { label: 'Fast (small-local)', contextWindow: 32_000, kind: 'tier', tierKey: 'fast', model: 'small-local' },
        ]);
        render(withQueryClient(<OrgAiContextEditor orgId="org1" />));
        expect(await screen.findByText(
            `Think (Big Model): about ${(750_000).toLocaleString()} tokens · Fast (small-local): about ${(24_000).toLocaleString()} tokens`,
        )).toBeInTheDocument();
        expect(screen.queryByText(/Claude/)).not.toBeInTheDocument();
    });

    it('shows a neutral size when no model is configured, and a custom tier under its own label', async () => {
        stubServer([
            { label: 'A 1,000,000-token model', contextWindow: 1_000_000, kind: 'generic', tierKey: null, model: null },
            { label: 'Long documents (x-model)', contextWindow: 200_000, kind: 'custom', tierKey: null, model: 'x-model' },
        ]);
        render(withQueryClient(<OrgAiContextEditor orgId="org1" />));
        expect(await screen.findByText(
            `A ${(1_000_000).toLocaleString()}-token model: about ${(750_000).toLocaleString()} tokens · Long documents (x-model): about ${(150_000).toLocaleString()} tokens`,
        )).toBeInTheDocument();
    });

    it('an older server that sends only a label still renders it', async () => {
        stubServer([{ label: 'Some model', contextWindow: 400_000 }]);
        render(withQueryClient(<OrgAiContextEditor orgId="org1" />));
        expect(await screen.findByText(`Some model: about ${(300_000).toLocaleString()} tokens`)).toBeInTheDocument();
    });
});
