/** "Describe it", the pure half: why there is no plan, in words, and where "Make this" leads. */

import { ApiError, OfflineError } from '@/core/api/client';

import type { DescribeItAnswer } from './api';
import { doorForKind, kindWord, noKindProblem, planOf, problemText, routeProblem } from './describeIt';
import { STUDIO_SECTIONS } from './registry';
import type { ResolvedSection, StudioSectionId } from './types';

const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? ''));

const open = (locked: Partial<Record<StudioSectionId, string>> = {}, without: StudioSectionId[] = []): ResolvedSection[] =>
    STUDIO_SECTIONS.filter((s) => !without.includes(s.id)).map((s) => ({ ...s, locked: locked[s.id] ?? null }));

const answer = (over: Partial<DescribeItAnswer> = {}): DescribeItAnswer => ({
    kind: 'kb',
    name: 'Quotes',
    seed: 'Collect our quotes',
    companions: [],
    available: ['kb'],
    undecided: [],
    ...over,
});

describe('routeProblem', () => {
    it('believes a code the route knows, whatever the status', () => {
        expect(routeProblem(new ApiError('x', { status: 400, body: { code: 'no_text' } }))).toBe('no_text');
        expect(routeProblem(new ApiError('x', { status: 500, body: { code: 'no_model' } }))).toBe('no_model');
    });

    it('reads the status when the body names no code it knows', () => {
        expect(routeProblem(new ApiError('x', { status: 429, body: { error: 'Too many requests' } }))).toBe('rate_limited');
        expect(routeProblem(new ApiError('x', { status: 502 }))).toBe('ai_unusable');
        expect(routeProblem(new ApiError('x', { status: 503, body: { code: 'something_else' } }))).toBe('no_model');
        expect(routeProblem(new ApiError('x', { status: 400 }))).toBe('no_text');
    });

    it('calls everything else a failure, and offline offline', () => {
        expect(routeProblem(new ApiError('x', { status: 500, body: { error: 'Could not route this request' } }))).toBe('failed');
        expect(routeProblem(new Error('unreadable'))).toBe('failed');
        expect(routeProblem(new OfflineError())).toBe('offline');
    });
});

describe('noKindProblem', () => {
    it('keeps "you may build nothing" apart from "we could not tell" and from "not clear enough"', () => {
        expect(noKindProblem({ available: [], undecided: [] })).toBe('none_available');
        expect(noKindProblem({ available: [], undecided: ['app'] })).toBe('gates_unreadable');
        expect(noKindProblem({ available: ['automation'], undecided: [] })).toBe('ai_unusable');
        expect(noKindProblem({ available: null, undecided: [] })).toBe('ai_unusable');
    });
});

describe('problemText', () => {
    it('words each problem in plain words, and gives "no model" its way out', () => {
        expect(problemText('rate_limited', t)).toBe('That is a lot of requests in a row — wait a moment and try again.');
        expect(problemText('no_model', t)).toBe(
            'No AI model is set up yet, so nothing can be picked for you. Pick a building block from New in the meantime.',
        );
        expect(problemText('none_available', t)).toMatch(/nothing here you can build/);
    });
});

describe('planOf / kindWord', () => {
    it('is a plan only when a kind was named, with the person\'s own words as the brief when none came back', () => {
        expect(planOf(answer({ kind: null }), 'x')).toBeNull();
        expect(planOf(answer({ seed: '' }), '  my own words  ')?.seed).toBe('my own words');
        expect(planOf(answer(), 'ignored')?.seed).toBe('Collect our quotes');
    });

    it('names a kind with its New-menu word', () => {
        expect(kindWord('kb', t)).toBe('Knowledge base');
        expect(kindWord('datatable', t)).toBe('Table');
        expect(kindWord('compliance', t)).toBe('compliance');
    });
});

describe('doorForKind', () => {
    it('opens the kind\'s native create flow — the New menu\'s own target', () => {
        expect(doorForKind('kb', open(), ['kb'])).toEqual({ state: 'open', target: { kind: 'route', href: '/knowledge?new=1' } });
        expect(doorForKind('automation', open(), null)).toEqual({ state: 'open', target: { kind: 'route', href: '/automations/new' } });
        expect(doorForKind('form', open(), null)).toEqual({ state: 'open', target: { kind: 'route', href: '/forms/new' } });
        expect(doorForKind('solution', open(), null)).toEqual({ state: 'open', target: { kind: 'route', href: '/projects?create=1' } });
    });

    it('shows a locked kind as a lock with its reason, not a door', () => {
        expect(doorForKind('skill', open({ skills: 'not_granted' }), ['skill'])).toEqual({ state: 'locked', reason: 'not_granted' });
    });

    it('is no door for a kind this person cannot see, one the server left out, or one nothing makes', () => {
        expect(doorForKind('agent', open({}, ['agents']), ['agent'])).toEqual({ state: 'unavailable' });
        expect(doorForKind('kb', open(), ['automation'])).toEqual({ state: 'unavailable' });
        expect(doorForKind('compliance', open(), null)).toEqual({ state: 'unavailable' });
    });
});
