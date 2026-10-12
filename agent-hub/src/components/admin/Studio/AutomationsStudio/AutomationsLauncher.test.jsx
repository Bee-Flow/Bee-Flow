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
// The repeating tab stub hands its two ways into the builder back as buttons.
vi.mock('./FindRepeatingWorkTab', () => ({
    default: ({ onBuildSuggestion, onAskSuggestion }) => (
        <div data-testid="panel-repeating">
            repeating
            <button type="button" onClick={() => onBuildSuggestion({ id: 's1', title: 'Log invoices' })}>tab build</button>
            <button type="button" onClick={() => onAskSuggestion({ id: 's1', title: 'Log invoices' })}>tab adjust</button>
        </div>
    ),
}));
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

import AutomationsLauncher from './AutomationsLauncher.jsx';

const props = {
    segment: 'automation',
    onCreateAutomation: vi.fn(),
    onOpenAutomation: vi.fn(),
    onPickTemplate: vi.fn(),
    onBuildSuggestion: vi.fn(),
    onAskSuggestion: vi.fn(),
};

const isHidden = (testId) => screen.getByTestId(testId).parentElement.className.includes('hidden');

describe('AutomationsLauncher, tabbed launcher', () => {
    beforeEach(() => { cleanup(); store.clear(); });

    it('renders the launcher tabs', () => {
        render(<AutomationsLauncher {...props} />);
        // The English of automations.tabs.overview|repeating|templates|history.
        for (const label of ['All automations', 'Find repeating work', 'Templates', 'Runs']) {
            expect(screen.getByRole('button', { name: label })).toBeTruthy();
        }
    });

    it('offers no Build with AI tab (owner, 2026-09-28): the + and the builder assistant cover it', () => {
        render(<AutomationsLauncher {...props} />);
        expect(screen.queryByRole('button', { name: 'Build with AI' })).toBeNull();
    });

    it('offers no Steps tab: building blocks live in the automations list', () => {
        render(<AutomationsLauncher {...props} />);
        expect(screen.queryByRole('button', { name: 'Steps' })).toBeNull();
        expect(screen.queryByTestId('panel-steps')).toBeNull();
    });

    it('a saved Steps tab choice falls back to the overview, like the retired Build tab', () => {
        store.set('automationsStartTab', 'steps');
        render(<AutomationsLauncher {...props} />);
        expect(screen.getByTestId('panel-overview')).toBeTruthy();
        expect(isHidden('panel-repeating')).toBe(true);
        expect(isHidden('panel-templates')).toBe(true);
    });

    it('hands "new building block" to the overview\'s create button', async () => {
        const user = userEvent.setup();
        const onCreateStep = vi.fn();
        render(<AutomationsLauncher {...props} onCreateStep={onCreateStep} />);
        await user.click(screen.getByRole('button', { name: 'overview new block' }));
        expect(onCreateStep).toHaveBeenCalledTimes(1);
    });

    it('defaults to the overview, also for an empty library, and a retired saved tab falls back to it', () => {
        render(<AutomationsLauncher {...props} automations={[{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]} />);
        expect(screen.getByTestId('panel-overview').textContent).toBe('overview:2');
        cleanup();
        render(<AutomationsLauncher {...props} automations={[]} />);
        expect(screen.getByTestId('panel-overview')).toBeTruthy();
        expect(isHidden('panel-repeating')).toBe(true);
        expect(isHidden('panel-templates')).toBe(true);
        // Runs stays MOUNTED but hidden: its `active` prop stands fetching down.
        expect(isHidden('panel-executions')).toBe(true);
        cleanup();
        store.set('automationsStartTab', 'build');
        render(<AutomationsLauncher {...props} />);
        expect(screen.getByTestId('panel-overview')).toBeTruthy();
        // A saved choice for a tab that exists is never overridden.
        cleanup();
        store.set('automationsStartTab', 'templates');
        render(<AutomationsLauncher {...props} automations={[{ id: 'a', title: 'A' }]} />);
        expect(isHidden('panel-templates')).toBe(false);
        expect(screen.queryByTestId('panel-overview')).toBeNull();
    });

    it('switching a tab shows that panel and hides the rest', async () => {
        const user = userEvent.setup();
        render(<AutomationsLauncher {...props} />);
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
        const { unmount } = render(<AutomationsLauncher {...props} />);
        await user.click(screen.getByRole('button', { name: 'Find repeating work' }));
        expect(store.get('automationsStartTab')).toBe('repeating');
        unmount();
        render(<AutomationsLauncher {...props} />);
        expect(isHidden('panel-repeating')).toBe(false);
        expect(isHidden('panel-templates')).toBe(true);
    });
});

describe('AutomationsLauncher, Find repeating work', () => {
    beforeEach(() => { cleanup(); store.clear(); });

    it('hands Build this and Adjust first from the repeating tab to the builder callbacks', async () => {
        const user = userEvent.setup();
        const onBuildSuggestion = vi.fn();
        const onAskSuggestion = vi.fn();
        render(<AutomationsLauncher {...props} onBuildSuggestion={onBuildSuggestion} onAskSuggestion={onAskSuggestion} />);
        await user.click(screen.getByRole('button', { name: 'Find repeating work' }));
        await user.click(screen.getByRole('button', { name: 'tab build' }));
        expect(onBuildSuggestion).toHaveBeenCalledWith({ id: 's1', title: 'Log invoices' });
        await user.click(screen.getByRole('button', { name: 'tab adjust' }));
        expect(onAskSuggestion).toHaveBeenCalledWith({ id: 's1', title: 'Log invoices' });
    });
});
