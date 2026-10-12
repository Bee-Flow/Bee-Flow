// "Models per Agent" sums each agent's models. Postgres hands a SUM over an
// INTEGER column back as a string, and `+=` on strings concatenated them:
// "Direct Chat" with 98282 and 7000 tokens read 98282.7M instead of 105.3K.

import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { expect, it } from 'vitest';
import OverviewTab from './OverviewTab';

const t = (key: string, fallback?: string) => fallback || key;

function renderOverview(modelsByAgent: Record<string, unknown>[]) {
    return render(
        <OverviewTab
            t={t}
            data={{ summary: {}, timeline: [], users: [], sources: [], agents: [], models: [], modelsByAgent, modelsByUser: [] }}
            subscription={null}
            isCustomerView={false}
            showTokens
            tierForModel={() => null}
            azureServices={{ summary: {}, byType: [], byUser: [] }}
            setFilterUser={() => {}}
            setFilterModel={() => {}}
            setFilterSource={() => {}}
        />,
    );
}

function agentRow(name: string) {
    const label = screen.getByText(name);
    // The row is the nearest ancestor that also carries the token total.
    let el: HTMLElement | null = label;
    while (el && !within(el).queryByText(/[KM]$|^\d+$/)) el = el.parentElement;
    if (!el) throw new Error(`no row for ${name}`);
    return el;
}

it('sums string token counts per agent as numbers, not as concatenated text', () => {
    renderOverview([
        { model: 'claude-sonnet-5-5', agent_name: 'Direct Chat', agent_id: null, total_tokens: '98282', estimated_cost: 0.25 },
        { model: 'gpt-5', agent_name: 'Direct Chat', agent_id: null, total_tokens: '7000', estimated_cost: 0.1 },
    ]);
    const row = agentRow('Direct Chat');
    expect(within(row).getByText('105.3K')).toBeTruthy();
    expect(within(row).queryByText(/98282\.7M/)).toBeNull();
    expect(within(row).getByText('$0.35')).toBeTruthy();
});

it('orders agents by their numeric total', () => {
    renderOverview([
        // Concatenated, Small's two rows read "0900900" — bigger than Big.
        { model: 'm', agent_name: 'Small', agent_id: 'a1', total_tokens: '900', estimated_cost: 0 },
        { model: 'n', agent_name: 'Small', agent_id: 'a1', total_tokens: '900', estimated_cost: 0 },
        { model: 'm', agent_name: 'Big', agent_id: 'a2', total_tokens: '10000', estimated_cost: 0 },
    ]);
    const names = screen.getAllByText(/^(Small|Big)$/).map((el) => el.textContent);
    expect(names).toEqual(['Big', 'Small']);
});
