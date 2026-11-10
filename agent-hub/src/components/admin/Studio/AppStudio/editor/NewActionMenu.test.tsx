import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import NewActionMenu from './NewActionMenu';
import { KIND_OPTIONS } from '../inspector/actionKindCatalog';
import type { AppDefinition } from '../inspector/appDefinition';


const DEF = {
    schemaVersion: 2,
    meta: { name: 'T' },
    theme: {},
    homeScreenId: 'scr_t',
    screens: [{ id: 'scr_t', name: 'Home', sections: [] }],
    actions: {},
} as unknown as AppDefinition;

describe('Logic tab: add an action of any kind', () => {
    it('offers every kind the catalogue knows, a sequence included', async () => {
        const user = userEvent.setup();
        const { getByRole, getAllByRole } = render(<NewActionMenu definition={DEF} onCommit={vi.fn()} onPickAutomation={vi.fn()} />);
        await user.click(getByRole('button', { name: /Add an action/ }));
        expect(getAllByRole('menuitem')).toHaveLength(KIND_OPTIONS.length);
        expect(getAllByRole('menuitem').some((m) => /Several steps/.test(m.textContent || ''))).toBe(true);
    });

    it('a sequence is created with the kind default and nothing pointing at it', async () => {
        const user = userEvent.setup();
        const onCommit = vi.fn();
        const { getByRole, getByText } = render(<NewActionMenu definition={DEF} onCommit={onCommit} onPickAutomation={vi.fn()} />);
        await user.click(getByRole('button', { name: /Add an action/ }));
        await user.click(getByText('Several steps (a flow)'));
        expect(onCommit).toHaveBeenCalledTimes(1);
        const next = onCommit.mock.calls[0][0] as AppDefinition;
        expect(Object.values(next.actions || {})).toEqual([{ kind: 'sequence', steps: [] }]);
        expect(JSON.stringify(next.screens)).toBe(JSON.stringify(DEF.screens));
    });

    it('a message action is created with its defaults', async () => {
        const user = userEvent.setup();
        const onCommit = vi.fn();
        const { getByRole, getByText } = render(<NewActionMenu definition={DEF} onCommit={onCommit} onPickAutomation={vi.fn()} />);
        await user.click(getByRole('button', { name: /Add an action/ }));
        await user.click(getByText('Show a message'));
        expect(Object.values((onCommit.mock.calls[0][0] as AppDefinition).actions || {})).toEqual([{ kind: 'toast', message: '', tone: 'info' }]);
    });

    it('"Run automation" keeps its own flow and creates nothing here', async () => {
        const user = userEvent.setup();
        const onCommit = vi.fn();
        const onPickAutomation = vi.fn();
        const { getByRole, getAllByText } = render(<NewActionMenu definition={DEF} onCommit={onCommit} onPickAutomation={onPickAutomation} />);
        await user.click(getByRole('button', { name: /Add an action/ }));
        await user.click(getAllByText('Run automation')[0]);
        expect(onPickAutomation).toHaveBeenCalledTimes(1);
        expect(onCommit).not.toHaveBeenCalled();
    });
});
