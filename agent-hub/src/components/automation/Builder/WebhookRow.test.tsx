import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WebhookRow } from './WebhookPanel';
import type useWebhooks from './webhooks/useWebhooks';

type Ctl = ReturnType<typeof useWebhooks>;

/** The controller a row reads; nothing here talks to a server. */
function rowCtl(overrides: Partial<Ctl> = {}): Ctl {
    return {
        webhooks: [], loading: false, creating: false, errorMsg: null,
        revealedSecrets: {}, visibleSecretIds: {}, copied: null,
        reload: vi.fn(), create: vi.fn(), rotate: vi.fn(), remove: vi.fn(), toggleReveal: vi.fn(),
        copyUrl: vi.fn(), copySecret: vi.fn(), copyCurl: vi.fn(), setErrorMsg: vi.fn(),
        ...overrides,
    } as Ctl;
}

const url = 'https://cloud.example.nl/api/automation/webhook/wh1';

describe('a webhook row in the automation builder', () => {
    it('says until when the previous secret is accepted, while a rotation\'s overlap lasts', () => {
        const until = '2026-11-11T12:00:00.000Z';
        render(<ul><WebhookRow row={{ id: 'wh1', url, previousValidUntil: until }} ctl={rowCtl()} /></ul>);
        expect(screen.getByTestId('webhook-previous-secret').textContent)
            .toBe(`The previous secret is accepted until ${new Date(until).toLocaleString()}.`);
    });

    it('lists the newest deliveries with what became of each, its size and a short hash', () => {
        const deliveries = [
            { id: 'awd_2', status: 'accepted', bodyBytes: 31, bodyHash: 'abababababab', receivedAt: '2026-11-11T10:00:00.000Z' },
            { id: 'awd_1', status: 'bad_signature', bodyBytes: 2, bodyHash: null, receivedAt: '2026-11-11T09:00:00.000Z' },
            { id: 'awd_0', status: 'something_newer', bodyBytes: 0, bodyHash: null, receivedAt: null },
        ];
        render(<ul><WebhookRow row={{ id: 'wh1', url, deliveries }} ctl={rowCtl()} /></ul>);
        const log = within(screen.getByTestId('webhook-deliveries'));
        expect(log.getByText('Recent deliveries (3)')).toBeTruthy();
        const items = log.getAllByRole('listitem').map((li) => li.textContent);
        expect(items[0]).toContain('Accepted');
        expect(items[0]).toContain('31 bytes');
        expect(items[0]).toContain('abababababab');
        expect(items[1]).toContain('Signature not accepted');
        expect(items[1]).toContain('2 bytes');
        expect(items[2]).toContain('something_newer');
    });

    it('says so when nothing was delivered yet, and shows no log when the server sends none', () => {
        const { unmount } = render(<ul><WebhookRow row={{ id: 'wh1', url, deliveries: [] }} ctl={rowCtl()} /></ul>);
        expect(within(screen.getByTestId('webhook-deliveries')).getByText('No deliveries yet.')).toBeTruthy();
        unmount();
        render(<ul><WebhookRow row={{ id: 'wh1', url }} ctl={rowCtl()} /></ul>);
        expect(screen.queryByTestId('webhook-deliveries')).toBeNull();
    });

    it('says nothing about a previous secret when there is none', () => {
        render(<ul><WebhookRow row={{ id: 'wh1', url, previousValidUntil: null }} ctl={rowCtl()} /></ul>);
        expect(screen.queryByTestId('webhook-previous-secret')).toBeNull();
    });
});
