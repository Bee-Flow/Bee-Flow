// The introduction of Cowork (./CoworkIntroduction.tsx): Bee tells one short story by herself, a newcomer can step
// through it or leave it, and it ends on the choice of a view.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import CoworkIntroduction from './CoworkIntroduction';

afterEach(() => { vi.useRealTimers(); });

const currentStep = () => document.querySelector('li[aria-current="step"]')?.textContent ?? '';

it('tells the story by itself: the request, the steps Bee builds and tests, the result, the team, then the choice', () => {
    vi.useFakeTimers();
    render(<CoworkIntroduction choose={vi.fn()} />);
    const until = (appears: () => unknown) => {
        for (let tick = 0; tick < 40 && !appears(); tick++) act(() => { vi.advanceTimersByTime(8000); });
        expect(appears()).toBeTruthy();
    };
    expect(screen.getByText(/Hi, I’m Bee\./)).toBeInTheDocument();
    // The steps are part of the layout from the start and only shown while Bee works on them.
    expect(screen.queryByRole('button', {name: /Skip empty notes/})).toBeNull();
    until(() => screen.queryByText('Make me a weekly digest of our meetings.'));
    until(() => screen.queryByRole('button', {name: /Look back one week/}));
    expect(currentStep()).toContain('Look back one week');
    until(() => screen.queryByText(/One note turns out to be empty\./));
    expect(currentStep()).toContain('Skip empty notes');
    until(() => screen.queryByText('Weekly digest'));
    expect(currentStep()).toContain('Write the digest');
    until(() => screen.queryByText('Waiting for Noor to accept'));
    expect(screen.queryByRole('button', {name: /Skip empty notes/})).toBeNull();
    until(() => screen.queryByText('Accepted · Starts after the weekly digest'));
    expect(screen.getByText('You · Weekly digest')).toBeInTheDocument();
    until(() => screen.queryByRole('button', {name: 'Chat only'}));
    expect(screen.getByText('How would you like to work with me?')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Skip intro'})).toBeNull();
});

it('lets a newcomer step ahead and back, skip to the choice and watch the story again', async () => {
    const user = userEvent.setup();
    const choose = vi.fn();
    render(<CoworkIntroduction choose={choose} />);
    expect(screen.getByRole('button', {name: 'Back'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Next'}));
    expect(await screen.findByText(/Imagine a week full of meetings\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Back'}));
    expect(await screen.findByText(/Hi, I’m Bee\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Skip intro'}));
    const orb = await screen.findByRole('button', {name: 'Chat with the orb'});
    expect(orb).toHaveFocus();
    expect(orb).toHaveAccessibleDescription('I show what I’m doing while we talk.');
    await user.click(screen.getByRole('button', {name: 'Watch the intro again'}));
    expect(await screen.findByText(/Hi, I’m Bee\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Skip intro'}));
    await user.click(await screen.findByRole('button', {name: 'Advanced'}));
    expect(choose).toHaveBeenCalledWith('advanced');
});

it('opens on the choice for someone who saw the story and only wants another view', () => {
    render(<CoworkIntroduction choose={vi.fn()} atChoice />);
    expect(screen.getByRole('button', {name: 'Chat only'})).toBeInTheDocument();
    expect(screen.queryByText(/Hi, I’m Bee\./)).toBeNull();
    expect(screen.getByRole('button', {name: 'Watch the intro again'})).toBeInTheDocument();
});
