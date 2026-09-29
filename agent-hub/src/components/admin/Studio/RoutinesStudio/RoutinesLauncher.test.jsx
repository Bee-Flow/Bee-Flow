import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory scopedStorage so we can assert tab persistence deterministically.
const { store } = vi.hoisted(() => ({ store: new Map() }));
vi.mock('../../../../utils/scopedStorage', () => ({
    default: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, v); },
    },
}));

// Stub the heavy tab components: this test is about the shell's tab bar +
// show/hide logic, not the panels' own data-loading subtrees.
vi.mock('./FindRepeatingWorkTab', () => ({ default: () => <div data-testid="panel-repeating">repeating</div> }));
vi.mock('./TemplatesTab', () => ({ default: () => <div data-testid="panel-templates">templates</div> }));
vi.mock('./AutomationsOverview', () => ({
    default: ({ automations, onCreateBlock }) => (
        <div data-testid="panel-overview">
            overview:{automations.length}
            {onCreateBlock && <button type="button" onClick={onCreateBlock}>overview new block</button>}
        </div>
    ),
}));
// The runs panel is heavy (list + streaming); stub it. Activity gating is its own concern.
vi.mock('../Executions/ExecutionsPanel', () => ({ default: () => <div data-testid="panel-executions">executions</div> }));

import RoutinesLauncher from './RoutinesLauncher.jsx';

const props = {
    segment: 'automation',
    onCreateAutomation: vi.fn(),
    onOpenAutomation: vi.fn(),
    onPickTemplate: vi.fn(),
    onBuildSuggestion: vi.fn(),
    onAskSuggestion: vi.fn(),
};

const isHidden = (testId) => screen.getByTestId(testId).parentElement.className.includes('hidden');

describe('RoutinesLauncher, tabbed launcher', () => {
    beforeEach(() => { cleanup(); store.clear(); });

    it('renders the launcher tabs', () => {
        render(<RoutinesLauncher {...props} />);
        for (const label of ['All automations', 'Find repeating work', 'Templates', 'Runs']) {
            expect(screen.getByRole('button', { name: label })).toBeTruthy();
        }
    });

    it('offers no Build with AI tab (owner, 2026-09-28): the + and the builder assistant cover it', () => {
        render(<RoutinesLauncher {...props} />);
        expect(screen.queryByRole('button', { name: 'Build with AI' })).toBeNull();
    });

    it('offers no Steps tab: building blocks live in the automations list', () => {
        render(<RoutinesLauncher {...props} />);
        expect(screen.queryByRole('button', { name: 'Steps' })).toBeNull();
        expect(screen.queryByTestId('panel-steps')).toBeNull();
    });

    it('a saved Steps tab choice falls back to the overview, like the retired Build tab', () => {
        store.set('routinesStartTab', 'steps');
        render(<RoutinesLauncher {...props} />);
        expect(screen.getByTestId('panel-overview')).toBeTruthy();
        expect(isHidden('panel-repeating')).toBe(true);
        expect(isHidden('panel-templates')).toBe(true);
    });

    it('hands "new building block" to the overview\'s create button', async () => {
        const user = userEvent.setup();
        const onCreateStep = vi.fn();
        render(<RoutinesLauncher {...props} onCreateStep={onCreateStep} />);
        await user.click(screen.getByRole('button', { name: 'overview new block' }));
        expect(onCreateStep).toHaveBeenCalledTimes(1);
    });

    it('defaults to the overview, also for an empty library, and a retired saved tab falls back to it', () => {
        render(<RoutinesLauncher {...props} automations={[{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]} />);
        expect(screen.getByTestId('panel-overview').textContent).toBe('overview:2');
        cleanup();
        render(<RoutinesLauncher {...props} automations={[]} />);
        expect(screen.getByTestId('panel-overview')).toBeTruthy();
        expect(isHidden('panel-repeating')).toBe(true);
        expect(isHidden('panel-templates')).toBe(true);
        // Runs stays MOUNTED but hidden: its `active` prop stands fetching down.
        expect(isHidden('panel-executions')).toBe(true);
        cleanup();
        store.set('routinesStartTab', 'build');
        render(<RoutinesLauncher {...props} />);
        expect(screen.getByTestId('panel-overview')).toBeTruthy();
        // A saved choice for a tab that exists is never overridden.
        cleanup();
        store.set('routinesStartTab', 'templates');
        render(<RoutinesLauncher {...props} automations={[{ id: 'a', title: 'A' }]} />);
        expect(isHidden('panel-templates')).toBe(false);
        expect(screen.queryByTestId('panel-overview')).toBeNull();
    });

    it('switching a tab shows that panel and hides the rest', async () => {
        const user = userEvent.setup();
        render(<RoutinesLauncher {...props} />);
        await user.click(screen.getByRole('button', { name: 'Templates' }));
        expect(isHidden('panel-templates')).toBe(false);
        expect(isHidden('panel-repeating')).toBe(true);
        // Runs shows (full-width) and the narrow launcher column hides.
        await user.click(screen.getByRole('button', { name: 'Runs' }));
        expect(isHidden('panel-executions')).toBe(false);
        expect(isHidden('panel-templates')).toBe(true);
    });

    it('persists the chosen tab and restores it on remount', async () => {
        const user = userEvent.setup();
        const { unmount } = render(<RoutinesLauncher {...props} />);
        await user.click(screen.getByRole('button', { name: 'Find repeating work' }));
        expect(store.get('routinesStartTab')).toBe('repeating');
        unmount();
        render(<RoutinesLauncher {...props} />);
        expect(isHidden('panel-repeating')).toBe(false);
        expect(isHidden('panel-templates')).toBe(true);
    });

    it('the agent-routine pane keeps its simple CTA, no tabs', () => {
        // Reachable by deep link only now: the segmented control is gone and
        // the tab is Automations.
        render(<RoutinesLauncher {...props} segment="prompt_task" onCreateTask={vi.fn()} />);
        expect(screen.getByRole('button', { name: /New agent routine/ })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Templates' })).toBeNull();
    });
});
