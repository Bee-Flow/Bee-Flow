// The global feature switches: in their own group, or bare inside a page whose
// frame already names them (Licence & features > Feature switches), so two
// headings are never stacked.
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FeatureKillSwitches from './FeatureKillSwitches';
import { withQueryClient } from '@/test/queryWrapper';

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ notebooksEnabled: false }), { status: 200, headers: { 'content-type': 'application/json' } })));
});

describe('FeatureKillSwitches', () => {
    it('bare: the switches and their note, without a heading', async () => {
        render(withQueryClient(<FeatureKillSwitches bare />));
        expect(await screen.findByRole('switch', { name: 'Notebooks' })).not.toBeChecked();
        expect(screen.getByRole('switch', { name: 'Projects' })).toBeChecked();
        expect(screen.getByTestId('feature-switches')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Feature switches' })).toBeNull();
    });

    it('on its own: one group heading', async () => {
        render(withQueryClient(<FeatureKillSwitches />));
        expect(await screen.findByRole('heading', { name: 'Feature switches' })).toBeInTheDocument();
    });
});
