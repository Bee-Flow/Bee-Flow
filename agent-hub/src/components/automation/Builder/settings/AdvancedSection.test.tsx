import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const { hook } = vi.hoisted(() => ({ hook: { current: null as null | Record<string, unknown> } }));
vi.mock('../webhooks/useWebhooks', () => ({
    default: () => hook.current,
    webhookUrl: (w: { id: string }) => `https://cloud.example.nl/api/automation/webhook/${w.id}`,
    maskSecret: () => '••••••••1234',
}));

import AdvancedSection, { parseDuration } from './AdvancedSection';

function webhookCtl(overrides: Record<string, unknown> = {}) {
    return {
        webhooks: [{ id: 'wh1', lastSeenAt: null }],
        loading: false, creating: false, errorMsg: null,
        revealedSecrets: { wh1: 'sekret-1234' }, visibleSecretIds: {}, copied: null,
        create: vi.fn(), rotate: vi.fn(), remove: vi.fn(), toggleReveal: vi.fn(),
        copyUrl: vi.fn(), copySecret: vi.fn(), copyCurl: vi.fn(), setErrorMsg: vi.fn(),
        ...overrides,
    };
}

const automation = { id: 'a1', title: 'Collect files', definition: { steps: [{ id: 's1' }], runPolicy: { retry: { max: 2, then: 'stop_notify' } } } };

describe('Settings › Advanced', () => {
    it('is collapsed by default and names what is inside', () => {
        hook.current = webhookCtl();
        render(<AdvancedSection automation={automation} onSave={vi.fn()} />);
        expect(screen.getByRole('button', { name: /Advanced/ }).getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByText('If a step fails')).toBeNull();
    });

    it('saves the run policy by itself, keeping the rest of the definition', async () => {
        hook.current = webhookCtl();
        const user = userEvent.setup();
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<AdvancedSection automation={automation} onSave={onSave} />);
        await user.click(screen.getByRole('button', { name: /Advanced/ }));
        expect(screen.getByRole('combobox', { name: 'Retries' })).toHaveProperty('value', '2');

        await user.selectOptions(screen.getByRole('combobox', { name: 'After the last attempt' }), 'continue');
        expect(onSave).toHaveBeenLastCalledWith({ definition: { steps: [{ id: 's1' }], runPolicy: { retry: { max: 2, then: 'continue' } } } });

        await user.click(screen.getByRole('radio', { name: 'Allowed at the same time' }));
        expect(onSave.mock.lastCall![0].definition.runPolicy.concurrency).toBe('parallel');

        await user.selectOptions(screen.getByLabelText('Keep runs'), '90');
        expect(onSave.mock.lastCall![0].definition.runPolicy.retentionDays).toBe(90);

        await user.type(screen.getByLabelText('Maximum duration'), '30');
        await user.tab();
        await waitFor(() => expect(onSave.mock.lastCall![0].definition.runPolicy.maxDurationMin).toBe(30));
        expect(screen.getByText('waiting for people does not count')).toBeTruthy();
    });

    it('lets the owner pick whose connections shared and agent runs use, defaulting to the owner', async () => {
        hook.current = webhookCtl();
        const user = userEvent.setup();
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<AdvancedSection automation={automation} onSave={onSave} defaultOpen />);
        expect(screen.getByRole('radio', { name: 'Mine, as the owner' }).getAttribute('aria-checked')).toBe('true');
        await user.click(screen.getByRole('radio', { name: 'Only the person who runs it' }));
        expect(onSave).toHaveBeenLastCalledWith({ definition: { steps: [{ id: 's1' }], runPolicy: { retry: { max: 2, then: 'stop_notify' }, connections: 'caller' } } });
    });

    it('shows the stored connections choice and cannot be changed in a read-only view', () => {
        hook.current = webhookCtl();
        const callerOnly = { ...automation, definition: { ...automation.definition, runPolicy: { connections: 'caller' as const } } };
        render(<AdvancedSection automation={callerOnly} onSave={vi.fn()} defaultOpen readOnly />);
        expect(screen.getByRole('radio', { name: 'Only the person who runs it' }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByRole('radio', { name: 'Mine, as the owner' }).matches(':disabled')).toBe(true);
    });

    it('shows the webhook card with copy, cURL, renew and revoke', async () => {
        const ctl = webhookCtl();
        hook.current = ctl;
        const user = userEvent.setup();
        render(<AdvancedSection automation={automation} onSave={vi.fn()} defaultOpen />);
        const card = screen.getByRole('listitem');
        expect(within(card).getByText('new · copy now')).toBeTruthy();
        expect(within(card).getByText('never used')).toBeTruthy();
        expect(within(card).getByText('You only see the secret now. Requests without a valid signature are refused.')).toBeTruthy();
        await user.click(within(card).getByRole('button', { name: 'Copy webhook URL' }));
        await user.click(within(card).getByRole('button', { name: 'Copy as cURL' }));
        await user.click(within(card).getByRole('button', { name: 'Renew secret' }));
        await user.click(within(card).getByRole('button', { name: 'Revoke' }));
        expect(ctl.copyUrl).toHaveBeenCalled();
        expect(ctl.copyCurl).toHaveBeenCalled();
        expect(ctl.rotate).toHaveBeenCalled();
        expect(ctl.remove).toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Create webhook' }));
        expect(ctl.create).toHaveBeenCalled();
    });
});

describe('parseDuration', () => {
    it('clamps to the server range and treats empty as no limit', () => {
        expect(parseDuration('')).toBeNull();
        expect(parseDuration('0')).toBe(1);
        expect(parseDuration('90')).toBe(60);
        expect(parseDuration('12')).toBe(12);
    });
});
