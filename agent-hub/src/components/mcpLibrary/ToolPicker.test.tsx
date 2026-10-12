// The tool picker: bulk choices, one checkbox per tool, search over long
// lists, and the server's own hints shown as badges (never decided on).

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { McpTool } from '../../api/queries/mcpLibrary';
import { tool } from '@/test/mcpLibraryKit';
import ToolPicker from './ToolPicker';

const MIXED = [
    tool('read_file', { readOnly: true, description: 'Read one file' }),
    tool('write_file', { readOnly: false, description: 'Write one file' }),
    tool('drop_table', { readOnly: false, destructive: true, description: 'Delete a table' }),
    tool('mystery', { description: 'Does something' }),
];

/** A parent that keeps the selection, as the wizard and the drawer do. */
function Harness({ tools, initial, onChange, newTools, disabled }: {
    tools: McpTool[]; initial: string[]; onChange: (next: string[]) => void; newTools?: string[]; disabled?: boolean;
}) {
    const [selected, setSelected] = useState(initial);
    return (
        <ToolPicker
            tools={tools}
            selected={selected}
            onChange={(next) => { onChange(next); setSelected(next); }}
            newTools={newTools}
            disabled={disabled}
        />
    );
}

function renderPicker(tools: McpTool[] = MIXED, initial: string[] = [], extra: { newTools?: string[]; disabled?: boolean } = {}) {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness tools={tools} initial={initial} onChange={onChange} {...extra} />);
    return { user, onChange };
}

// The accessible name runs the code, badge and description together
// ("read_fileRead-onlyRead one file"), so match the tool name as a prefix
// that is not followed by more of a tool name.
const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}(?![a-z0-9_])`) });
const shownNames = () => screen.getAllByRole('checkbox').map(c => c.closest('label')?.querySelector('code')?.textContent);

it('All, Only read-only and None replace the selection, in the server\'s order', async () => {
    const { user, onChange } = renderPicker(MIXED, ['write_file']);
    expect(screen.getByText('1 of 4 switched on')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenLastCalledWith(['read_file', 'write_file', 'drop_table', 'mystery']);
    expect(screen.getByText('4 of 4 switched on')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Only read-only' }));
    expect(onChange).toHaveBeenLastCalledWith(['read_file']);
    expect(box('read_file')).toBeChecked();
    expect(box('write_file')).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'None' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByText('0 of 4 switched on')).toBeInTheDocument();
});

it('offers "Only read-only" only when some tool says it only reads', () => {
    renderPicker([tool('a', { readOnly: false }), tool('b')]);
    expect(screen.queryByRole('button', { name: 'Only read-only' })).not.toBeInTheDocument();
});

it('toggling a tool keeps the selection in the server\'s order, not the click order', async () => {
    const { user, onChange } = renderPicker(MIXED, ['mystery']);
    await user.click(box('read_file'));
    expect(onChange).toHaveBeenLastCalledWith(['read_file', 'mystery']);
    await user.click(box('mystery'));
    expect(onChange).toHaveBeenLastCalledWith(['read_file']);
    expect(box('mystery')).not.toBeChecked();
});

it('shows the server\'s hints: destructive wins over read/write, and a tool that says nothing gets no badge', () => {
    renderPicker([...MIXED, tool('odd', { readOnly: true, destructive: true })]);
    const row = (name: string) => box(name).closest('label') as HTMLElement;
    expect(within(row('read_file')).getByText('Read-only')).toBeInTheDocument();
    expect(within(row('write_file')).getByText('Can change data')).toBeInTheDocument();
    expect(within(row('drop_table')).getByText('Can delete data')).toBeInTheDocument();
    expect(within(row('odd')).getByText('Can delete data')).toBeInTheDocument();
    expect(within(row('odd')).queryByText('Read-only')).not.toBeInTheDocument();
    expect(within(row('mystery')).queryByText(/Read-only|Can change data|Can delete data/)).not.toBeInTheDocument();
    expect(within(row('read_file')).getByText('Read one file')).toBeInTheDocument();
});

it('notes how many tools do not say whether they change data, singular and plural', () => {
    const { unmount } = render(<ToolPicker tools={MIXED} selected={[]} onChange={() => {}} />);
    expect(screen.getByText('1 tool does not say whether it changes data. Leave it off if you are unsure.')).toBeInTheDocument();
    unmount();
    render(<ToolPicker tools={[tool('a'), tool('b')]} selected={[]} onChange={() => {}} />);
    expect(screen.getByText('2 tools do not say whether they change data. Leave them off if you are unsure.')).toBeInTheDocument();
});

it('says nothing about unlabelled tools when every tool says what it does', () => {
    render(<ToolPicker tools={[tool('a', { readOnly: true })]} selected={[]} onChange={() => {}} />);
    expect(screen.queryByText(/does not say whether/)).not.toBeInTheDocument();
});

it('marks the tools the server added since the last look as New', () => {
    renderPicker(MIXED, [], { newTools: ['mystery'] });
    expect(within(box('mystery').closest('label') as HTMLElement).getByText('New')).toBeInTheDocument();
    expect(screen.getAllByText('New')).toHaveLength(1);
});

it('disabled, nothing can be changed', () => {
    renderPicker(MIXED, [], { disabled: true });
    for (const c of screen.getAllByRole('checkbox')) expect(c).toBeDisabled();
    expect(screen.getByRole('button', { name: 'All' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'None' })).toBeDisabled();
});

const MANY = Array.from({ length: 10 }, (_, i) => tool(`tool_${i}`, { description: i === 7 ? 'Sends an invoice' : `Step ${i}`, readOnly: true }));

it('has no search for a short list', () => {
    renderPicker(MIXED);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
});

it('searches a long list by name and description; a search with no match can be cleared', async () => {
    const { user } = renderPicker(MANY);
    const search = screen.getByRole('searchbox', { name: 'Search tools' });

    await user.type(search, 'TOOL_3');
    expect(shownNames()).toEqual(['tool_3']);
    await user.clear(search);
    await user.type(search, 'invoice');
    expect(shownNames()).toEqual(['tool_7']);

    await user.clear(search);
    await user.type(search, 'nothing like this');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText(/No tool matches\./)).toBeInTheDocument();
    const list = screen.getByRole('list');
    await user.click(within(list).getByRole('button', { name: 'Clear the search' }));
    expect(search).toHaveValue('');
    expect(screen.getAllByRole('checkbox')).toHaveLength(10);
});

it('"All" during a search still switches on every tool, not only the ones shown', async () => {
    const { user, onChange } = renderPicker(MANY);
    await user.type(screen.getByRole('searchbox', { name: 'Search tools' }), 'tool_1');
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenLastCalledWith(MANY.map(tl => tl.name));
});
