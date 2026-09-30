import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { RuleEditor } from './RuleEditor';
import type { Condition, ContractParameter } from '../model/types';

const PARAMS: ContractParameter[] = [{ key: 'vip', type: 'boolean', label: 'VIP', summary: '', instructions: '', required: false }];
const RULE = { parameter: 'vip', operator: 'equals' as const, value: true };

async function renderEditor(value: Condition | null) {
    const onChange = jest.fn();
    await renderWithProviders(<RuleEditor value={value} parameters={PARAMS} onChange={onChange} />);
    return onChange;
}

it('starts a condition as a group with one rule', async () => {
    const onChange = await renderEditor(null);
    await fireEvent.press(screen.getByText('Add condition'));
    expect(onChange).toHaveBeenCalledWith({ all: [RULE] });
});

it('edits a nested group instead of only showing it', async () => {
    const onChange = await renderEditor({ all: [RULE, { any: [RULE, RULE] }] });
    // One rail per group: the outer group and the nested one each offer a join.
    expect(screen.getAllByLabelText('Condition group')).toHaveLength(2);
    // In tree order the nested group's controls come first, the outer group's last.
    await fireEvent.press(screen.getAllByText('Group')[0] as never);
    expect(onChange).toHaveBeenLastCalledWith({ all: [RULE, { any: [RULE, RULE, { all: [RULE] }] }] });
    await fireEvent.press(screen.getAllByText('Group')[1] as never);
    expect(onChange).toHaveBeenLastCalledWith({ all: [RULE, { any: [RULE, RULE] }, { all: [RULE] }] });
    // Remove buttons: outer child 0, inner children 0 and 1, then outer child 1 (the nested group).
    await fireEvent.press(screen.getAllByText('Remove condition')[1] as never);
    expect(onChange).toHaveBeenLastCalledWith({ all: [RULE, { any: [RULE] }] });
    await fireEvent.press(screen.getAllByText('Remove condition')[3] as never);
    expect(onChange).toHaveBeenLastCalledWith({ all: [RULE] });
});

it('stops offering a new group at the web’s depth limit', async () => {
    const deep: Condition = { all: [{ all: [{ all: [{ all: [{ all: [RULE] }] }] }] }] };
    await renderEditor(deep);
    // Five groups deep: every level but the fifth (depth 4) offers "+ Group".
    expect(screen.getAllByLabelText('Condition group')).toHaveLength(5);
    expect(screen.getAllByText('Group')).toHaveLength(4);
});

it('lets a bare top-level rule be removed', async () => {
    const onChange = await renderEditor(RULE);
    await fireEvent.press(screen.getByText('Remove condition'));
    expect(onChange).toHaveBeenCalledWith(null);
});
