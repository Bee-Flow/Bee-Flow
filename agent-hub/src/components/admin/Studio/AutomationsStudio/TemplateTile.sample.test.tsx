import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateCard } from '../../../../api/queries/automation/templates';
import { parseTemplates } from '../../../../api/queries/automation/templates';

vi.mock('../../../icons/AppIcon', () => ({ default: () => null }));

import TemplateTile from './TemplateTile';

const card = (over: Partial<TemplateCard> = {}): TemplateCard => ({
    id: 'table-sales-by-month', title: 'Sales by month and product', description: 'Upload an order list.', category: 'Reports', icon: null,
    tags: [], source: 'builtin', createdByName: null, mine: false, createdAt: null, requiredIntegrations: [], triggerReadiness: 'ready',
    triggerKind: 'form', triggerApp: null, stepCount: 5, ...over,
});

afterEach(cleanup);

describe('TemplateTile sample data', () => {
    it('offers the made-up file as a plain download', () => {
        render(<TemplateTile tmpl={card({ sampleData: { filename: 'sales-by-month.csv', url: '/automation-samples/sales-by-month.csv' } })} onUse={vi.fn()} />);
        const link = screen.getByRole('link', { name: /Sample data/ });
        expect(link.getAttribute('href')).toBe('/automation-samples/sales-by-month.csv');
        expect(link.getAttribute('download')).toBe('sales-by-month.csv');
        expect(link.getAttribute('title')).toBe('Download made-up sample data to try this template.');
    });

    it('does not start the template when the link is used', async () => {
        const user = userEvent.setup();
        const onUse = vi.fn();
        render(<TemplateTile tmpl={card({ sampleData: { filename: 'a.csv', url: '/automation-samples/a.csv' } })} onUse={onUse} />);
        const link = screen.getByRole('link', { name: /Sample data/ });
        link.addEventListener('click', (e) => e.preventDefault());
        await user.click(link);
        expect(onUse).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Use template' }));
        expect(onUse).toHaveBeenCalledTimes(1);
    });

    it('shows no link for a template without sample data', () => {
        render(<TemplateTile tmpl={card()} onUse={vi.fn()} />);
        expect(screen.queryByRole('link')).toBeNull();
        render(<TemplateTile tmpl={card({ sampleData: null })} onUse={vi.fn()} />);
        expect(screen.queryByRole('link')).toBeNull();
    });
});

describe('parseTemplates and sampleData', () => {
    const wire = (sampleData: unknown) => parseTemplates({ templates: [{ id: 'a', title: 'A', sampleData }] })[0];

    it('keeps a same-origin sample file and drops anything else', () => {
        expect(wire({ filename: 'a.csv', url: '/automation-samples/a.csv' }).sampleData).toEqual({ filename: 'a.csv', url: '/automation-samples/a.csv' });
        expect(wire({ filename: 'a.csv', url: 'https://elsewhere.test/a.csv' }).sampleData).toBeNull();
        expect(wire({ filename: 'a.csv', url: '//elsewhere.test/a.csv' }).sampleData).toBeNull();
        expect(wire({ filename: '', url: '/x.csv' }).sampleData).toBeNull();
        expect(wire(undefined).sampleData).toBeNull();
    });
});
