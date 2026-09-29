import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({ authFetch: vi.fn() }));
vi.mock('../../../shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
    return { default: toast, toast };
});
// The host pulls in heavy neighbours we are not testing here.
vi.mock('../../../agents/AgentWizard/pickers/BehaviorPicker', () => ({ BehaviorBody: () => <div data-testid="behavior-body" /> }));
vi.mock('../../../agents/VersionHistory', () => ({ default: () => <div data-testid="version-history" /> }));

import { authFetch } from '../../../../utils/helpers';
import ComplianceBlock, { chipState } from './ComplianceBlock';
import AdvancedDrawer from '../../../agents/AgentWizard/pickers/AdvancedDrawer';
import { API } from '../data/api';

const NOW = new Date(2026, 8, 14, 15, 30).getTime();

const quote = {
    id: 'a1',
    name: 'Offerte berekenen',
    title: 'Offerte berekenen',
    definition: {
        trigger: { kind: 'form' },
        steps: [
            { id: 's1', type: 'form_page' },
            { id: 's3', type: 'ai_step', label: "Foto's beoordelen" },
            { id: 's4', type: 'summarize' },
            { id: 's7', type: 'generate_document' },
        ],
    },
};

const notFound = { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => authFetch.mockReset());

describe('chipState', () => {
    it('none / declared / expired / prohibited', () => {
        expect(chipState(null)).toEqual({ tone: 'neutral', state: 'none' });
        expect(chipState({ outcome: 'transparency' })).toEqual({ tone: 'neutral', state: 'none' });
        expect(chipState({ outcome: 'transparency', attested_at: '2026-09-01', expires_at: '2027-09-01', current: true }, NOW)).toEqual({ tone: 'success', state: 'declared' });
        expect(chipState({ outcome: 'transparency', attested_at: '2025-01-01', expires_at: '2026-01-01', current: true }, NOW)).toEqual({ tone: 'warning', state: 'expired' });
        expect(chipState({ outcome: 'transparency', attested_at: '2026-09-01', expires_at: '2027-09-01', current: false }, NOW)).toEqual({ tone: 'warning', state: 'expired' });
        expect(chipState({ outcome: 'prohibited', attested_at: '2026-09-01', expires_at: '2027-09-01', current: true }, NOW)).toEqual({ tone: 'error', state: 'declared' });
    });
});

describe('ComplianceBlock', () => {
    it('route absent (404): "Not assessed" chip and the signals line from the definition — summarize not counted', async () => {
        authFetch.mockResolvedValue(notFound);
        render(<ComplianceBlock kind="automation" target={quote} now={NOW} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith(`${API}/ai-act/assessments/automation/a1`, expect.anything()));
        const chip = screen.getByTestId('compliance-block-chip');
        expect(chip.textContent).toBe('Not assessed');
        expect(chip.getAttribute('data-tone')).toBe('neutral');
        const line = await screen.findByTestId('compliance-block-signals');
        expect(line.getAttribute('data-source')).toBe('client');
        expect(line.textContent).toContain('1 AI steps · customer-facing · generates content');
        expect(line.textContent).toContain('read from the definition');
        expect(screen.getByText('Compliance')).toBeTruthy();
        expect(screen.queryByTestId('compliance-block-error')).toBeNull();
    });

    it('a saved, current assessment → "Self-declared {date}" success chip; server signals win over the fallback', async () => {
        authFetch.mockResolvedValue(ok({
            signals: { contains_ai: true, customer_facing: false, generates_content: true, disclosure_present: null, marking_enabled: true, steps: { ai: [{ id: 's3', label: 'x' }] } },
            answers: { art5: { answer: 'no', practices: [] }, annex_iii: { answer: 'no', category: null } },
            outcome: 'transparency', attested_by: 'u1', attested_at: '2026-09-01T09:00:00Z', expires_at: '2027-09-01T09:00:00Z', current: true,
        }));
        render(<ComplianceBlock kind="automation" target={quote} now={NOW} />);
        const chip = await screen.findByText('Self-declared 1 Sep 2026');
        expect(chip.getAttribute('data-tone')).toBe('success');
        expect(chip.getAttribute('title')).toBe('Art. 4 + Art. 50');
        const line = screen.getByTestId('compliance-block-signals');
        expect(line.getAttribute('data-source')).toBe('server');
        expect(line.textContent).toBe('1 AI steps · internal only · generates content');
    });

    it('an expired declaration → "Expired" warning chip', async () => {
        authFetch.mockResolvedValue(ok({
            signals: { contains_ai: true }, answers: {}, outcome: 'minimal',
            attested_by: 'u1', attested_at: '2025-06-01T09:00:00Z', expires_at: '2026-06-01T09:00:00Z', current: false,
        }));
        render(<ComplianceBlock kind="automation" target={quote} now={NOW} />);
        const chip = await screen.findByText('Expired');
        expect(chip.getAttribute('data-tone')).toBe('warning');
    });

    it('a failed read (500) is its own state — not "Not assessed" pretending', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) });
        render(<ComplianceBlock kind="automation" target={quote} now={NOW} />);
        await screen.findByTestId('compliance-block-error');
        // The chip still says nothing is recorded (we do not know), and the definition's signals still show.
        expect(screen.getByTestId('compliance-block-signals').getAttribute('data-source')).toBe('client');
    });

    it('"Assess…" opens the ladder modal with the block\'s own hook data', async () => {
        authFetch.mockResolvedValue(notFound);
        render(<ComplianceBlock kind="automation" target={quote} now={NOW} />);
        await screen.findByTestId('compliance-block-signals');
        expect(screen.queryByTestId('ai-act-ladder')).toBeNull();
        fireEvent.click(screen.getByTestId('compliance-block-assess'));
        expect(screen.getByTestId('ai-act-ladder')).toBeTruthy();
        expect(screen.getByTestId('ladder-contains-ai').getAttribute('data-contains-ai')).toBe('true');
        fireEvent.click(screen.getByText('Later'));
        expect(screen.queryByTestId('ai-act-ladder')).toBeNull();
    });

    it('agent kind: "An agent is an AI system", customer-facing when published', async () => {
        authFetch.mockResolvedValue(notFound);
        render(<ComplianceBlock kind="agent" target={{ id: 'g1', name: 'Helpdesk', is_published: true }} now={NOW} />);
        const line = await screen.findByTestId('compliance-block-signals');
        expect(line.textContent).toContain('An agent is an AI system · customer-facing · generates content');
    });

    it('renders nothing without a target id (a routine that is not saved yet)', () => {
        const { container } = render(<ComplianceBlock kind="automation" target={{ name: 'draft' }} />);
        expect(container.innerHTML).toBe('');
        expect(authFetch).not.toHaveBeenCalled();
    });
});

describe('hook points (light smoke)', () => {
    // The routine Settings page no longer hosts this block: its AI Act check
    // is the Settings › AI Act section (Builder/settings/AiActSection.tsx).

    it('AdvancedDrawer gains a collapsed "Compliance" section that hosts the agent block', async () => {
        authFetch.mockResolvedValue(notFound);
        const t = (k, fb) => fb ?? k;
        render(<AdvancedDrawer open onClose={vi.fn()} t={t} agent={{ id: 'g1', name: 'Helpdesk', is_published: false }} />);
        const heading = screen.getByText('Compliance');
        expect(heading).toBeTruthy();
        // Collapsed by default (Behavior is the open section) — expand it.
        fireEvent.click(heading.closest('button'));
        const block = await screen.findByTestId('compliance-block');
        expect(block.getAttribute('data-kind')).toBe('agent');
        // The existing sections are untouched (a closed section unmounts its body, so check the headings).
        for (const label of ['Behavior', 'Embed & bubble', 'Version History']) expect(screen.getByText(label)).toBeTruthy();
    });
});
