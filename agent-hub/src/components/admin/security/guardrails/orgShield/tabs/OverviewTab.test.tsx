import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { ShieldEvidence } from '../activity/useShieldEvidence';
import { derivePosture as derivePostureJs } from '../orgShieldPosture';
import type { GuardStatus, Posture } from '../overview/types';
import { OverviewTab, type OverviewTabProps } from './OverviewTab';

/**
 * The Overview: the master switch, the review card (what asks for a second
 * look, most urgent first), the four step cards and the right-hand column.
 * Rendered against the REAL posture derivation, so a state that stops being
 * flagged in orgShieldPosture.js shows up here as a missing item.
 */

// Fills in `{params}` like the real t(); a mock that drops them tests the mock.
const t: TranslateFn = (key, fallbackOrParams, paramsArg) => {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    let out = hasFallback ? (fallbackOrParams as string) : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
    }
    return out;
};

// The posture module is plain JavaScript; name the call shape used here.
const derivePosture = derivePostureJs as unknown as (f: object, opts: {
    categories: { id: string }[];
    env: Record<string, boolean>;
    licence: Record<string, boolean>;
    guard: GuardStatus | null;
    egress: { piiNonEuCount: number; toolPii: number; piiCategories: string[] } | null;
}) => Posture;

const CATEGORIES = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}` }));

const BASE = {
    enabled: true,
    setEnabled: vi.fn(),
    piiCategories: ['c0', 'c1', 'c2'],
    piiConfidenceThreshold: 0.7,
    piiAction: 'tokenize',
    showRawPayload: false,
    applyToAutomations: true,
    scanKnowledgeBases: true,
    dlpEnabled: true,
    dlpMode: 'ask',
    euModeEnabled: false,
    toolPiiPolicy: { external: { blockCategories: [] as string[] }, internal: { blockCategories: [] as string[] } },
    customDataTypes: [],
    piiAllowTerms: [] as string[],
    piiAllowPublicOrgs: true,
};

const EVIDENCE: ShieldEvidence = {
    days: 30, replaced: 48, stopped: 7, passed: 0, toolPii: 83, piiNonEuCount: 26,
    totalCalls: 400, scannedCalls: 380, local: 100, eu: 200, outside: 60, viaNetwork: 20, unknown: 20,
    toolKinds: { c0: 50 }, topToolKinds: ['c0'],
};

interface Setup {
    f?: Partial<typeof BASE> & Record<string, unknown>;
    guard?: GuardStatus | null;
    evidence?: ShieldEvidence | null;
    env?: Record<string, boolean>;
    props?: Partial<OverviewTabProps>;
}

function setup({ f: over = {}, guard = { configured: true, reachable: true }, evidence = null, env = {}, props = {} }: Setup = {}) {
    const f = { ...BASE, setEnabled: vi.fn(), ...over };
    const egress = evidence ? { piiNonEuCount: evidence.piiNonEuCount, toolPii: evidence.toolPii, piiCategories: ['Email'] } : null;
    const posture = derivePosture(f, { categories: CATEGORIES, env, licence: {}, guard, egress });
    const onGoTo = vi.fn();
    const onDiagnoseGuard = vi.fn();
    render(
        <OverviewTab
            f={f}
            posture={posture}
            guard={guard}
            meta={null}
            evidence={evidence}
            showActivity={!!evidence}
            t={t}
            onGoTo={onGoTo}
            onDiagnoseGuard={onDiagnoseGuard}
            {...props}
        />,
    );
    return { user: userEvent.setup(), onGoTo, onDiagnoseGuard, f };
}

const reviewCard = () => screen.getByRole('region', { name: /to review/ });
const reviewTitles = () => within(reviewCard()).getAllByRole('listitem').map(li => li.querySelector('p')?.textContent);

describe('the review card', () => {
    it('is absent when nothing asks for a second look', () => {
        setup();
        expect(screen.queryByRole('region', { name: /to review/ })).toBeNull();
        expect(screen.getByRole('heading', { name: 'How things stand' })).toBeInTheDocument();
    });

    it('offers the last check while it is off, and sends Change to its tab', async () => {
        const { user, onGoTo } = setup({ f: { dlpEnabled: false } });
        expect(within(reviewCard()).getByRole('heading', { name: '1 thing to review' })).toBeInTheDocument();
        expect(screen.getByText('Nobody gets a last check before an outside AI')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Change One last check before an outside AI' }));
        expect(onGoTo).toHaveBeenCalledWith('outbound');
    });

    it('points at a reveal panel that is on', async () => {
        const { user, onGoTo } = setup({ f: { showRawPayload: true } });
        expect(screen.getByText('Anyone in a conversation can reveal the real values')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Change Show what was sent' }));
        expect(onGoTo).toHaveBeenCalledWith('processing');
    });

    it('puts a detection service that is down first, with Diagnose instead of Change', async () => {
        const { user, onDiagnoseGuard } = setup({ f: { dlpEnabled: false }, guard: { configured: true, reachable: false } });
        expect(reviewTitles()[0]).toBe('The detection service is not responding');
        await user.click(screen.getByRole('button', { name: /Diagnose/ }));
        expect(onDiagnoseGuard).toHaveBeenCalled();
        // The chat preview must not claim protection while the scanner is down.
        expect(screen.getByText(/It never says “protected”/)).toBeInTheDocument();
    });

    it('flags zero kinds of data', () => {
        setup({ f: { piiCategories: [] } });
        expect(screen.getByText('No kinds of data are selected')).toBeInTheDocument();
        expect(screen.getByText('Protection is on, but nothing is ticked — so nothing will ever be found.')).toBeInTheDocument();
    });

    it('lists error, then warn, then note, then suggest', () => {
        setup({
            f: { piiCategories: [], showRawPayload: true, dlpEnabled: false },
            guard: { configured: false, reachable: false },
        });
        expect(reviewTitles()).toEqual([
            'The detection service is not installed',
            'No kinds of data are selected',
            'Anyone in a conversation can reveal the real values',
            'Nobody gets a last check before an outside AI',
        ]);
    });

    it('names the tool leak with the evidence numbers, and offers both ways out', async () => {
        const { user, onGoTo } = setup({ evidence: EVIDENCE });
        expect(within(reviewCard()).getByText('based on your settings and the last 30 days')).toBeInTheDocument();
        expect(screen.getByText('Tools may carry any personal data out')).toBeInTheDocument();
        expect(screen.getByText(
            'No kind is held back from outside tools (0 of 21). In the last 30 days, 83 tool calls left with personal data — 26 of them outside Europe.',
        )).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Hold kinds back/ }));
        expect(onGoTo).toHaveBeenLastCalledWith('detection');
        await user.click(screen.getByRole('button', { name: 'See calls' }));
        expect(onGoTo).toHaveBeenLastCalledWith('activity');
    });

    it('calls it a leak rather than "any personal data" once some kinds are held back', () => {
        setup({
            evidence: EVIDENCE,
            f: { toolPiiPolicy: { external: { blockCategories: ['c0', 'c1'] }, internal: { blockCategories: [] } } },
        });
        expect(screen.getByText('Personal data left Europe')).toBeInTheDocument();
        expect(screen.getByText(/^2 of 21 kinds are held back from outside tools\./)).toBeInTheDocument();
    });

    it('does not claim the last 30 days without evidence', () => {
        setup({ f: { dlpEnabled: false } });
        expect(within(reviewCard()).getByText('based on your settings')).toBeInTheDocument();
    });
});

describe('without the activity pane', () => {
    it('shows no 30-day figures and no "See calls"', () => {
        setup({ evidence: EVIDENCE, props: { showActivity: false } });
        expect(screen.queryByRole('region', { name: /Last 30 days/ })).toBeNull();
        expect(screen.queryByRole('button', { name: 'See calls' })).toBeNull();
        expect(screen.getByRole('button', { name: /Hold kinds back/ })).toBeInTheDocument();
    });

    it('shows the three figures when the pane is offered', async () => {
        const { user, onGoTo } = setup({ evidence: EVIDENCE });
        const card = screen.getByRole('region', { name: 'Last 30 days' });
        expect(within(card).getByText('48')).toBeInTheDocument();
        expect(within(card).getByText('7')).toBeInTheDocument();
        expect(within(card).getByText('83')).toBeInTheDocument();
        await user.click(within(card).getByRole('button', { name: /What happened/ }));
        expect(onGoTo).toHaveBeenCalledWith('activity');
    });
});

describe('the step cards', () => {
    const step = (name: string) => screen.getByRole('region', { name });

    it('says whether knowledge bases are covered', () => {
        setup({ f: { scanKnowledgeBases: false } });
        const card = step('When we find something');
        expect(within(card).getByText('Knowledge bases').nextElementSibling?.textContent).toBe('Not covered');
        expect(within(card).getByText('Routines').nextElementSibling?.textContent).toBe('Covered');
    });

    it('opens each step\'s own tab, and offers to add own types while there are none', async () => {
        const { user, onGoTo } = setup();
        expect(within(step('Your own data')).getByText('Project code names · Customer numbers')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Change What we look for' }));
        expect(onGoTo).toHaveBeenLastCalledWith('detection');
        await user.click(screen.getByRole('button', { name: 'Add to Your own data' }));
        expect(onGoTo).toHaveBeenLastCalledWith('owndata');
        await user.click(screen.getByRole('button', { name: 'Change When we find something' }));
        expect(onGoTo).toHaveBeenLastCalledWith('processing');
        await user.click(screen.getByRole('button', { name: 'Change Leaving your org' }));
        expect(onGoTo).toHaveBeenLastCalledWith('outbound');
    });

    it('only lists EU-only and web search where they are configured', () => {
        setup();
        expect(within(step('Leaving your org')).queryByText('EU-hosted AI only')).toBeNull();
        expect(within(step('Leaving your org')).queryByText('Web search protection')).toBeNull();
    });
});

describe('with the shield off', () => {
    it('shows the switch and why nothing else is there', async () => {
        const { user, f } = setup({ f: { enabled: false } });
        expect(screen.getByText(/Protection is off/)).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'How things stand' })).toBeNull();
        await user.click(screen.getByRole('checkbox', { name: 'admin.shield_enable' }));
        expect(f.setEnabled).toHaveBeenCalledWith(true);
    });
});
