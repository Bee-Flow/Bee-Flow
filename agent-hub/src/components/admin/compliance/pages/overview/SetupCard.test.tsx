import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SetupCard from './SetupCard';
import type { TranslateParams } from '@/hooks/useTranslation';

// The tiles reuse the shipped wizard keys (`compliance.wizard_step_*`,
// `compliance.lb_*`, `compliance.residency_*`), so the stub reads the real
// English dictionary first and only then the inline fallback — exactly the
// order `useTranslation` uses.
vi.mock('../../../../../hooks/useTranslation', async () => {
    const { default: EN } = await import('../../../../../i18n/en-defaults');
    const t = (key: string, fallbackOrParams?: string | TranslateParams, paramsArg?: TranslateParams | null) => {
        const hasFallback = typeof fallbackOrParams === 'string';
        const params = hasFallback ? paramsArg : fallbackOrParams;
        let value = (EN as Record<string, string>)[key] ?? (hasFallback ? fallbackOrParams : key);
        if (params && typeof params === 'object') {
            for (const [k, v] of Object.entries(params)) value = value.split(`{${k}}`).join(String(v));
        }
        return value;
    };
    return { useTranslation: () => ({ t, locale: 'en', resolvedLocale: 'en' }) };
});

const DETECTED = {
    legal_bases: ['contract', 'consent'],
    data_residency: 'hybrid',
    default_retention_days: 180,
    breach_recipients: ['admin@acme.example'],
};

const ORG_USERS = [
    { id: 'zoe', displayName: 'Zoë de Vries', email: 'zoe@acme.nl', phone: null, orgRole: 'dpo' },
];

function renderCard(props = {}) {
    const onFinish = vi.fn().mockResolvedValue(undefined);
    const onStepChange = vi.fn();
    const utils = render(<SetupCard settings={{}} onFinish={onFinish} onStepChange={onStepChange} {...props} />);
    return { ...utils, onFinish, onStepChange };
}

describe('SetupCard — one path', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('is a card with four tiles and one call to action — no modal, no second CTA', () => {
        renderCard();
        expect(screen.getByTestId('setup-card')).toBeInTheDocument();
        expect(screen.getAllByTestId('setup-card-cta')).toHaveLength(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByTestId('setup-card-tiles').children).toHaveLength(4);
        // Nothing is expanded until the user asks for it.
        expect(screen.queryByTestId('setup-card-body')).not.toBeInTheDocument();
    });

    it('the CTA expands the active step inline inside the card', async () => {
        const user = userEvent.setup();
        renderCard();
        await user.click(screen.getByTestId('setup-card-cta'));
        const body = screen.getByTestId('setup-card-body');
        expect(body).toBeInTheDocument();
        expect(screen.getByTestId('setup-step-dpo')).toBeInTheDocument();
        expect(screen.getByTestId('setup-card')).toContainElement(body);
        expect(screen.queryByTestId('setup-card-cta')).not.toBeInTheDocument();
    });

    it('starts on the first unanswered step and reports it upward', () => {
        const { onStepChange } = renderCard({ settings: { dpo_name: 'Jane', dpo_email: 'jane@acme.nl' } });
        expect(screen.getByTestId('setup-card').dataset.step).toBe('4');
        expect(onStepChange).toHaveBeenCalledWith(4);
        expect(screen.getByTestId('setup-card-tile-dpo').dataset.state).toBe('done');
        expect(screen.getByTestId('setup-card-tile-breach').dataset.state).toBe('active');
    });

    it('blocks the step until it is answered, then walks to the next one', async () => {
        const user = userEvent.setup();
        const { onStepChange } = renderCard();
        await user.click(screen.getByTestId('setup-card-cta'));
        expect(screen.getByTestId('setup-card-next')).toBeDisabled();
        expect(screen.getByTestId('setup-card-blocked')).toBeInTheDocument();
        await user.clear(screen.getByLabelText('DPO name'));
        await user.type(screen.getByLabelText('DPO name'), 'Jane');
        await user.clear(screen.getByLabelText('DPO email'));
        await user.type(screen.getByLabelText('DPO email'), 'jane@acme.example');
        expect(screen.getByTestId('setup-card-next')).not.toBeDisabled();
        await user.click(screen.getByTestId('setup-card-next'));
        expect(screen.getByTestId('setup-card').dataset.step).toBe('2');
        expect(onStepChange).toHaveBeenCalledWith(2);
        await user.click(screen.getByTestId('setup-card-back'));
        expect(screen.getByTestId('setup-card').dataset.step).toBe('1');
    });

    it('the last step saves an allow-listed body, never the raw form state', async () => {
        const user = userEvent.setup();
        const { onFinish } = renderCard({ settings: { dpo_name: 'Jane', dpo_email: 'jane@acme.nl' } });
        await user.click(screen.getByTestId('setup-card-cta'));
        await user.clear(screen.getByTestId('setup-step-recipient-input'));
        await user.type(screen.getByTestId('setup-step-recipient-input'), 'security@acme.nl');
        await user.click(screen.getByTestId('setup-step-recipient-add'));
        await user.click(screen.getByTestId('setup-card-next'));
        await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
        const body = onFinish.mock.calls[0][0];
        expect(body.breach_recipients).toEqual(['security@acme.nl']);
        expect(body.dpo_email).toBe('jane@acme.nl');
        expect(body).not.toHaveProperty('newRecipient');
    });

    it('a tile jumps straight to its step', async () => {
        const user = userEvent.setup();
        renderCard();
        await user.click(screen.getByTestId('setup-card-tile-residency'));
        expect(screen.getByTestId('setup-card').dataset.step).toBe('3');
        expect(screen.getByTestId('setup-step-residency')).toBeInTheDocument();
    });
});

describe('SetupCard — auto-detect', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('prefills untouched fields and says where the value came from', async () => {
        const onAutoDetect = vi.fn().mockResolvedValue(DETECTED);
        renderCard({ onAutoDetect });
        await waitFor(() => expect(onAutoDetect).toHaveBeenCalled());
        await waitFor(() => expect(screen.getByTestId('setup-card-tile-residency').textContent).toContain('Hybrid · 180 days'));
        expect(screen.getByTestId('setup-card-tile-residency').textContent).toContain('from your configuration');
        expect(screen.getByTestId('setup-card-tile-legal').textContent).toContain('suggested:');
    });

    it('never overwrites a setting the org already saved', async () => {
        const onAutoDetect = vi.fn().mockResolvedValue(DETECTED);
        renderCard({
            onAutoDetect,
            settings: { legal_bases: ['legal_obligation'], breach_recipients: ['dpo@saved.example'], data_residency: 'eu', default_retention_days: 730 },
        });
        await waitFor(() => expect(onAutoDetect).toHaveBeenCalled());
        const legal = screen.getByTestId('setup-card-tile-legal');
        expect(legal.textContent).toContain('Legal obligation');
        expect(legal.textContent).not.toContain('suggested:');
        expect(screen.getByTestId('setup-card-tile-residency').textContent).toContain('EU-only · 730 days');
    });

    it('survives a failing auto-detect endpoint', async () => {
        const user = userEvent.setup();
        const onAutoDetect = vi.fn().mockRejectedValue(new Error('503'));
        renderCard({ onAutoDetect });
        await waitFor(() => expect(onAutoDetect).toHaveBeenCalled());
        expect(screen.getByTestId('setup-card')).toBeInTheDocument();
        expect(screen.getByTestId('setup-card-cta')).toBeInTheDocument();
        await user.click(screen.getByTestId('setup-card-cta'));
        expect(screen.getByTestId('setup-step-dpo')).toBeInTheDocument();
    });

    it('runs the detect once, not on every render', async () => {
        const onAutoDetect = vi.fn().mockResolvedValue(DETECTED);
        const { rerender } = render(<SetupCard settings={{}} onAutoDetect={onAutoDetect} onFinish={vi.fn()} />);
        rerender(<SetupCard settings={{}} onAutoDetect={onAutoDetect} onFinish={vi.fn()} />);
        await waitFor(() => expect(onAutoDetect).toHaveBeenCalledTimes(1));
    });

    it('offers the org directory to the DPO step when one is loaded', async () => {
        const user = userEvent.setup();
        renderCard({ orgUsers: ORG_USERS });
        await user.click(screen.getByTestId('setup-card-cta'));
        expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('uses tone tokens, never a hex', () => {
        const { container } = renderCard();
        expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    });
});
