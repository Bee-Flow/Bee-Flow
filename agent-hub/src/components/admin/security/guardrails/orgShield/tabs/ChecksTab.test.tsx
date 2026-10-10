import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import type { ShieldEvidence } from '../activity/useShieldEvidence';
import type { ChecksEnv, ChecksFields, ChecksLicence } from './checks/checksTypes';
import ChecksTab, { type CheckStep } from './ChecksTab';

/**
 * The two check panes: each step shows only the settings it owns, the
 * tool-gap footer must never show a number nobody measured, and the licence
 * and environment gates must survive the re-layout.
 */

type Params = Record<string, unknown>;

// Mirrors the real t(key, fallbackOrParams?, params?), including {x}.
const t = (key: string, fallbackOrParams?: string | Params, paramsArg?: Params): string => {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    let out = hasFallback ? fallbackOrParams : key;
    for (const [k, v] of Object.entries(params || {})) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
    return out;
};

function fields(over: Partial<ChecksFields> = {}): ChecksFields {
    return {
        // One of the org's own types: not a "kind" in the strip's n of 21.
        piiCategories: ['Email', 'PhoneNumber', 'cdt_0123456789'],
        piiAction: 'tokenize', setPiiAction: vi.fn(),
        showRawPayload: false, setShowRawPayload: vi.fn(),
        scanKnowledgeBases: true, setScanKnowledgeBases: vi.fn(),
        applyToAutomations: true, setApplyToAutomations: vi.fn(),
        dlpEnabled: false, setDlpEnabled: vi.fn(),
        dlpMode: 'ask', setDlpMode: vi.fn(),
        dlpAlwaysReview: false, setDlpAlwaysReview: vi.fn(),
        euModeEnabled: false, setEuModeEnabled: vi.fn(),
        webSearchGuard: true, setWebSearchGuard: vi.fn(),
        disableSearchOnUpload: true, setDisableSearchOnUpload: vi.fn(),
        monitorIntegrations: true, setMonitorIntegrations: vi.fn(),
        ...over,
    };
}

const evidence = (toolPii: number, scannedCalls = 40): ShieldEvidence => ({
    days: 30, replaced: 0, stopped: 0, passed: 0, toolPii, piiNonEuCount: 0,
    totalCalls: 50, scannedCalls, local: 0, eu: 0, outside: 0, viaNetwork: 0, unknown: 0,
    toolKinds: {}, topToolKinds: [],
});

function setup({ step = 'processing', f = {}, licence = {}, env = {}, ev = null }: {
    step?: CheckStep;
    f?: Partial<ChecksFields>;
    licence?: Partial<ChecksLicence>;
    env?: Partial<ChecksEnv>;
    ev?: ShieldEvidence | null;
} = {}) {
    const user = userEvent.setup();
    const onGoTo = vi.fn();
    const fl = fields(f);
    render(
        <ChecksTab
            step={step}
            f={fl}
            licence={{ canTokenizePii: true, canUseWebSearchGuard: true, ...licence }}
            env={{ hasEuModelsConfigured: true, hasWebSearchEnabled: true, ...env }}
            evidence={ev}
            onGoTo={onGoTo}
            t={t}
        />,
    );
    return { user, onGoTo, f: fl };
}

describe('ChecksTab — one step per pane', () => {
    it('step 3 shows the every-message card alone, numbered as on the strip', () => {
        setup({ step: 'processing' });
        expect(screen.getByRole('region', { name: 'On every message' })).toBeInTheDocument();
        expect(screen.getByText('When we find personal data')).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Before it leaves your organisation' })).toBeNull();
        expect(screen.queryByText('One last check before an outside AI')).toBeNull();
        expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('step 4 shows the leaving card alone, numbered as on the strip', () => {
        setup({ step: 'outbound' });
        expect(screen.getByRole('region', { name: 'Before it leaves your organisation' })).toBeInTheDocument();
        expect(screen.getByText('One last check before an outside AI')).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'On every message' })).toBeNull();
        expect(screen.queryByText('When we find personal data')).toBeNull();
        expect(screen.getByText('4')).toBeInTheDocument();
    });
});

describe('ChecksTab — the tool gap', () => {
    it('shows no number when the figures are unknown', () => {
        setup({ step: 'outbound', ev: null });
        expect(screen.queryByText(/tool calls carried personal data/)).toBeNull();
        expect(screen.getByText(/Tool calls go around steps 3 and 4/)).toBeInTheDocument();
    });

    it('shows the count from the evidence', () => {
        setup({ step: 'outbound', ev: evidence(83) });
        expect(screen.getByText('83 tool calls carried personal data in the last 30 days.')).toBeInTheDocument();
    });

    it('does not turn "not checked" into a zero — read from the calls, not the (maybe unsaved) switch', () => {
        setup({ step: 'outbound', ev: evidence(0, 0), f: { monitorIntegrations: true } });
        expect(screen.queryByText(/tool calls? carried personal data/)).toBeNull();
    });

    it('says "1 tool call", not "1 tool calls"', () => {
        setup({ step: 'outbound', ev: evidence(1) });
        expect(screen.getByText('1 tool call carried personal data in the last 30 days.')).toBeInTheDocument();
    });

    it('sends the pointer to the matrix', async () => {
        const { user, onGoTo } = setup({ step: 'outbound', ev: evidence(5) });
        await user.click(screen.getByRole('button', { name: 'tool columns of the matrix' }));
        expect(onGoTo).toHaveBeenCalledWith('detection');
    });
});

describe('ChecksTab — step 3', () => {
    it('keeps the placeholder card, locked, when the plan lacks it', () => {
        setup({ licence: { canTokenizePii: false } });
        const group = screen.getByRole('radiogroup', { name: 'What happens when we find personal data' });
        expect(within(group).getByRole('radio', { name: /Replace with placeholders/ })).toBeDisabled();
        expect(screen.getByText('Replacing with placeholders is an Enterprise feature.')).toBeInTheDocument();
        expect(screen.getByText(/Placeholders are saved for this organisation/)).toBeInTheDocument();
    });

    it('offers "Let people see what was sent" only with placeholders, with its warning', () => {
        setup();
        expect(screen.getByRole('checkbox', { name: 'Let people see what was sent to the AI' })).toBeInTheDocument();
        expect(screen.getByText('Anyone who can open the conversation can reveal the real values.')).toBeInTheDocument();
    });

    it('drops "Let people see what was sent" when messages are stopped', () => {
        setup({ f: { piiAction: 'block' } });
        expect(screen.queryByRole('checkbox', { name: 'Let people see what was sent to the AI' })).toBeNull();
    });

    it('names every switch and writes through the setter', async () => {
        const { user, f } = setup();
        for (const box of screen.getAllByRole('checkbox')) expect(box).toHaveAccessibleName();
        await user.click(screen.getByRole('checkbox', { name: 'Also protect automations' }));
        expect(f.setApplyToAutomations).toHaveBeenCalledWith(false);
    });
});

describe('ChecksTab — step 4', () => {
    it('locks "Protect web searches" without its licence instead of offering a switch', () => {
        setup({ step: 'outbound', licence: { canUseWebSearchGuard: false } });
        expect(screen.queryByRole('checkbox', { name: 'Protect web searches' })).toBeNull();
        expect(screen.getByText('Protect web searches')).toBeInTheDocument();
        expect(screen.getByText('Protecting web searches is an Enterprise feature.')).toBeInTheDocument();
    });

    it('leaves out rows whose feature is not set up on this server', () => {
        setup({ step: 'outbound', env: { hasEuModelsConfigured: false, hasWebSearchEnabled: false } });
        expect(screen.queryByText('Use only AI hosted in the EU')).toBeNull();
        expect(screen.queryByText('Protect web searches')).toBeNull();
        expect(screen.queryByText('No web search while a file is attached')).toBeNull();
        expect(screen.getByRole('checkbox', { name: 'Check connected-app traffic for personal data' })).toBeInTheDocument();
    });

    it('reveals the last check\'s modes only while it is on', () => {
        setup({ step: 'outbound', f: { dlpEnabled: true } });
        const modes = screen.getByRole('radiogroup', { name: 'What to do when it finds something' });
        expect(within(modes).getAllByRole('radio')).toHaveLength(3);
        expect(screen.getByRole('checkbox', { name: /Always show this check/ })).toBeInTheDocument();
    });

    it('hides the modes while the last check is off', () => {
        setup({ step: 'outbound' });
        expect(screen.queryByRole('radiogroup', { name: 'What to do when it finds something' })).toBeNull();
    });

    it('names every switch', () => {
        setup({ step: 'outbound', f: { dlpEnabled: true } });
        for (const box of screen.getAllByRole('checkbox')) expect(box).toHaveAccessibleName();
    });
});
