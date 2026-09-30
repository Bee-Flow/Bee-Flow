/**
 * The Describe-it sheet against canned route answers: a description in, the
 * plan out, and "Make this" into the kind's native create flow; every way to
 * get no plan worded as its own sentence; a locked kind a notice, not a door.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { DescribeItSheet } from './DescribeItSheet';
import { STUDIO_SECTIONS } from '../model/registry';
import type { ResolvedSection, StudioSectionId } from '../model/types';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn(), canDismiss: () => false, back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const post = api.post as jest.Mock;
const onClose = jest.fn();

const sections = (locked: Partial<Record<StudioSectionId, string>> = {}): ResolvedSection[] =>
    STUDIO_SECTIONS.map((s) => ({ ...s, locked: locked[s.id] ?? null }));

const QUOTES = {
    kind: 'kb',
    name: 'Quotes',
    seed: 'Collect every quote we sent, so the agent can cite them.',
    companions: [{ kind: 'agent', name: 'Quote bot', why: 'answers the questions' }],
    available: ['kb', 'agent', 'automation'],
    undecided: [],
};

async function describeIt(words: string, answer: unknown, locked: Partial<Record<StudioSectionId, string>> = {}) {
    if (answer instanceof Error) post.mockRejectedValue(answer);
    else post.mockResolvedValue(answer);
    await renderWithProviders(<DescribeItSheet visible onClose={onClose} sections={sections(locked)} />);
    await fireEvent.changeText(screen.getByTestId('studio-ai-input'), words);
    await fireEvent.press(screen.getByTestId('studio-ai-submit'));
}

beforeEach(() => {
    jest.clearAllMocks();
    post.mockReset();
});

describe('DescribeItSheet', () => {
    it('sends nothing until there is something to send', async () => {
        await renderWithProviders(<DescribeItSheet visible onClose={onClose} sections={sections()} />);
        expect(screen.getByText('Describe what you want')).toBeTruthy();
        expect(screen.getByTestId('studio-ai-submit')).toBeDisabled();
        await fireEvent.changeText(screen.getByTestId('studio-ai-input'), '   ');
        await fireEvent.press(screen.getByTestId('studio-ai-submit'));
        expect(post).not.toHaveBeenCalled();
    });

    it('shows the plan, then opens the kind’s native create flow', async () => {
        await describeIt('a knowledge base of our quotes', QUOTES);
        expect(await screen.findByText('New Knowledge base: Quotes')).toBeTruthy();
        expect(post).toHaveBeenCalledWith('/api/studio/ai/route', { text: 'a knowledge base of our quotes' }, expect.objectContaining({ retry: false }));
        expect(screen.getByTestId('studio-ai-block-kb')).toBeTruthy();
        expect(screen.getByTestId('studio-ai-block-agent')).toBeTruthy();
        expect(screen.getByText('Shown for context — this version does not create it yet.')).toBeTruthy();
        // Neither the name nor the brief reaches a phone builder today, and the card says so.
        expect(screen.getByTestId('studio-ai-name')).toBeTruthy();
        expect(screen.getByTestId('studio-ai-seed-text')).toHaveTextContent(QUOTES.seed);
        await fireEvent.press(screen.getByTestId('studio-ai-create'));
        expect(onClose).toHaveBeenCalled();
        expect(mockRouter.push).toHaveBeenCalledWith('/knowledge?new=1');
    });

    it('copies the brief for the builder that opens', async () => {
        await describeIt('a knowledge base of our quotes', QUOTES);
        await fireEvent.press(await screen.findByTestId('studio-ai-copy'));
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith(QUOTES.seed);
        expect(await screen.findByText('Copied')).toBeTruthy();
    });

    it('shows a locked kind as a notice with its reason, not a door', async () => {
        await describeIt('a reusable way to write quotes', { ...QUOTES, kind: 'skill', name: 'Quote writer', companions: [], available: ['skill'] }, {
            skills: 'not_granted',
        });
        expect(await screen.findByText('New Skill: Quote writer')).toBeTruthy();
        expect(screen.getByText('Not switched on for your organisation — ask an admin')).toBeTruthy();
        expect(screen.getByTestId('studio-ai-create')).toBeDisabled();
        expect(screen.queryByTestId('studio-ai-seed')).toBeNull();
        await fireEvent.press(screen.getByTestId('studio-ai-create'));
        expect(mockRouter.push).not.toHaveBeenCalled();
    });

    it('does not open a kind the server says this person may not build', async () => {
        await describeIt('quotes', { ...QUOTES, available: ['automation'] });
        expect(await screen.findByText('This building block is not available in your workspace.')).toBeTruthy();
        expect(screen.getByTestId('studio-ai-create')).toBeDisabled();
    });

    it('says which kinds could not be checked', async () => {
        await describeIt('quotes', { ...QUOTES, undecided: ['app'] });
        expect(await screen.findByTestId('studio-ai-undecided')).toHaveTextContent(/We could not check every building block just now \(App\)/);
    });

    it('goes back to the field, words kept, on "Something else"', async () => {
        await describeIt('a knowledge base of our quotes', QUOTES);
        await fireEvent.press(await screen.findByTestId('studio-ai-other'));
        expect((await screen.findByTestId('studio-ai-input')).props.value).toBe('a knowledge base of our quotes');
        expect(screen.queryByTestId('studio-ai-plan')).toBeNull();
    });

    it.each([
        ['nothing you may build', { kind: null, available: [], undecided: [] }, /There is nothing here you can build yet/],
        ['could not find out', { kind: null, available: [], undecided: ['app'] }, /We could not work out what you may build right now/],
        ['not clear enough', { kind: null, available: ['automation'], undecided: [] }, /not clear enough to pick a building block/],
        ['an unreadable answer', null, /Could not read that just now/],
    ])('words a kind-less answer: %s', async (_case, answer, sentence) => {
        await describeIt('something', answer);
        expect(await screen.findByText(sentence)).toBeTruthy();
        expect(screen.queryByTestId('studio-ai-plan')).toBeNull();
    });

    it.each([
        ['too many requests', new ApiError('Too many requests', { status: 429 }), /wait a moment and try again/],
        ['no model', new ApiError('No AI model', { status: 503, body: { code: 'no_model' } }), /No AI model is set up yet.*Pick a building block from New in the meantime\./],
        ['an unusable answer', new ApiError('Unusable', { status: 502, body: { code: 'ai_unusable' } }), /describe it a little more concretely/],
        ['a server failure', new ApiError('Could not route this request', { status: 500 }), /Could not read that just now/],
    ])('words a refusal in plain words: %s', async (_case, error, sentence) => {
        await describeIt('something', error);
        expect(await screen.findByText(sentence)).toBeTruthy();
        expect(screen.getByTestId('studio-ai-input').props.value).toBe('something');
    });

    it('cancels a request that is still running, for real', async () => {
        let signal: AbortSignal | undefined;
        post.mockImplementation((_path: string, _body: unknown, opts: { signal?: AbortSignal }) => {
            signal = opts.signal;
            return new Promise(() => undefined);
        });
        await renderWithProviders(<DescribeItSheet visible onClose={onClose} sections={sections()} />);
        await fireEvent.changeText(screen.getByTestId('studio-ai-input'), 'quotes');
        await fireEvent.press(screen.getByTestId('studio-ai-submit'));
        expect(await screen.findByText('Reading your description…')).toBeTruthy();
        expect(screen.getByTestId('studio-ai-input').props.editable).toBe(false);
        await fireEvent.press(screen.getByTestId('studio-ai-cancel'));
        expect(signal?.aborted).toBe(true);
        await waitFor(() => expect(screen.queryByText('Reading your description…')).toBeNull());
        expect(screen.getByTestId('studio-ai-input').props.value).toBe('quotes');
    });
});
