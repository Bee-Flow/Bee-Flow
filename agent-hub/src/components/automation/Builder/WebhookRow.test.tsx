import { render, screen } from '@testing-library/react';
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

    it('says nothing about a previous secret when there is none', () => {
        render(<ul><WebhookRow row={{ id: 'wh1', url, previousValidUntil: null }} ctl={rowCtl()} /></ul>);
        expect(screen.queryByTestId('webhook-previous-secret')).toBeNull();
    });
});
