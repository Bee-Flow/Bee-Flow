/**
 * The webpage builder's frames, folded the way the stream folds them: what a
 * finished turn tells the screen to refresh, and the plan that stops a turn.
 */

import { emptyWebpageTurn, readPlan, WEBPAGE_FRAMES, type WebpageTurn } from './webpage';
import { reduceFrame } from '../chatFrameReducer';

function fold(frames: [string, unknown][]): { turn: WebpageTurn; marks: number; unhandled: string[] } {
    const turn = emptyWebpageTurn();
    let marks = 0;
    const unhandled: string[] = [];
    for (const [event, data] of frames) {
        reduceFrame(
            WEBPAGE_FRAMES,
            turn,
            { event, data },
            {
                mark: () => {
                    marks += 1;
                },
                onUnhandled: (e) => unhandled.push(e),
            },
        );
    }
    return { turn, marks, unhandled };
}

describe('WEBPAGE_FRAMES', () => {
    it('streams the answer and closes the turn on done', () => {
        const { turn } = fold([
            ['phase', { stage: 'kb_search', status: 'start' }],
            ['content', { text: 'Building ' }],
            ['content', { text: 'the hero.' }],
            ['phase', { stage: 'kb_search', status: 'end' }],
            ['done', {}],
        ]);
        expect(turn.text).toBe('Building the hero.');
        expect(turn.phase).toBeNull();
        expect(turn.done).toBe(true);
    });

    it('keeps the latest body of each rewritten slot and every touched file', () => {
        const { turn } = fold([
            ['webpage_doc_update', { file: 'html', content: '<h1>One</h1>' }],
            ['webpage_doc_update', { file: 'html', content: '<h1>Two</h1>' }],
            ['webpage_doc_update', { file: 'css', content: 'h1{}' }],
            ['webpage_doc_update', { file: 'readme', content: 'ignored' }],
            ['webpage_extra_update', { path: 'src/App.jsx' }],
            ['webpage_extra_update', { path: 'src/App.jsx' }],
            ['webpage_extra_deleted', { path: 'src/old.jsx' }],
            ['webpage_source_added', { source: { id: 's1' } }],
            ['webpage_runtime_changed', { runtime: 'full' }],
        ]);
        expect(turn.slots).toEqual({ html: '<h1>Two</h1>', css: 'h1{}' });
        expect(turn.extraPaths).toEqual(['src/App.jsx', 'src/old.jsx']);
        expect(turn.sourcesAdded).toBe(1);
        expect(turn.settingsChanged).toBe(true);
    });

    it('holds a proposed plan, normalising its steps', () => {
        const { turn } = fold([
            [
                'webpage_plan_proposed',
                {
                    planId: 'p1',
                    plan: {
                        title: 'Add a menu',
                        summary: 'A grid of dishes',
                        steps: [
                            { file: 'index.html', action: 'partial', why: 'markup' },
                            { file: 'style.css', action: 'create' },
                        ],
                    },
                },
            ],
        ]);
        expect(turn.plan).toEqual({
            planId: 'p1',
            title: 'Add a menu',
            summary: 'A grid of dishes',
            steps: [
                { file: 'index.html', action: 'edit', why: 'markup' },
                { file: 'style.css', action: 'create', why: '' },
            ],
        });
        expect(readPlan({ plan: { title: 'x' } })).toBeNull();
    });

    it('reports a failure and a refusal as themselves', () => {
        expect(fold([['error', { error: 'Chat error: boom' }]]).turn.error).toBe('Chat error: boom');
        expect(fold([['dlp_blocked', { reason: 'IBAN' }]]).turn.blocked?.detail).toBe('IBAN');
    });

    it('accounts for the desktop-only frames without a render', () => {
        const { marks, unhandled } = fold([
            ['ping', {}],
            ['image', { data: 'x' }],
            ['webpage_db_update', {}],
            ['webpage_validation', { violations: [] }],
            ['model_selected', { modelId: 'm' }],
            ['webpage_extra_update', {}],
        ]);
        expect(unhandled).toEqual([]);
        expect(marks).toBe(0);
    });
});
