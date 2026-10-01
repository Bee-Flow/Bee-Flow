import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import SourcePanelTs from './SourcePanel';

const SourcePanel = SourcePanelTs as unknown as ComponentType<Record<string, unknown>>;

/**
 * Round 4 (artboards 4a/4b/4c): the Comes-in column shows at most six fields
 * per step with a human name, the used ones on top with a pill, the system
 * fields behind "Technical details", and a hint for a manual start.
 */
const KEYS = ['file_name', 'path', 'folder', 'size', 'added_by', 'added_at', 'owner_name', 'kind', 'etag', 'provider'];
const GROUP = {
    id: 'trg', label: 'New file in /Invoices', kind: 'trigger', basePath: 'trigger.output',
    sample: Object.fromEntries(KEYS.map(k => [k, `v-${k}`])),
    fields: KEYS.map(k => ({ key: k, path: `trigger.output.${k}`, sample: `v-${k}` })),
};

const renderPanel = (props: Record<string, unknown> = {}) => render(
    <SourcePanel groups={[GROUP]} previewSample={null} onPick={vi.fn()} {...props} />,
);

describe('SourcePanel — round 4 defaults', () => {
    beforeEach(cleanup);

    it('names fields for people and caps a step at six, with "n more"', async () => {
        renderPanel();
        const block = screen.getByTestId('input-group');
        expect(within(block).getByText('File name')).toBeTruthy();
        expect(within(block).getByText('Added by')).toBeTruthy();
        expect(within(block).queryByText('Owner name')).toBeNull();
        await userEvent.click(screen.getByTestId('input-more-fields'));
        expect(within(block).getByText('Owner name')).toBeTruthy();
    });

    it('folds the system fields under Technical details', async () => {
        renderPanel();
        const tech = screen.getByTestId('input-technical');
        expect(tech.textContent).toContain('Technical details');
        expect(tech.textContent).toContain('3 fields · kind, etag, provider');
        expect(screen.queryByText('Etag')).toBeNull();
        await userEvent.click(tech);
        expect(screen.getByText('Etag')).toBeTruthy();
    });

    it('puts a used field first, with a quiet "used" pill', () => {
        renderPanel({ usedPaths: new Set(['trigger.output.size']) });
        const block = screen.getByTestId('input-group');
        const rows = within(block).getAllByRole('button').filter(el => el.getAttribute('draggable') === 'true');
        // rows[0] is the step header; the first field row is the used one.
        expect(rows[1].textContent).toContain('Size');
        expect(within(rows[1]).getByTestId('field-used-pill').textContent).toBe('used');
    });

    it('opens search from an icon', async () => {
        renderPanel();
        expect(screen.queryByLabelText('Search input fields')).toBeNull();
        await userEvent.click(screen.getByLabelText('Search fields'));
        await userEvent.type(screen.getByLabelText('Search input fields'), 'etag');
        // A search shows every match, technical ones included.
        expect(screen.getByText('Etag')).toBeTruthy();
    });

    it('explains a manual start and offers to ask a question at the start', async () => {
        const onAdd = vi.fn();
        renderPanel({ manualStart: true, onAddStartQuestion: onAdd });
        expect(screen.getByTestId('input-manual-hint').textContent).toContain("A manual start passes little, that's normal.");
        await userEvent.click(screen.getByRole('button', { name: /Add a question to the start/ }));
        expect(onAdd).toHaveBeenCalled();
    });
});
