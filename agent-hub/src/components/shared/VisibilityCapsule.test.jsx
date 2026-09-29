import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The widening question goes through the product's own confirm. A spy stands
// in so each test can say yes or no without a dialog on screen.
const { confirmSpy } = vi.hoisted(() => ({ confirmSpy: vi.fn() }));
vi.mock('./useConfirm', () => ({
    default: () => ({ confirm: confirmSpy, confirmDialog: null }),
}));

import AudienceRows from './AudienceRows';
import VisibilityCapsule, { audienceModeOf, audienceLabel, makeGroupNamer } from './VisibilityCapsule';
import PublishMenu from '../agents/AgentWizard/pickers/PublishMenu';

const ORG_GROUPS = [
    { id: 'g1', name: 'Sales' },
    { id: 'g2', name: 'Support' },
    { id: 'g3', name: 'Finance' },
];

function renderCapsule(props = {}) {
    const handlers = {
        onToggle: vi.fn(),
        onClose: vi.fn(),
        onSetPersonal: vi.fn(),
        onSetEntireOrg: vi.fn(),
        onToggleGroup: vi.fn(),
    };
    const utils = render(
        <VisibilityCapsule
            agent={{ id: 'a1', name: 'Quote helper' }}
            isPublished={false}
            sharedGroups={[]}
            orgGroups={ORG_GROUPS}
            {...handlers}
            {...props}
        />,
    );
    return { ...utils, ...handlers };
}

const trigger = () => screen.getByTestId('visibility-capsule');
const option = (mode) => document.querySelector(`[data-audience-option="${mode}"]`);
const groupBox = (name) => within(screen.getByTestId('visibility-group-list')).getByLabelText(name);

beforeEach(() => {
    confirmSpy.mockReset();
    confirmSpy.mockResolvedValue(true);
});

describe('audience derivation', () => {
    it('reads the three modes off isPublished + sharedGroups', () => {
        expect(audienceModeOf({ isPublished: false, sharedGroups: ['g1'] })).toBe('personal');
        expect(audienceModeOf({ isPublished: true, sharedGroups: [] })).toBe('org');
        expect(audienceModeOf({ isPublished: true, sharedGroups: ['g1'] })).toBe('groups');
    });

    it('treats an empty group list on a published thing as the whole organisation, never "nobody"', () => {
        expect(audienceModeOf({ isPublished: true, sharedGroups: undefined })).toBe('org');
        expect(audienceModeOf({ isPublished: true, sharedGroups: null })).toBe('org');
    });

    it('labels by name: one named group, a count for several, a plain count when the name is unknown', () => {
        const t = (k, fb, p) => Object.entries(p || {}).reduce((s, [key, v]) => s.replace(`{${key}}`, String(v)), fb);
        const nameOf = makeGroupNamer({ groupNames: { g9: 'Legal' }, orgGroups: ORG_GROUPS });
        expect(audienceLabel(t, 'personal', [], nameOf)).toBe('Personal');
        expect(audienceLabel(t, 'org', [], nameOf)).toBe('Entire organisation');
        expect(audienceLabel(t, 'groups', ['g1'], nameOf)).toBe('Group Sales');
        expect(audienceLabel(t, 'groups', ['g9'], nameOf)).toBe('Group Legal');
        expect(audienceLabel(t, 'groups', ['unknown'], nameOf)).toBe('1 group');
        expect(audienceLabel(t, 'groups', ['g1', 'g2', 'g3'], nameOf)).toBe('3 groups');
    });
});

describe('VisibilityCapsule trigger', () => {
    it('shows Personal for an unpublished thing', () => {
        renderCapsule({ isPublished: false });
        expect(trigger()).toHaveTextContent('Personal');
        expect(trigger()).toHaveAttribute('data-mode', 'personal');
    });

    it('shows Entire organisation when published with no groups', () => {
        renderCapsule({ isPublished: true, sharedGroups: [] });
        expect(trigger()).toHaveTextContent('Entire organisation');
        expect(trigger()).toHaveAttribute('data-mode', 'org');
        expect(trigger()).not.toHaveTextContent('Published');
    });

    it('names the group from the org directory, and counts several', () => {
        const { rerender } = renderCapsule({ isPublished: true, sharedGroups: ['g1'] });
        expect(trigger()).toHaveTextContent('Group Sales');
        expect(trigger()).toHaveAttribute('data-mode', 'groups');
        rerender(
            <VisibilityCapsule
                isPublished
                sharedGroups={['g1', 'g2', 'g3']}
                orgGroups={ORG_GROUPS}
                onToggle={() => {}} onClose={() => {}} onSetPersonal={() => {}} onSetEntireOrg={() => {}} onToggleGroup={() => {}}
            />,
        );
        expect(trigger()).toHaveTextContent('3 groups');
    });

    it('prefers groupNames over the directory list for the label', () => {
        renderCapsule({ isPublished: true, sharedGroups: ['g2'], orgGroups: [], groupNames: { g2: 'Klantenservice' } });
        expect(trigger()).toHaveTextContent('Group Klantenservice');
    });

    it('honours a caller-supplied t', () => {
        const t = (k, fb) => (k === 'visibility.personal' ? 'Persoonlijk' : fb);
        renderCapsule({ t });
        expect(trigger()).toHaveTextContent('Persoonlijk');
    });

    it('capsule variant is theme-neutral in every state — no emerald when published', () => {
        renderCapsule({ variant: 'capsule', isPublished: true, sharedGroups: [] });
        const el = trigger();
        expect(el).toHaveAttribute('data-variant', 'capsule');
        expect(el.className).not.toMatch(/emerald/);
        expect(el.style.height).toBe('32px');
        expect(el.style.borderRadius).toBe('10px');
        expect(el.style.background).toBe('var(--bg-card)');
    });

    it('pill variant (the default) keeps its shape but is theme-neutral too — no emerald when published', () => {
        renderCapsule({ isPublished: true, sharedGroups: [] });
        expect(trigger()).toHaveAttribute('data-variant', 'pill');
        expect(trigger().className).toMatch(/rounded-full/);
        expect(trigger().className).not.toMatch(/emerald/);
        expect(trigger().className).toMatch(/bg-\[var\(--bg-secondary\)\]/);
        // The publish glyph still tells the state apart.
        expect(trigger().querySelector('svg')).toBeTruthy();
    });
});

describe('VisibilityCapsule panel', () => {
    it('renders the options in-flow and closes on an outside press', () => {
        const { onClose } = renderCapsule({ open: true });
        const panel = screen.getByTestId('visibility-panel');
        expect(panel).not.toHaveAttribute('data-anchored-menu');
        expect(option('personal')).toHaveAttribute('aria-current', 'true');
        expect(option('org')).not.toHaveAttribute('aria-current');
        expect(groupBox('Sales')).not.toBeChecked();

        fireEvent.mouseDown(panel);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.mouseDown(document.body);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('anchored=true portals the panel through AnchoredMenu', () => {
        renderCapsule({ open: true, anchored: true });
        const panel = screen.getByTestId('visibility-panel');
        expect(panel).toHaveAttribute('data-anchored-menu');
        expect(panel.parentElement).toBe(document.body);
        expect(option('org')).toBeInTheDocument();
    });

    it('without confirmWidening every choice fires synchronously', () => {
        const { onSetPersonal, onSetEntireOrg, onToggleGroup } = renderCapsule({ open: true });
        fireEvent.click(option('org'));
        expect(onSetEntireOrg).toHaveBeenCalledTimes(1);
        fireEvent.click(groupBox('Sales'));
        expect(onToggleGroup).toHaveBeenCalledWith('g1');
        fireEvent.click(option('personal'));
        expect(onSetPersonal).toHaveBeenCalledTimes(1);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('widening personal → organisation asks, naming the thing, then applies on yes', async () => {
        const { onSetEntireOrg } = renderCapsule({ open: true, confirmWidening: true });
        fireEvent.click(option('org'));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy.mock.calls[0][0].description).toContain('Everyone in your organisation');
        expect(confirmSpy.mock.calls[0][0].description).toContain('Quote helper');
        await waitFor(() => expect(onSetEntireOrg).toHaveBeenCalledTimes(1));
    });

    it('a declined widening changes nothing', async () => {
        confirmSpy.mockResolvedValue(false);
        const { onSetEntireOrg, onToggleGroup } = renderCapsule({ open: true, confirmWidening: true });
        fireEvent.click(option('org'));
        fireEvent.click(groupBox('Sales'));
        expect(confirmSpy).toHaveBeenCalledTimes(2);
        await Promise.resolve();
        expect(onSetEntireOrg).not.toHaveBeenCalled();
        expect(onToggleGroup).not.toHaveBeenCalled();
    });

    it('widening personal → a group asks with the group name', async () => {
        const { onToggleGroup } = renderCapsule({ open: true, confirmWidening: true });
        fireEvent.click(groupBox('Support'));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy.mock.calls[0][0].description).toContain('Members of Support');
        await waitFor(() => expect(onToggleGroup).toHaveBeenCalledWith('g2'));
    });

    it('narrowing organisation → a group does not ask', () => {
        const { onToggleGroup } = renderCapsule({ open: true, confirmWidening: true, isPublished: true, sharedGroups: [] });
        fireEvent.click(groupBox('Sales'));
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(onToggleGroup).toHaveBeenCalledWith('g1');
    });

    it('narrowing to personal never asks', () => {
        const { onSetPersonal } = renderCapsule({ open: true, confirmWidening: true, isPublished: true, sharedGroups: ['g1'] });
        fireEvent.click(option('personal'));
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(onSetPersonal).toHaveBeenCalledTimes(1);
    });

    it('widening groups → organisation asks', async () => {
        const { onSetEntireOrg } = renderCapsule({ open: true, confirmWidening: true, isPublished: true, sharedGroups: ['g1'] });
        fireEvent.click(option('org'));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(onSetEntireOrg).toHaveBeenCalledTimes(1));
    });

    it('refuses to untick the last group: stays ticked, hints at Personal, sends neither [] (= everyone) nor onSetPersonal (closes the menu)', () => {
        const { onSetPersonal, onToggleGroup, onClose } = renderCapsule({ open: true, isPublished: true, sharedGroups: ['g1'] });
        expect(groupBox('Sales')).toBeChecked();
        expect(screen.queryByTestId('visibility-last-group-hint')).toBeNull();
        fireEvent.click(groupBox('Sales'));
        expect(onToggleGroup).not.toHaveBeenCalled();
        expect(onSetPersonal).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(groupBox('Sales')).toBeChecked();
        expect(screen.getByTestId('visibility-last-group-hint')).toHaveTextContent('Choose Personal to stop sharing');
        // Personal is still one click away, and it is the honest exit.
        fireEvent.click(option('personal'));
        expect(onSetPersonal).toHaveBeenCalledTimes(1);
    });

    it('unticking one of SEVERAL groups still goes through onToggleGroup', () => {
        const { onSetPersonal, onToggleGroup } = renderCapsule({ open: true, isPublished: true, sharedGroups: ['g1', 'g2'] });
        fireEvent.click(groupBox('Sales'));
        expect(onToggleGroup).toHaveBeenCalledWith('g1');
        expect(onSetPersonal).not.toHaveBeenCalled();
        expect(screen.queryByTestId('visibility-last-group-hint')).toBeNull();
    });

    it('mounts extraSection and the embed hint', () => {
        renderCapsule({ open: true, embedEnabled: true, extraSection: <div data-testid="extra">share links</div> });
        expect(screen.getByTestId('extra')).toBeInTheDocument();
        expect(screen.getByText(/Web embed is on/)).toBeInTheDocument();
    });
});

describe('PublishMenu compatibility re-export', () => {
    it('renders the same component under the old import path', () => {
        render(
            <PublishMenu
                t={(k, fb) => fb}
                agent={{ id: 'a1' }}
                open={false}
                onToggle={() => {}}
                onClose={() => {}}
                isPublished
                onSetPersonal={() => {}}
                onSetEntireOrg={() => {}}
                embedEnabled={false}
                orgGroups={ORG_GROUPS}
                sharedGroups={['g1', 'g2']}
                onToggleGroup={() => {}}
            />,
        );
        expect(PublishMenu).toBe(VisibilityCapsule);
        expect(trigger()).toHaveTextContent('2 groups');
    });
});

describe('AudienceRows', () => {
    function renderRows(props = {}) {
        const handlers = { onSetPersonal: vi.fn(), onSetEntireOrg: vi.fn(), onToggleGroup: vi.fn() };
        const utils = render(
            <AudienceRows
                agent={{ id: 'kb1', name: 'Handbook' }}
                isPublished={false}
                sharedGroups={[]}
                orgGroups={ORG_GROUPS}
                hint="Only people who can see it themselves get answers from it."
                {...handlers}
                {...props}
            />,
        );
        return { ...utils, ...handlers };
    }
    const row = (mode) => document.querySelector(`[data-audience-option="${mode}"]`);

    it('renders three rows with the active one checked, plus the hint', () => {
        renderRows({ isPublished: true, sharedGroups: [] });
        expect(row('personal')).toHaveAttribute('aria-checked', 'false');
        expect(row('org')).toHaveAttribute('aria-checked', 'true');
        expect(row('groups')).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText(/get answers from it/)).toBeInTheDocument();
    });

    it('shows the selected groups as named chips and removes one on click', () => {
        const { onToggleGroup } = renderRows({ isPublished: true, sharedGroups: ['g1', 'g3'] });
        const chips = screen.getByTestId('audience-group-chips');
        expect(chips).toHaveTextContent('Sales');
        expect(chips).toHaveTextContent('Finance');
        fireEvent.click(within(chips).getByLabelText('Remove Finance'));
        expect(onToggleGroup).toHaveBeenCalledWith('g3');
    });

    it('removing the last chip goes back to Personal', () => {
        const { onToggleGroup, onSetPersonal } = renderRows({ isPublished: true, sharedGroups: ['g1'] });
        fireEvent.click(screen.getByLabelText('Remove Sales'));
        expect(onToggleGroup).not.toHaveBeenCalled();
        expect(onSetPersonal).toHaveBeenCalledTimes(1);
    });

    it('the Groups row opens the picker instead of publishing with no groups', () => {
        const { onSetEntireOrg, onToggleGroup } = renderRows();
        fireEvent.click(row('groups'));
        expect(onSetEntireOrg).not.toHaveBeenCalled();
        expect(onToggleGroup).not.toHaveBeenCalled();
        const picker = screen.getByTestId('audience-group-picker');
        expect(picker).toHaveAttribute('data-anchored-menu');
        fireEvent.click(within(picker).getByLabelText('Support'));
        expect(onToggleGroup).toHaveBeenCalledWith('g2');
    });

    it('widening asks, narrowing does not', async () => {
        const { onSetEntireOrg, onSetPersonal, rerender } = renderRows({ confirmWidening: true });
        fireEvent.click(row('org'));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy.mock.calls[0][0].description).toContain('Handbook');
        await waitFor(() => expect(onSetEntireOrg).toHaveBeenCalledTimes(1));

        rerender(
            <AudienceRows
                agent={{ id: 'kb1', name: 'Handbook' }}
                isPublished
                sharedGroups={[]}
                orgGroups={ORG_GROUPS}
                confirmWidening
                onSetPersonal={onSetPersonal}
                onSetEntireOrg={onSetEntireOrg}
                onToggleGroup={() => {}}
            />,
        );
        fireEvent.click(row('personal'));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(onSetPersonal).toHaveBeenCalledTimes(1);
    });

    it('disabled rows do nothing', () => {
        const { onSetEntireOrg } = renderRows({ disabled: true });
        fireEvent.click(row('org'));
        fireEvent.click(row('groups'));
        expect(onSetEntireOrg).not.toHaveBeenCalled();
        expect(screen.queryByTestId('audience-group-picker')).toBeNull();
    });
});
