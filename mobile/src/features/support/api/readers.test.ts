import { readCreatedThread, readThreadDetail, readThreadList } from './readers';

describe('readThreadList', () => {
    it('reads the threads out of their envelope, and none without one', () => {
        const [thread] = readThreadList({
            threads: [{ id: 't1', subject: 'Upload fails', status: 'ai_responding', created_at: '2026-01-01' }],
        });
        expect(thread).toMatchObject({ id: 't1', subject: 'Upload fails', status: 'ai_responding' });
        expect(thread?.last_message_at).toBeNull();
        expect(readThreadList({})).toEqual([]);
        expect(readThreadList(null)).toEqual([]);
    });
});

describe('readThreadDetail', () => {
    it('reads the thread and its messages, and a thread without messages as none', () => {
        const detail = readThreadDetail({
            thread: { id: 't1', subject: 'S', status: 'open', created_at: 'x' },
            messages: [{ id: 'm1', body: 'Hello', author_kind: 'ai', created_at: 'x' }],
            viewerIsStaff: false,
        });
        expect(detail?.messages).toEqual([
            { id: 'm1', body: 'Hello', author_kind: 'ai', author_display: null, created_at: 'x' },
        ]);
        expect(readThreadDetail({ thread: {} })?.messages).toEqual([]);
        expect(readThreadDetail(null)).toBeNull();
    });
});

describe('readCreatedThread', () => {
    it('keeps a null thread id apart from an absent one', () => {
        expect(readCreatedThread({ ok: true, threadId: null })).toEqual({ ok: true, threadId: null });
        expect(readCreatedThread({ ok: true })).toEqual({ ok: true, threadId: undefined });
        expect(readCreatedThread({ threadId: 't9' })?.threadId).toBe('t9');
    });
});
