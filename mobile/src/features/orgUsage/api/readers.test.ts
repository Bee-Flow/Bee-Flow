import {
    readAzureTotal,
    readBreakdown,
    readFeedback,
    readFeedbackSummary,
    readTerminationSummary,
    readTerminationTimeline,
    readTerminations,
    readTerminationsByAgent,
    readTimeline,
    readUsageTotals,
} from './readers';

describe('usage', () => {
    it('reads the full summary, Postgres strings included', () => {
        expect(readUsageTotals({
            total_calls: '1423', total_tokens: '99000', total_estimated_cost: '18.44',
            combined_total_cost: 20.1, total_input_cost: 5, total_output_cost: 13.44,
            azure_services_total_cost: 1.66, unique_users: '7',
        })).toEqual({
            customerView: false, calls: 1423, tokens: 99000, cost: 20.1,
            inputCost: 5, outputCost: 13.44, azureCost: 1.66, activeUsers: 7,
        });
    });

    it('recognises the redacted customer view: no counts, billed cost', () => {
        expect(readUsageTotals({ billed_cost: 12.5, unique_users: 3 })).toMatchObject({
            customerView: true, calls: null, tokens: null, cost: 12.5, activeUsers: 3,
        });
        expect(readUsageTotals(null)).toMatchObject({ customerView: false, cost: 0 });
    });

    it('reads the timeline and the Azure total', () => {
        expect(readTimeline([{ period: '2026-09-01', estimated_cost: '1.5', total_tokens: '10' }, { period: '2026-09-02', billed_cost: 2 }])).toEqual([
            { period: '2026-09-01', cost: 1.5, tokens: 10 },
            { period: '2026-09-02', cost: 2, tokens: null },
        ]);
        expect(readAzureTotal({ total_cost: '3.2' })).toBe(3.2);
        expect(readAzureTotal(null)).toBe(0);
    });

    it('names each breakdown by its own columns, most expensive first', () => {
        expect(readBreakdown('users', [
            { user_id: 'u1', display_name: 'Bea', calls: '3', total_tokens: '30', estimated_cost: '0.5' },
            { user_id: 'u2', calls: 9, estimated_cost: 2 },
        ]).map((r) => [r.title, r.cost, r.calls])).toEqual([['u2', 2, 9], ['Bea', 0.5, 3]]);
        expect(readBreakdown('models-by-agent', [{ agent_name: 'Scout', model: 'gpt-5', billed_cost: 1 }])[0]).toMatchObject({
            title: 'Scout', subtitle: 'gpt-5', calls: null, cost: 1,
        });
        expect(readBreakdown('models-by-user', [{ user_id: 'u1', model: 'm' }])[0]).toMatchObject({ title: 'u1', subtitle: 'm' });
        expect(readBreakdown('agents', [{ agent_id: null, agent_name: null }])[0]?.title).toBe('');
        expect(readBreakdown('models', [{ model: 'm' }])[0]?.title).toBe('m');
        expect(readBreakdown('sources', [{ source: 'direct' }])[0]?.title).toBe('direct');
        expect(readBreakdown('azure', [{ service_type: 'ocr', calls: 2, total_cost: '0.3' }])[0]).toMatchObject({ title: 'ocr', cost: 0.3 });
        expect(readBreakdown('users', { error: 'x' })).toEqual([]);
    });
});

describe('feedback', () => {
    it('reads the summary and the items', () => {
        expect(readFeedbackSummary({ total: '4', thumbs_up: '3', thumbs_down: '1', with_comments: '2' })).toEqual({ total: 4, up: 3, down: 1, withComments: 2 });
        expect(readFeedback([
            { id: 'f1', rating: 'up', comment: '', user_id: 'u1', agent_id: 'a1', model: 'm', source: 'agent', created_at: 't', conversation_snapshot: '[]' },
        ])[0]).toEqual({
            id: 'f1', rating: 'up', comment: null, userId: 'u1', agentName: 'a1', model: 'm', source: 'agent', createdAt: 't', hasConversation: true,
        });
    });
});

describe('terminations', () => {
    it('reads the { rows } answers and the summary', () => {
        expect(readTerminationSummary({ total: 5, by_type: { max_tokens: 1, error: 4 } })).toEqual({
            total: 5, byType: { max_tokens: 1, max_iterations: 0, error: 4, aborted: 0 },
        });
        expect(readTerminations({ rows: [{ id: 1, timestamp: 't', termination_type: 'error', error_code: 'E1', error_first_line: 'boom' }] })[0]).toMatchObject({
            id: 1, type: 'error', errorCode: 'E1', errorLine: 'boom', agentName: null,
        });
        expect(readTerminationsByAgent({ rows: [{ agent_id: 'a', agent_name: 'A', total: 3, errors: 1 }] })).toEqual([{ agentId: 'a', agentName: 'A', total: 3, errors: 1 }]);
        expect(readTerminationTimeline({ rows: [{ period: 'p', termination_type: 'error', count: 2 }] })).toEqual([{ period: 'p', type: 'error', count: 2 }]);
        expect(readTerminations(null)).toEqual([]);
    });
});
