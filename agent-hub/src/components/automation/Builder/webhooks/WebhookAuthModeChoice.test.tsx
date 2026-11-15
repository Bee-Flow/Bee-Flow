import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import WebhookAuthModeChoice from './WebhookAuthModeChoice';
import type { WebhookAuthMode } from './useWebhooks';

/** The choice as a panel holds it: signed until the author picks otherwise. */
function Holder({ seen }: { seen: WebhookAuthMode[] }) {
    const [mode, setMode] = useState<WebhookAuthMode>('hmac');
    return <WebhookAuthModeChoice value={mode} onChange={(m) => { seen.push(m); setMode(m); }} />;
}

describe('the auth mode of a new webhook', () => {
    it('starts signed, without a warning', () => {
        render(<Holder seen={[]} />);
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('hmac');
        expect(screen.queryByTestId('webhook-header-token-warning')).toBeNull();
    });

    it('warns that a header token is weaker than signing when it is picked', async () => {
        const seen: WebhookAuthMode[] = [];
        render(<Holder seen={seen} />);
        await userEvent.selectOptions(screen.getByRole('combobox'), 'header_token');
        expect(seen).toEqual(['header_token']);
        expect(screen.getByTestId('webhook-header-token-warning').textContent).toContain('weaker than signing');
        await userEvent.selectOptions(screen.getByRole('combobox'), 'hmac');
        expect(screen.queryByTestId('webhook-header-token-warning')).toBeNull();
    });
});
