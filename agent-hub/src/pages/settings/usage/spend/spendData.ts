// The aggregations the Spend tables read from the usage report.

import type { AgentGroup, AgentModelRow, ModelUserRow, UserRow } from '../OverviewTab.types';

/** An agent with the models it used; a pg SUM may arrive as a string, so every sum goes through Number(). */
export function groupByAgent(rows: AgentModelRow[], directChat: string): AgentGroup[] {
    const map = new Map<string, AgentGroup>();
    for (const row of rows) {
        const name = row.agent_name || directChat;
        let group = map.get(name);
        if (!group) {
            group = { agent_name: name, agent_id: row.agent_id, models: [], total_tokens: 0, estimated_cost: 0 };
            map.set(name, group);
        }
        group.models.push(row);
        // `+=` on a string "98282" followed by "7000" once read 98282.7M tokens.
        group.total_tokens += Number(row.total_tokens) || 0;
        group.estimated_cost += Number(row.estimated_cost) || 0;
    }
    return Array.from(map.values()).sort((a, b) => b.total_tokens - a.total_tokens);
}

export function modelsOfUser(rows: ModelUserRow[], user: UserRow): ModelUserRow[] {
    return rows
        .filter(r => r.user_id === user.user_id)
        .sort((a, b) => (Number(b.estimated_cost) || 0) - (Number(a.estimated_cost) || 0));
}

/** True when the row carries a per-direction cost (the user rows of older servers carry only the total). */
export function hasSplitCost(row: { input_cost?: number | null; output_cost?: number | null }): boolean {
    return row.input_cost != null || row.output_cost != null;
}
