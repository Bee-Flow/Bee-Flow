import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/test/http';

const { authFetch, resolveLessonSteps, markLessonComplete } = vi.hoisted(() => ({
    authFetch: vi.fn(),
    resolveLessonSteps: vi.fn(),
    markLessonComplete: vi.fn(),
}));
vi.mock('../../utils/helpers', () => ({ API_BASE: 'https://api.test', authFetch }));
vi.mock('./lessons', () => ({ DEFAULT_LESSON_ID: 'getting-started', LESSON_COMPLETE_EVENT: 'beeflow:lesson-complete', resolveLessonSteps }));
vi.mock('./learningProgress', () => ({ markLessonComplete }));

import OnboardingTour from './OnboardingTour';
import { TOUR_ENSURE_SIDEBAR_EVENT, TOUR_OPEN_DESIGNER_SECTION, TOUR_SEEN_KEY, TOUR_START_EVENT } from './tourSteps';
import type { TourStep } from './OnboardingTour.types';
import scopedStorage from '../../utils/scopedStorage';

/**
 * Characterisation of the guided tour: starting by event and automatically,
 * the card (title, body, progress, buttons, keyboard), the spotlight and card
 * placement around a target, the interactive steps that advance on input, an
 * event or a timeout, and what finishing persists and navigates to. Lessons
 * and progress storage are stubs; the DOM geometry is faked per `data-tour`.
 */

const user = { id: 'u1' };
const step = (id: string, over: Partial<TourStep> = {}): TourStep => ({ id, titleKey: `t.${id}`, titleFallback: `Title ${id}`, bodyKey: `b.${id}`, bodyFallback: `Body ${id}`, ...over });

const rects: Record<string, { top: number; left: number; width: number; height: number }> = {};
const onNavigate = vi.fn();

/** An element the tour can spotlight, with the box the faked layout gives it. */
function addTarget(name: string, box = { top: 100, left: 50, width: 120, height: 40 }, tag = 'div'): HTMLElement {
    const el = document.createElement(tag);
    el.setAttribute('data-tour', name);
    document.body.appendChild(el);
    rects[name] = box;
    return el;
}
const sel = (name: string) => `[data-tour="${name}"]`;

const startTour = (detail?: { lessonId?: string; returnTo?: string }) => act(() => { window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail })); });
const renderTour = (props: { currentPage?: string; user?: { id?: string } | null } = {}) => render(<OnboardingTour user={'user' in props ? props.user : user} onNavigate={onNavigate} currentPage={props.currentPage} />);
const card = () => screen.getByRole('dialog');

beforeEach(() => {
    for (const k of Object.keys(rects)) delete rects[k];
    authFetch.mockReset();
    authFetch.mockImplementation(() => ok({}));
    resolveLessonSteps.mockReset();
    markLessonComplete.mockReset();
    markLessonComplete.mockResolvedValue(undefined);
    onNavigate.mockReset();
    localStorage.clear();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const name = this.getAttribute('data-tour');
        const r = (name && rects[name]) || { top: 0, left: 0, width: 0, height: 0 };
        return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
    });
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    vi.restoreAllMocks();
    document.body.querySelectorAll('[data-tour]').forEach((n) => n.remove());
});

describe('OnboardingTour: starting', () => {
    it('renders nothing until a tour starts, then shows the first step in a dialog', async () => {
        resolveLessonSteps.mockReturnValue([step('a'), step('b'), step('c')]);
        renderTour();
        expect(screen.queryByRole('dialog')).toBeNull();
        startTour();
        expect(resolveLessonSteps).toHaveBeenCalledWith('getting-started', user);
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'beeflow-tour-title');
        expect(screen.getByRole('heading', { name: 'Title a' })).toBeInTheDocument();
        expect(screen.getByText('Body a')).toBeInTheDocument();
        expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Skip tour' })).toHaveLength(2);
        expect(document.body.querySelector('style')?.textContent).toContain('beeflowTourIn');
    });

    it('starts the lesson named in the event and ignores a second start while one runs', async () => {
        resolveLessonSteps.mockReturnValue([step('a'), step('b')]);
        renderTour();
        startTour({ lessonId: 'agents-101' });
        await screen.findByRole('dialog');
        expect(resolveLessonSteps).toHaveBeenCalledWith('agents-101', user);
        startTour({ lessonId: 'other' });
        expect(resolveLessonSteps).toHaveBeenCalledTimes(1);
    });

    it('does not start a lesson that has no steps', () => {
        resolveLessonSteps.mockReturnValue([]);
        renderTour();
        startTour();
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('OnboardingTour: stepping', () => {
    beforeEach(() => { resolveLessonSteps.mockReturnValue([step('a'), step('b'), step('c')]); });

    it('walks forward and back with the buttons and shows the progress', async () => {
        const u = userEvent.setup();
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        await u.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
        expect(screen.getByText('Body b')).toBeInTheDocument();
        await u.click(screen.getByRole('button', { name: 'Back' }));
        expect(screen.getByText('Body a')).toBeInTheDocument();
        await u.click(screen.getByRole('button', { name: 'Next' }));
        await u.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Skip tour' })).toHaveLength(1);
    });

    it('answers the keyboard: arrows and Enter step, Escape closes', async () => {
        const u = userEvent.setup();
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        await u.keyboard('{ArrowRight}');
        expect(screen.getByText('Body b')).toBeInTheDocument();
        await u.keyboard('{ArrowLeft}');
        expect(screen.getByText('Body a')).toBeInTheDocument();
        await u.keyboard('{Enter}');
        expect(screen.getByText('Body b')).toBeInTheDocument();
        await u.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('focuses the card after a moment on a non-interactive step', async () => {
        renderTour();
        startTour();
        await waitFor(() => expect(card()).toHaveFocus());
    });

    it('moves focus back to the card on every step', async () => {
        resolveLessonSteps.mockReturnValue([step('a'), step('b')]);
        const u = userEvent.setup();
        renderTour();
        startTour();
        await waitFor(() => expect(card()).toHaveFocus());
        await u.click(screen.getByRole('button', { name: 'Next' }));
        expect(card()).not.toHaveFocus();
        await waitFor(() => expect(card()).toHaveFocus());
    });
});

describe('OnboardingTour: finishing', () => {
    it('the intro lesson stores the flag, posts it, records progress and tells the Learning Center', async () => {
        resolveLessonSteps.mockReturnValue([step('a', { navigateTo: 'settings' }), step('b')]);
        const completed = vi.fn();
        window.addEventListener('beeflow:lesson-complete', completed);
        const u = userEvent.setup();
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        expect(onNavigate).toHaveBeenCalledWith('settings');
        await u.click(screen.getByRole('button', { name: 'Next' }));
        await u.click(screen.getByRole('button', { name: 'Got it' }));
        await waitFor(() => expect(completed).toHaveBeenCalled());
        window.removeEventListener('beeflow:lesson-complete', completed);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(scopedStorage.getItem(TOUR_SEEN_KEY)).toBe('1');
        expect(authFetch).toHaveBeenCalledWith('https://api.test/ai/user-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [TOUR_SEEN_KEY]: true }) });
        expect(markLessonComplete).toHaveBeenCalledWith(user, 'getting-started');
        expect((completed.mock.calls[0][0] as CustomEvent).detail).toEqual({ lessonId: 'getting-started' });
        // first-time onboarding: a tour that navigated hands the learner back to chat
        expect(onNavigate).toHaveBeenLastCalledWith('agents');
    });

    it('another lesson records progress only, and returns to the starter when it named one', async () => {
        resolveLessonSteps.mockReturnValue([step('a')]);
        const u = userEvent.setup();
        renderTour();
        startTour({ lessonId: 'agents-101', returnTo: 'settings/learning' });
        await screen.findByRole('dialog');
        await u.click(screen.getByRole('button', { name: 'Got it' }));
        await waitFor(() => expect(markLessonComplete).toHaveBeenCalledWith(user, 'agents-101'));
        expect(authFetch).not.toHaveBeenCalledWith('https://api.test/ai/user-settings', expect.objectContaining({ method: 'POST' }));
        expect(scopedStorage.getItem(TOUR_SEEN_KEY)).toBeNull();
        expect(onNavigate).toHaveBeenCalledWith('settings/learning');
    });

    it('skipping from the close button finishes the same way, and a failing save does not stop it', async () => {
        resolveLessonSteps.mockReturnValue([step('a'), step('b')]);
        authFetch.mockImplementation(() => Promise.reject(new Error('offline')));
        markLessonComplete.mockRejectedValue(new Error('x'));
        const completed = vi.fn();
        window.addEventListener('beeflow:lesson-complete', completed);
        const u = userEvent.setup();
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        await u.click(screen.getAllByRole('button', { name: 'Skip tour' })[0]);
        await waitFor(() => expect(completed).toHaveBeenCalled());
        window.removeEventListener('beeflow:lesson-complete', completed);
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('OnboardingTour: auto-start', () => {
    const settle = () => waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument(), { timeout: 3000 });

    beforeEach(() => { resolveLessonSteps.mockReturnValue([step('a')]); });

    it('starts the intro after a pause for a first-time user on the chat home', async () => {
        renderTour({ currentPage: 'agents' });
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith('https://api.test/ai/user-settings'));
        expect(screen.queryByRole('dialog')).toBeNull();
        await settle();
        expect(resolveLessonSteps).toHaveBeenCalledWith('getting-started', user);
    });

    it('starts without a current page too', async () => {
        renderTour();
        await settle();
    });

    it('stays away when the local flag says it was seen', async () => {
        scopedStorage.setCurrentUser('u1');
        scopedStorage.setItem(TOUR_SEEN_KEY, '1');
        renderTour({ currentPage: 'agents' });
        await new Promise((r) => setTimeout(r, 50));
        expect(authFetch).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('stays away when the server says it was seen', async () => {
        authFetch.mockImplementation(() => ok({ [TOUR_SEEN_KEY]: true }));
        renderTour({ currentPage: 'agents' });
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 1100));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('waits for the chat home, for a user, and for a desktop-width window', async () => {
        const { unmount } = renderTour({ currentPage: 'settings' });
        await new Promise((r) => setTimeout(r, 50));
        expect(authFetch).not.toHaveBeenCalled();
        unmount();
        renderTour({ user: null, currentPage: 'agents' });
        await new Promise((r) => setTimeout(r, 50));
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('does not auto-start on a narrow window', async () => {
        vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(500);
        renderTour({ currentPage: 'agents' });
        await new Promise((r) => setTimeout(r, 50));
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('does not block on a failing settings fetch', async () => {
        authFetch.mockImplementation(() => Promise.reject(new Error('x')));
        renderTour({ currentPage: 'agents' });
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('OnboardingTour: spotlight and placement', () => {
    it('centres the card when a step has no target', async () => {
        resolveLessonSteps.mockReturnValue([step('a')]);
        renderTour();
        startTour();
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveStyle({ top: '279px', left: '342px', width: '340px' });
        expect(document.body.querySelector('[aria-hidden="true"][style*="inset"]')).not.toBeNull();
    });

    it('cuts a spotlight around the target and puts the card to its right', async () => {
        addTarget('x');
        resolveLessonSteps.mockReturnValue([step('a', { target: sel('x') })]);
        renderTour();
        startTour();
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => expect(dialog).toHaveStyle({ top: '92px', left: '186px' }));
        const spot = document.body.querySelector('[aria-hidden="true"][style*="box-shadow"]');
        expect(spot).toHaveStyle({ top: '92px', left: '42px', width: '136px', height: '56px' });
        expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
    });

    it.each([
        ['left', { top: '100px', left: '16px' }],
        ['top', { top: '16px', left: '50px' }],
        ['bottom', { top: '156px', left: '50px' }],
        ['center', { top: '279px', left: '342px' }],
    ])('places the card %s of the target', async (placement, expected) => {
        addTarget('x');
        resolveLessonSteps.mockReturnValue([step('a', { target: sel('x'), placement })]);
        renderTour();
        startTour();
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => expect(document.body.querySelector('[aria-hidden="true"][style*="box-shadow"]')).not.toBeNull());
        expect(dialog).toHaveStyle(expected);
    });

    it('falls back to the centred card when the target never shows', async () => {
        resolveLessonSteps.mockReturnValue([step('a', { target: sel('missing'), timeoutMs: 80 })]);
        renderTour();
        startTour();
        const dialog = await screen.findByRole('dialog');
        await new Promise((r) => setTimeout(r, 200));
        expect(dialog).toHaveStyle({ top: '279px', left: '342px' });
    });

    it('skips an optional step whose target never shows', async () => {
        resolveLessonSteps.mockReturnValue([step('a', { target: sel('missing'), timeoutMs: 80, optional: true }), step('b')]);
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        await waitFor(() => expect(screen.getByText('Body b')).toBeInTheDocument());
    });

    it('follows the target when the window scrolls', async () => {
        addTarget('x');
        resolveLessonSteps.mockReturnValue([step('a', { target: sel('x') })]);
        renderTour();
        startTour();
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => expect(dialog).toHaveStyle({ top: '92px' }));
        rects.x = { top: 200, left: 50, width: 120, height: 40 };
        act(() => { window.dispatchEvent(new Event('scroll')); });
        await waitFor(() => expect(dialog).toHaveStyle({ top: '192px' }));
    });
});

describe('OnboardingTour: step set-up', () => {
    it('opens the sidebar and the designer section a step needs, and navigates', async () => {
        const ensure = vi.fn();
        const open = vi.fn();
        window.addEventListener(TOUR_ENSURE_SIDEBAR_EVENT, ensure);
        window.addEventListener(TOUR_OPEN_DESIGNER_SECTION, open);
        resolveLessonSteps.mockReturnValue([step('a', { ensureSidebarOpen: true, revealSection: 'tools', navigateTo: 'agents/new' })]);
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        window.removeEventListener(TOUR_ENSURE_SIDEBAR_EVENT, ensure);
        window.removeEventListener(TOUR_OPEN_DESIGNER_SECTION, open);
        expect(ensure).toHaveBeenCalledTimes(1);
        expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'tools' });
        expect(onNavigate).toHaveBeenCalledWith('agents/new');
    });

    it('reveals the context a registered anchor lives in', async () => {
        const open = vi.fn();
        window.addEventListener(TOUR_OPEN_DESIGNER_SECTION, open);
        resolveLessonSteps.mockReturnValue([step('a', { target: '[data-tour="agent-tools"]' })]);
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        window.removeEventListener(TOUR_OPEN_DESIGNER_SECTION, open);
        expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'tools' });
    });

    it('skips a step that needs an agent nobody created', async () => {
        resolveLessonSteps.mockReturnValue([step('a', { requiresAgentCreated: true }), step('b')]);
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        await waitFor(() => expect(screen.getByText('Body b')).toBeInTheDocument());
        expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();
    });
});

describe('OnboardingTour: interactive steps', () => {
    const interactive = (over: Partial<TourStep>) => step('a', { interactive: true, actionHintKey: 'h.a', actionHintFallback: 'Type something', ...over });

    it('shows the hint instead of Next/Back, lets the page through and ignores the arrows', async () => {
        resolveLessonSteps.mockReturnValue([step('p'), interactive({})]);
        const u = userEvent.setup();
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        await u.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByText('Type something')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
        expect(card()).not.toHaveAttribute('aria-modal');
        await u.keyboard('{ArrowLeft}{ArrowRight}{Enter}');
        expect(screen.getByText('Type something')).toBeInTheDocument();
    });

    it('advances once the target field holds enough text', async () => {
        const input = addTarget('field', { top: 10, left: 10, width: 200, height: 30 }, 'input');
        resolveLessonSteps.mockReturnValue([interactive({ target: sel('field'), advanceOn: { input: { minLength: 3 } } }), step('b')]);
        const u = userEvent.setup();
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
        await u.type(input, 'ab');
        expect(screen.getByText('Type something')).toBeInTheDocument();
        await u.type(input, 'c');
        await waitFor(() => expect(screen.getByText('Body b')).toBeInTheDocument());
    });

    it('advances on a window event whose detail passes the predicate', async () => {
        resolveLessonSteps.mockReturnValue([interactive({ advanceOn: { event: 'app:thing', predicate: (event) => 'good' in event && event.good === true } }), step('b')]);
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        act(() => { window.dispatchEvent(new CustomEvent('app:thing', { detail: { good: false } })); });
        expect(screen.getByText('Type something')).toBeInTheDocument();
        act(() => { window.dispatchEvent(new CustomEvent('app:thing', { detail: { good: true } })); });
        await waitFor(() => expect(screen.getByText('Body b')).toBeInTheDocument());
    });

    it('advances on its own timeout', async () => {
        resolveLessonSteps.mockReturnValue([interactive({ advanceOn: { timeoutMs: 60 } }), step('b')]);
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        await waitFor(() => expect(screen.getByText('Body b')).toBeInTheDocument());
    });

    it('advances when the target it was showing leaves the page, and remembers the agent was created', async () => {
        const el = addTarget('prompt');
        resolveLessonSteps.mockReturnValue([interactive({ target: sel('prompt'), advanceOn: { targetGone: true } }), step('b', { requiresAgentCreated: true }), step('c')]);
        renderTour();
        startTour();
        await screen.findByRole('dialog');
        await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
        el.remove();
        await waitFor(() => expect(screen.getByText('Body b')).toBeInTheDocument());
        expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    });
});
