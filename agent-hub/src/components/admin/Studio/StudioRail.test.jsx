import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Bot, Sparkles, Table2 } from 'lucide-react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The rail's own contract (H1). Sidebar.studioNav.test.jsx covers the SWAP
 * (which pages hand over to the rail and which keep the sidebar); this file
 * covers what the rail then does with the rows it was handed.
 *
 * The two behaviours worth guarding are both "do not claim what you do not
 * know": a count that is absent stays absent rather than rendering 0, and a
 * locked row is a signpost that cannot be walked through.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn(async () => ({ ok: false })) }));

vi.mock('../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, vars) => {
            const base = fallback || key;
            return vars ? Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), base) : base;
        },
        locale: 'en',
    });
    return { default: useTranslation, useTranslation };
});
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
vi.mock('../../shell/NavLink', () => ({ default: ({ children, ...p }) => <a {...p}>{children}</a> }));

import StudioRail from './StudioRail.jsx';

const SECTIONS = [
    { id: 'aiTasks', urlSegment: 'automations', labelKey: 'studio.tab.automations', labelFallback: 'Automations', Icon: Table2, kind: 'automation', countKey: 'automations', category: 'build', locked: null },
    { id: 'datatables', urlSegment: 'datatables', labelKey: 'studio.tab.datatables', labelFallback: 'Datatables', Icon: Table2, kind: 'datatable', category: 'build', locked: 'ceiling' },
    { id: 'agents', urlSegment: 'agents', labelKey: 'studio.tab.agents', labelFallback: 'Agents', Icon: Bot, kind: 'agent', category: 'ai', locked: null },
    { id: 'skills', urlSegment: 'skills', labelKey: 'studio.tab.skills', labelFallback: 'Skills', Icon: Sparkles, kind: 'skill', category: 'ai', locked: null },
];

const renderRail = (props = {}) => render(
    <StudioRail
        sections={SECTIONS}
        onNavigate={vi.fn()}
        user={{ id: 'u1', displayName: 'Ada' }}
        onLogout={() => {}}
        currentPage="studio"
        profileRef={{ current: null }}
        showProfileMenu={false}
        setShowProfileMenu={() => {}}
        {...props}
    />
);

describe('StudioRail', () => {
    beforeEach(() => { cleanup(); fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: false }); });

    it('is a 240px rail with a brand row, a Start row and the account footer', () => {
        renderRail();
        const rail = screen.getByTestId('studio-rail');
        expect(rail.className).toContain('w-60');
        expect(rail.className).toContain('bg-[var(--bg-secondary)]');
        expect(rail.className).toContain('border-r');
        expect(screen.getByText('Studio')).toBeTruthy();
        expect(screen.getByTestId('rail-start')).toBeTruthy();
        expect(screen.getByTestId('sidebar-profile')).toBeTruthy();
    });

    it('keeps the tour anchor the sidebar row used to carry', () => {
        // tourAnchors.js registers 'nav-studio' with owner Sidebar.jsx and two
        // lessons spotlight it. On a Studio page that row is not rendered any
        // more, so without this the lesson silently degrades to a centred card.
        renderRail();
        expect(document.querySelector('[data-tour="nav-studio"]')).toBeTruthy();
    });

    it('sends "← Chat" back to the workspace, and Start to its own segment', () => {
        const onNavigate = vi.fn();
        renderRail({ onNavigate });
        fireEvent.click(screen.getByTestId('studio-rail-back-to-chat'));
        expect(onNavigate).toHaveBeenCalledWith('agents');
        fireEvent.click(screen.getByTestId('rail-start'));
        expect(onNavigate).toHaveBeenCalledWith('studio/start');
    });

    it('groups the sections under their registry headings and navigates by urlSegment', () => {
        const onNavigate = vi.fn();
        renderRail({ onNavigate });
        const headings = [...document.querySelectorAll('[data-testid="studio-rail-nav"] .uppercase')].map(n => n.textContent);
        expect(headings).toEqual(['Build', 'AI']);
        fireEvent.click(screen.getByTestId('rail-skills'));
        expect(onNavigate).toHaveBeenCalledWith('studio/skills');
    });

    it('marks the active row as a raised card and gives it NO accent bar', () => {
        renderRail({ activeSection: 'skills' });
        const active = screen.getByTestId('rail-skills');
        expect(active.getAttribute('aria-current')).toBe('page');
        expect(active.className).toContain('bg-[var(--bg-card)]');
        expect(active.className).toContain('shadow-sm');
        expect(screen.getByTestId('rail-agents').getAttribute('aria-current')).toBeNull();
        // The deliberate deviation: every other nav surface draws the 3px bar
        // (NavRow.jsx's inline div, FlyoutRow.jsx's ACCENT_BAR). Not in here.
        expect(document.querySelector('[data-testid="studio-rail"] .bg-\\[var\\(--accent-primary\\)\\]')).toBeNull();
    });

    it('shows a count only once it is known — and 0 IS known', () => {
        // No counts yet: the row shows no number rather than a placeholder 0.
        renderRail();
        expect(screen.queryByTestId('rail-aiTasks-count')).toBeNull();

        cleanup();
        // A key the server omitted (a kind this caller may not see) also stays
        // absent; a real 0 renders.
        renderRail({ studioCounts: { automations: 0 } });
        expect(screen.getByTestId('rail-aiTasks-count').textContent).toBe('0');
        expect(screen.queryByTestId('rail-agents-count')).toBeNull();
    });

    it('a locked row is a signpost, not a door', () => {
        const onNavigate = vi.fn();
        renderRail({ onNavigate });
        const locked = screen.getByTestId('rail-datatables');
        expect(locked.getAttribute('aria-disabled')).toBe('true');
        // aria-disabled, NOT the disabled attribute: a disabled button takes
        // no focus and shows no title tooltip in Firefox, so the hint would
        // reach nobody.
        expect(locked.hasAttribute('disabled')).toBe(false);
        expect(screen.getByTestId('rail-datatables-lock-hint').textContent).toBeTruthy();
        expect(locked.getAttribute('title')).toBeTruthy();
        fireEvent.click(locked);
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('de rijnaam komt uit de gedeelde studioSectionLabel — ook zonder sleutel', () => {
        // Deze rij hield ooit zijn eigen kopie van die helper, en die kopie
        // miste de terugval: een beschrijver zonder label() én zonder labelKey
        // vroeg er `t(undefined)` en tekende een NAAMLOZE rij. De gedeelde
        // versie valt terug op labelFallback en dan op de id.
        renderRail({
            sections: [
                ...SECTIONS,
                { id: 'uptime', urlSegment: 'uptime', label: (_t, locale) => `Uptime (${locale})`, Icon: Bot, runtime: true, category: 'modules', locked: null },
                { id: 'orphan', urlSegment: 'orphan', Icon: Bot, runtime: true, category: 'modules', locked: null },
            ],
        });
        // Ingebouwd: sleutel met Engelse terugval.
        expect(screen.getByTestId('rail-agents').textContent).toContain('Agents');
        // Runtime-module: haar eigen locale-bewuste label() wint.
        expect(screen.getByTestId('rail-uptime').textContent).toContain('Uptime (en)');
        // En nooit een lege rij.
        expect(screen.getByTestId('rail-orphan').textContent).toContain('orphan');
    });

    it('a runtime module without a countKey never wears a first-party number', () => {
        renderRail({
            sections: [...SECTIONS, { id: 'agents_module', urlSegment: 'uptime', label: () => 'Uptime', Icon: Bot, runtime: true, category: 'modules', locked: null }],
            // 'agents' is a real counts key; the module's id is not it, but a
            // careless `countKey || id` fallback would still find one.
            studioCounts: { agents: 7, agents_module: 3 },
        });
        expect(screen.queryByTestId('rail-agents_module-count')).toBeNull();
    });
});

describe('StudioRail — the search pill', () => {
    beforeEach(() => { cleanup(); fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: false }); });
    afterEach(() => cleanup());

    it('opens the Studio search overlay', () => {
        renderRail();
        expect(screen.queryByTestId('studio-search-overlay')).toBeNull();
        fireEvent.click(screen.getByTestId('studio-rail-search'));
        expect(screen.getByTestId('studio-search-overlay')).toBeTruthy();
    });

    it('takes ⌘K away from the other two window listeners while it is mounted', () => {
        // Two bubble-phase window listeners already claim this chord (the
        // hub's conversation search and the embedded builder's quick
        // switcher), so on /app/studio/automations one keystroke opened two
        // things. The rail binds in the CAPTURE phase and stops the event
        // there, so exactly one thing opens.
        const other = vi.fn();
        window.addEventListener('keydown', other);
        try {
            renderRail();
            fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
            expect(screen.getByTestId('studio-search-overlay')).toBeTruthy();
            expect(other).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('keydown', other);
        }
    });

    it('leaves modifier variants alone — they belong to the browser', () => {
        const other = vi.fn();
        window.addEventListener('keydown', other);
        try {
            renderRail();
            fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true, shiftKey: true });
            fireEvent.keyDown(document.body, { key: 'j', ctrlKey: true });
            expect(screen.queryByTestId('studio-search-overlay')).toBeNull();
            expect(other).toHaveBeenCalledTimes(2);
        } finally {
            window.removeEventListener('keydown', other);
        }
    });

    it('unbinds ⌘K when the rail unmounts, so the hub gets its chord back', () => {
        const { unmount } = renderRail();
        unmount();
        const other = vi.fn();
        window.addEventListener('keydown', other);
        try {
            fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
            expect(other).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('keydown', other);
        }
    });
});


describe('StudioRail — a surface that owns ⌘K for its own content', () => {
    beforeEach(() => { cleanup(); fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: false }); });
    afterEach(() => { cleanup(); document.querySelectorAll('[data-quick-open-owner]').forEach(n => n.remove()); });

    /**
     * The capture-phase takeover above is right about the DOUBLE opening and
     * wrong about which one should win on /app/studio/automations: the
     * builder's quick switcher lists the routines and steps of the thing on
     * screen, and Studio's search does not. Taking the chord there did not
     * disambiguate it, it removed the only answer to the question the person
     * standing in the builder was asking.
     */
    const owner = () => {
        const el = document.createElement('div');
        el.setAttribute('data-quick-open-owner', 'automations');
        document.body.appendChild(el);
        return el;
    };

    it('keeps its hands off entirely while an owner is on screen', () => {
        const other = vi.fn();
        window.addEventListener('keydown', other);
        try {
            renderRail();
            owner();
            fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
            // Not the rail's overlay, and the owner's own bubble-phase
            // listener was allowed to run.
            expect(screen.queryByTestId('studio-search-overlay')).toBeNull();
            expect(other).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('keydown', other);
        }
    });

    it('takes the chord back the moment the owner leaves', () => {
        // Checked per keystroke rather than once on mount: the builder mounts
        // and unmounts under a rail that never re-renders for it.
        renderRail();
        const el = owner();
        fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
        expect(screen.queryByTestId('studio-search-overlay')).toBeNull();
        el.remove();
        fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
        expect(screen.getByTestId('studio-search-overlay')).toBeTruthy();
    });
});

describe('StudioRail — Approvals', () => {
    beforeEach(() => { cleanup(); fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: false }); });
    afterEach(() => cleanup());

    /**
     * The rail REPLACES the sidebar on /app/studio*, and the sidebar's
     * top-level Approvals row is the only entrance there is — the Studio panel
     * stopped listing it. Without a row here, walking into Studio took away
     * both the way in and the pending badge.
     */
    it('is reachable from inside Studio, not only from outside it', () => {
        const onNavigate = vi.fn();
        renderRail({ canBrowseApprovals: true, onNavigate });
        fireEvent.click(screen.getByTestId('rail-approvals'));
        expect(onNavigate).toHaveBeenCalledWith('studio/approvals');
    });

    it('carries the pending badge', () => {
        renderRail({ canBrowseApprovals: true, pendingApprovalCount: 3 });
        expect(screen.getByTestId('rail-approvals-count').textContent).toBe('3');
    });

    it('stays visible with an empty queue, but says nothing rather than "0"', () => {
        // The decided ones are a record people go looking for, so the row
        // outlives the queue; the badge does not.
        renderRail({ canBrowseApprovals: true, pendingApprovalCount: 0 });
        expect(screen.getByTestId('rail-approvals')).toBeTruthy();
        expect(screen.queryByTestId('rail-approvals-count')).toBeNull();
    });

    it('is absent for an org that cannot browse approvals at all', () => {
        renderRail({ canBrowseApprovals: false, pendingApprovalCount: 9 });
        expect(screen.queryByTestId('rail-approvals')).toBeNull();
    });

    it('marks itself current on the approvals section', () => {
        renderRail({ canBrowseApprovals: true, activeSection: 'approvals' });
        expect(screen.getByTestId('rail-approvals').getAttribute('aria-current')).toBe('page');
    });
});
