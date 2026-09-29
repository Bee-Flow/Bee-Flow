import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import BuildBanner from './BuildBanner';
import { BuildCueContext } from './BuildCueContext';

// The English fallbacks render (no translation provider mounted), which is
// what the rest of the AppStudio suite asserts on.
function mount(cue, props = {}) {
    return render(
        <BuildCueContext.Provider value={cue}>
            <BuildBanner {...props} />
        </BuildCueContext.Provider>,
    );
}

const liveCue = (extra = {}) => ({
    running: true,
    startedAt: Date.now() - 42_000,
    phase: 'building',
    lastCall: { name: 'app_add_components', title: 'Added 12 components', detail: null, added: [], ok: true },
    todos: [],
    phaseInfo: null,
    engine: null,
    turn: null,
    toolDraft: null,
    reveal: null,
    finalized: false,
    stopped: false,
    skipped: null,
    componentCount: 12,
    screenCount: 2,
    ...extra,
});

describe('BuildBanner — the chapter', () => {
    it('names the screen being built after the verb, live only', () => {
        mount(liveCue(), { screen: { id: 'scr_b', name: 'Suppliers', reason: 'typing' } });
        expect(screen.getByTestId('app-build-verb').textContent).toContain('Added 12 components');
        expect(screen.getByTestId('app-build-screen').textContent).toBe(' · on Suppliers');
    });

    it('says nothing twice: a verb that already names the screen gets no "on …"', () => {
        mount(liveCue({ lastCall: { name: 'app_add_screen', title: 'Added a screen', detail: 'Suppliers', added: [{ id: 'scr_b', type: 'screen' }], ok: true } }), { screen: { id: 'scr_b', name: 'Suppliers', reason: 'screen' } });
        expect(screen.getByTestId('app-build-verb').textContent).toContain('Suppliers');
        expect(screen.queryByTestId('app-build-screen')).toBeNull();
    });

    it('no screen resolved, or a build that ended → no chapter line', () => {
        mount(liveCue(), { screen: null });
        expect(screen.queryByTestId('app-build-screen')).toBeNull();
    });

    it('the farewell has no chapter line either', () => {
        const ended = { ...liveCue(), running: false, finalized: true, startedAt: Date.now() - 60_000 };
        // A banner that saw the live cue and then its end shows the farewell.
        const { rerender } = render(
            <BuildCueContext.Provider value={liveCue()}>
                <BuildBanner screen={{ id: 'scr_b', name: 'Suppliers' }} />
            </BuildCueContext.Provider>,
        );
        rerender(
            <BuildCueContext.Provider value={ended}>
                <BuildBanner screen={{ id: 'scr_b', name: 'Suppliers' }} />
            </BuildCueContext.Provider>,
        );
        expect(screen.getByTestId('app-build-farewell')).toBeTruthy();
        expect(screen.queryByTestId('app-build-screen')).toBeNull();
    });
});
