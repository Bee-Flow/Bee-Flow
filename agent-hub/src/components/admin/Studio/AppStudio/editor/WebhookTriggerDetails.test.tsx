import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ServerTriggersPanel from './ServerTriggersPanel';
import WebhookTriggerDetails, { signingRecipe } from './WebhookTriggerDetails';
import type { TriggersApi } from './serverTriggersApi';
import type { WebhookApi, WebhookView } from './webhookTriggerApi';
import { definitionTriggers } from '../state/serverTriggerOps';
import type { AppDefinition } from '../inspector/appDefinition';
import { renderWithClient } from '@/test/render';

const SIGNING = { signatureHeader: 'X-BeeFlow-Signature', timestampHeader: 'X-BeeFlow-Timestamp', nonceHeader: 'X-BeeFlow-Nonce', toleranceSeconds: 300, maxBodyBytes: 65536 };
const URL = 'https://bee.example.test/api/app-hooks/abc123';
const VIEW = (over: Partial<NonNullable<WebhookView['endpoint']>> = {}, deliveries: WebhookView['deliveries'] = []): WebhookView => ({
    endpoint: { url: URL, path: '/api/app-hooks/abc123', secretAvailable: true, createdAt: null, rotatedAt: null, previousValidUntil: null, ...over },
    signing: SIGNING, deliveries,
});

let api: { view: ReturnType<typeof vi.fn>; secret: ReturnType<typeof vi.fn> };
const mount = () => renderWithClient(<WebhookTriggerDetails appId="app1" triggerId="trigger1" api={api as unknown as WebhookApi} />);

beforeEach(() => {
    cleanup();
    api = { view: vi.fn().mockResolvedValue(VIEW()), secret: vi.fn().mockResolvedValue({ secret: 's3cret-value', previousValidUntil: null }) };
});

describe('<WebhookTriggerDetails>', () => {
    it('says a trigger without an address gets one at a publish', async () => {
        api.view.mockResolvedValue({ endpoint: null, signing: SIGNING, deliveries: [] });
        mount();
        expect(await screen.findByText('This trigger gets its address and its secret when you publish the app.')).toBeTruthy();
    });

    it('shows the address and the recipe with a placeholder for the secret, never the secret itself', async () => {
        mount();
        expect((await screen.findByTestId('webhook-url')).textContent).toBe(URL);
        const recipe = screen.getByTestId('webhook-recipe').textContent || '';
        expect(recipe).toContain(`curl -X POST '${URL}'`);
        expect(recipe).toContain("SECRET='<secret>'");
        expect(recipe).toContain('X-BeeFlow-Signature: sha256=$SIG');
        expect(screen.queryByTestId('webhook-secret')).toBeNull();
        expect(api.secret).not.toHaveBeenCalled();
    });

    it('shows the secret once on request, warns that it is the only time, and forgets it when hidden', async () => {
        const user = userEvent.setup();
        mount();
        await user.click(await screen.findByRole('button', { name: 'Show the secret (once)' }));
        expect((await screen.findByTestId('webhook-secret')).textContent).toBe('s3cret-value');
        expect(api.secret).toHaveBeenCalledWith('app1', 'trigger1', 'reveal');
        expect(screen.getByRole('status').textContent).toContain('shown this once');
        await user.click(screen.getByRole('button', { name: 'I saved it, hide it' }));
        expect(screen.queryByTestId('webhook-secret')).toBeNull();
        expect(document.body.textContent).not.toContain('s3cret-value');
    });

    it('a secret that was shown before can only be replaced, after a confirmation', async () => {
        api.view.mockResolvedValue(VIEW({ secretAvailable: false, previousValidUntil: '2026-11-12T09:00:00.000Z' }));
        const user = userEvent.setup();
        mount();
        expect(await screen.findByText('Shown before. It cannot be shown again.')).toBeTruthy();
        expect(screen.getByText(/The previous secret still works until/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Make a new secret' }));
        expect(api.secret).not.toHaveBeenCalled();
        await user.click(screen.getAllByRole('button', { name: 'Make a new secret' }).at(-1) as HTMLElement);
        await waitFor(() => expect(api.secret).toHaveBeenCalledWith('app1', 'trigger1', 'rotate'));
        expect((await screen.findByTestId('webhook-secret')).textContent).toBe('s3cret-value');
    });

    it('lists the last deliveries with what became of each', async () => {
        api.view.mockResolvedValue(VIEW({}, [
            { id: 'd2', status: 'bad_signature', bodyBytes: 12, bodyHash: null, runId: null, receivedAt: '2026-11-11T10:01:00.000Z' },
            { id: 'd1', status: 'accepted', bodyBytes: 34, bodyHash: 'abcdef012345', runId: 'sar_1', receivedAt: '2026-11-11T10:00:00.000Z' },
        ]));
        mount();
        const list = await screen.findByTestId('webhook-deliveries');
        expect(list.textContent).toContain('Refused: the signature did not fit');
        expect(list.textContent).toContain('Accepted');
        expect(list.textContent).toContain('abcdef012345');
    });

    it('the recipe signs delivery id, time and body in that order', () => {
        expect(signingRecipe(URL, SIGNING)).toContain('printf \'%s\\n%s\\n%s\' "$NONCE" "$TS" "$BODY"');
    });
});

describe('<ServerTriggersPanel> with a webhook trigger', () => {
    const DEF = (triggers?: unknown[]): AppDefinition => ({
        schemaVersion: 2, screens: [], actions: { act_job1: { kind: 'sequence', steps: [] } }, ...(triggers ? { triggers } : {}),
    } as unknown as AppDefinition);

    it('adds a webhook to the draft with nothing but its kind, action and auth: no address, no secret', async () => {
        const onCommit = vi.fn();
        const triggers = { list: vi.fn(), setEnabled: vi.fn() };
        renderWithClient(<ServerTriggersPanel appId="app1" definition={DEF()} onCommit={onCommit} api={triggers as unknown as TriggersApi} />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Add a webhook' }));
        expect(definitionTriggers(onCommit.mock.calls[0][0])).toEqual([{ id: 'trigger1', kind: 'webhook', actionId: 'act_job1', auth: 'hmac' }]);
    });
});
