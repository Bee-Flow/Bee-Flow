import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLANK_APP, KITCHEN_SINK } from '../state/sampleDefinitions';
import AppAssistantWelcome, { isEmptyApp, welcomeIdeas } from './AppAssistantWelcome';

vi.mock('@/hooks/useTranslation', () => {
    const t = (_k: string, d: string, p?: Record<string, unknown>) => d.replace(/\{(\w+)\}/g, (_m, k) => String(p?.[k] ?? `{${k}}`));
    return { default: () => ({ t }), useTranslation: () => ({ t }) };
});

afterEach(cleanup);

const t = (_k: string, d: string) => d;

describe('AppAssistantWelcome', () => {
    it('an empty app asks what it should do and offers three briefs that send in the chosen mode', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<AppAssistantWelcome definition={BLANK_APP} tableCount={0} onPick={onPick} workMode="build" onWorkModeChange={vi.fn()} />);
        expect(screen.getByText('What should the app do? Tell me in your own words.')).toBeTruthy();
        expect(screen.getByText('I build it with you. Pick an example, or describe your own below.')).toBeTruthy();
        const briefs = screen.getAllByTestId('app-assistant-example-brief');
        expect(briefs).toHaveLength(3);
        await user.click(briefs[1]);
        expect(onPick).toHaveBeenCalledWith(briefs[1].textContent, 'brief');
    });

    it('offers "Describe it" outside describe/plan, and switches the mode on a click', async () => {
        const user = userEvent.setup();
        const onWorkModeChange = vi.fn();
        render(<AppAssistantWelcome definition={BLANK_APP} workMode="discuss" onWorkModeChange={onWorkModeChange} />);
        expect(screen.getByText('Recommended')).toBeTruthy();
        await user.click(screen.getByTestId('app-assistant-ask-first'));
        expect(onWorkModeChange).toHaveBeenCalledWith('describe');
    });

    it.each(['describe', 'plan'])('in %s mode it says it will ask questions first instead of offering the card', (mode) => {
        render(<AppAssistantWelcome definition={BLANK_APP} workMode={mode} onWorkModeChange={vi.fn()} />);
        expect(screen.getByTestId('app-assistant-ask-first-on')).toBeTruthy();
        expect(screen.queryByTestId('app-assistant-ask-first')).toBeNull();
    });

    it('an existing app says what it sees and sends an idea as an idea', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<AppAssistantWelcome definition={KITCHEN_SINK} tableCount={2} onPick={onPick} />);
        expect(screen.getByText('What would you like to change?')).toBeTruthy();
        expect(screen.getByTestId('app-assistant-seen').textContent).toBe('I can see 2 screens and 2 tables.');
        const ideas = screen.getAllByTestId('app-assistant-idea');
        expect(ideas.length).toBeLessThanOrEqual(3);
        await user.click(ideas[0]);
        expect(onPick).toHaveBeenCalledWith('Explain what this app does, screen by screen', 'idea');
    });

    it('names the selected component and leads with the ideas for it', () => {
        const buttonId = KITCHEN_SINK.screens![0].sections![0].children!.find((c) => c.type === 'button')!.id;
        render(<AppAssistantWelcome definition={KITCHEN_SINK} tableCount={1} selectedNodeId={buttonId} />);
        expect(screen.getByTestId('app-assistant-seen').textContent).toMatch(/You have '.+' selected\./);
        expect(screen.getAllByTestId('app-assistant-idea')[0].textContent).toBe('Connect the selected component to data from a table');
    });
});

describe('welcome helpers', () => {
    it('an app is empty without any component or table', () => {
        expect(isEmptyApp(BLANK_APP, 0)).toBe(true);
        expect(isEmptyApp(BLANK_APP, 1)).toBe(false);
        expect(isEmptyApp(KITCHEN_SINK, 0)).toBe(false);
    });

    it('ideas are at most three: selection first, a table when there is none, then explain and a new screen', () => {
        expect(welcomeIdeas(KITCHEN_SINK, true, 0, t)).toEqual([
            'Connect the selected component to data from a table',
            'Improve the layout of the selected component',
            'Store what people enter in a table',
        ]);
        expect(welcomeIdeas(KITCHEN_SINK, false, 3, t)).toEqual([
            'Explain what this app does, screen by screen',
            'Add a new screen that fits what this app does',
        ]);
    });
});
