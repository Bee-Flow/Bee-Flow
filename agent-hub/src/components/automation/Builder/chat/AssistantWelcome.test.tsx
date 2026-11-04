import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AssistantWelcome, { seenSentence, welcomeIdeas } from './AssistantWelcome';
import type { FlowDefinition } from '../flow/types';

const t = (_k: string | undefined, d?: unknown, p?: unknown) => String(d).replace(/\{(\w+)\}/g, (_m, k) => String((p as Record<string, unknown> | undefined)?.[k] ?? `{${k}}`));

afterEach(cleanup);

const contactForm: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'form', form: { title: 'Contact', fields: [{ key: 'email' }] } },
    steps: [
        { id: 's1', type: 'ai_step', label: 'Summarise' },
        { id: 's2', type: 'notification', label: 'Tell me' },
    ],
    edges: [],
};
const emptyDraft: FlowDefinition = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] };

describe('AssistantWelcome — an automation with steps', () => {
    it('says what it sees in plain words, without "Looking at" or "Fits this flow"', () => {
        render(<AssistantWelcome definition={contactForm} onPick={vi.fn()} />);
        expect(screen.getByTestId('assistant-seen').textContent).toBe('I can see your form \'Contact\' and the 2 steps after it.');
        expect(screen.queryByText(/Looking at/)).toBeNull();
        expect(screen.queryByText(/Fits this flow/)).toBeNull();
    });

    it('offers at most three suggestions read off the flow, and a click SENDS one', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<AssistantWelcome definition={contactForm} onPick={onPick} />);
        const ideas = screen.getAllByTestId('assistant-idea');
        expect(ideas.length).toBeGreaterThan(0);
        expect(ideas.length).toBeLessThanOrEqual(3);
        await user.click(ideas[0]);
        expect(onPick).toHaveBeenCalledWith(ideas[0].textContent);
    });

    it('names the selected step and leads with what fits it', () => {
        render(<AssistantWelcome definition={contactForm} selectedStep={{ id: 'c1', type: 'code', label: 'Clean up' }} onPick={vi.fn()} />);
        expect(screen.getByTestId('assistant-seen').textContent).toContain('You have \'Clean up\' selected.');
        expect(screen.getAllByTestId('assistant-idea')[0].textContent).toBe('Write the code for the selected step');
    });
});

describe('AssistantWelcome — an empty draft', () => {
    it('asks what should happen and recommends asking a few questions first, which switches to plan', async () => {
        const user = userEvent.setup();
        const onWorkModeChange = vi.fn();
        render(<AssistantWelcome definition={emptyDraft} workMode="approve" onWorkModeChange={onWorkModeChange} onPick={vi.fn()} />);
        expect(screen.getByText('What should happen? Tell me in your own words.')).toBeTruthy();
        const askFirst = screen.getByTestId('assistant-ask-first');
        expect(askFirst.textContent).toContain('Let me ask a few questions first');
        expect(askFirst.textContent).toContain('Recommended');
        await user.click(askFirst);
        expect(onWorkModeChange).toHaveBeenCalledWith('plan');
    });

    it('in plan mode it says it will ask first instead of offering it again', () => {
        render(<AssistantWelcome definition={emptyDraft} workMode="plan" onWorkModeChange={vi.fn()} onPick={vi.fn()} />);
        expect(screen.queryByTestId('assistant-ask-first')).toBeNull();
        expect(screen.getByTestId('assistant-ask-first-on')).toBeTruthy();
    });

    it('three example briefs that send as they read', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<AssistantWelcome definition={null} onPick={onPick} />);
        const briefs = screen.getAllByTestId('assistant-example-brief');
        expect(briefs).toHaveLength(3);
        await user.click(briefs[2]);
        expect(onPick).toHaveBeenCalledWith(briefs[2].textContent);
        // Without a way to switch the mode, nothing pretends to.
        expect(screen.queryByTestId('assistant-ask-first')).toBeNull();
    });
});

describe('seenSentence / welcomeIdeas', () => {
    it('one step, no step, and a start without a name', () => {
        const one = { ...contactForm, steps: [contactForm.steps![0]] };
        expect(seenSentence(one, t)).toBe('I can see your form \'Contact\' and the step after it.');
        expect(seenSentence({ trigger: { id: 't', kind: 'schedule' }, steps: [] }, t)).toBe('I can see your schedule. Nothing happens after it yet.');
        expect(seenSentence({ trigger: { id: 't', kind: 'form', form: {} }, steps: [] }, t)).toBe('I can see your form. Nothing happens after it yet.');
        expect(seenSentence({ trigger: { id: 't', kind: 'something_new' }, steps: [] }, t)).toBe('I can see how it starts. Nothing happens after it yet.');
    });

    it('does not suggest what the flow already does', () => {
        const ideas = welcomeIdeas(contactForm, null, t);
        expect(ideas).not.toContain('Send me a message when the flow finishes');
        expect(ideas).toContain('Save each answer in a table');
        const withTable = { ...contactForm, steps: [...contactForm.steps!, { id: 's3', type: 'datatable' }] };
        expect(welcomeIdeas(withTable, null, t)).not.toContain('Save each answer in a table');
    });

    it('a form with nothing after it gets ideas for its answers', () => {
        expect(welcomeIdeas({ trigger: { id: 't', kind: 'form' }, steps: [] }, null, t)).toEqual([
            'Save each answer in a table', 'Email me each new answer', 'Ask someone to approve a request',
        ]);
    });
});
