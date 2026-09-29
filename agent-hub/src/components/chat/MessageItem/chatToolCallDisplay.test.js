import { describe, expect, it } from 'vitest';
import { describeChatTool, detailOf, detailPayload, errorOf, resultFor, visibleToolHistory } from './chatToolCallDisplay';

const entry = (name, extra = {}) => ({ name, args: {}, status: 'done', startTime: 1000, endTime: 1840, ...extra });

describe('visibleToolHistory', () => {
    it('drops sequentialthinking and junk, keeps order', () => {
        const msg = { toolHistory: [entry('agent_search'), entry('sequentialthinking'), null, 'x', entry('file_read')] };
        expect(visibleToolHistory(msg).map(e => e.name)).toEqual(['agent_search', 'file_read']);
        expect(visibleToolHistory({})).toEqual([]);
    });
});

describe('detailOf', () => {
    it('picks the telling argument over the first one', () => {
        expect(detailOf({ limit: 10, query: 'vat rate 2026' })).toBe('vat rate 2026');
        expect(detailOf({ url: 'https://example.org/x' })).toBe('https://example.org/x');
    });
    it('falls back to the first string, skips private keys, cuts to one line', () => {
        expect(detailOf({ _internal: 'no', foo: '  a\n b ' })).toBe('a b');
        expect(detailOf({ q: 'x'.repeat(200) })).toHaveLength(90);
        expect(detailOf({ n: 3 })).toBe('');
        expect(detailOf('not an object')).toBe('');
    });
});

describe('errorOf', () => {
    it('reads a refusal off the result, whatever shape it arrived in', () => {
        expect(errorOf({ error: 'Gmail is not connected' })).toBe('Gmail is not connected');
        expect(errorOf({ ok: false, message: 'nope' })).toBe('nope');
        expect(errorOf('[Tool blocked — arguments contain sensitive information (IBAN)]')).toBe('Tool blocked — arguments contain sensitive information (IBAN)');
        expect(errorOf(null, '{"error":"rate limited","code":429}')).toBe('rate limited');
    });
    it('reads success as success', () => {
        expect(errorOf({ results: [] })).toBeNull();
        expect(errorOf('{"results":[{"title":"x"}]}')).toBeNull();
        expect(errorOf(null, null)).toBeNull();
    });
});

describe('resultFor', () => {
    it('matches the k-th result of a name to the k-th row of that name', () => {
        const msg = {
            toolHistory: [entry('agent_search'), entry('sequentialthinking'), entry('agent_search'), entry('file_read')],
            toolResults: [
                { name: 'agent_search', result: 'first' },
                { name: 'sequentialthinking', result: 'thought' },
                { name: 'agent_search', result: 'second' },
                { name: 'file_read', result: 'content' },
            ],
        };
        expect(resultFor(msg, 0)).toBe('first');
        expect(resultFor(msg, 1)).toBe('second');
        expect(resultFor(msg, 2)).toBe('content');
        expect(resultFor(msg, 3)).toBeNull();
    });
    it('is null for a reloaded message that kept only previews', () => {
        expect(resultFor({ toolHistory: [entry('agent_search', { resultPreview: 'x' })] }, 0)).toBeNull();
    });
});

describe('describeChatTool', () => {
    it('names the tool, shows the query, measures the duration', () => {
        const row = describeChatTool(entry('agent_search', { args: { query: 'bee flow' } }));
        expect(row).toEqual({ title: 'Agent Search', detail: 'bee flow', status: 'done', error: null, durationMs: 840 });
    });
    it('a live row spins only while the stream is live; afterwards it is interrupted, never ticked', () => {
        const live = entry('file_read', { status: 'running', endTime: undefined });
        expect(describeChatTool(live, { streaming: true }).status).toBe('running');
        expect(describeChatTool(live, { streaming: false }).status).toBe('interrupted');
        expect(describeChatTool(live).durationMs).toBeNull();
    });
    it('a refusal is failed, with the reason, from the full result or the preview', () => {
        expect(describeChatTool(entry('gmail_send'), { result: { error: 'not connected' } })).toMatchObject({ status: 'failed', error: 'not connected' });
        expect(describeChatTool(entry('gmail_send', { resultPreview: '[Tool blocked — PII guard unavailable (fail-closed)]' })).status).toBe('failed');
    });
    it('a session skill is named by its step, through t()', () => {
        const t = (key, en, p) => `⟦${key}⟧${p.order}:${p.name}`;
        const row = describeChatTool(entry('activate_session_skill', { args: { skill_ids: ['s2'] } }), {
            t, sessionSkills: [{ id: 's2', name: 'Draft the reply', order: 2 }],
        });
        expect(row.title).toBe('⟦chat.msg.tool_skill_step⟧2:Draft the reply');
    });
});

describe('detailPayload', () => {
    it('drops model-facing _ args and prefers the full result over the preview', () => {
        const e = entry('x', { args: { q: 'a', _hint: 'b' }, resultPreview: 'prev' });
        expect(detailPayload(e, { ok: true })).toEqual({ args: { q: 'a' }, result: { ok: true } });
        expect(detailPayload(e, null)).toEqual({ args: { q: 'a' }, result: 'prev' });
        expect(detailPayload({ name: 'x' }, null)).toEqual({ args: null, result: null });
    });
});
