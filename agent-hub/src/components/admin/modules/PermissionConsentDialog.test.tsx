import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EN_DEFAULTS from '../../../i18n/en-defaults';

// Resolve keys through the REAL EN dict so the canonical permission copy is
// what the assertions see (matching what an untranslated install renders).
const t = (key: string, a: string, b: TranslateParams) => {
    const params = (a && typeof a === 'object') ? a : (b && typeof b === 'object' ? b : null);
    let s = (EN_DEFAULTS as Record<string, string>)[key] ?? key;
    for (const [k, v] of Object.entries(params || {})) s = s.replace(`{${k}}`, String(v));
    return s;
};
vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t, locale: 'en' }) }));

import PermissionConsentDialog from './PermissionConsentDialog';
import type { TranslateParams } from '@/hooks/useTranslation';

const MODULE = { id: 'pro', name: 'Pro Module' };

describe('PermissionConsentDialog', () => {
    beforeEach(() => cleanup());

    it('renders the canonical copy per permission id', () => {
        render(
            <PermissionConsentDialog
                module={MODULE}
                permissions={['db', 'ai', { id: 'http:*', reason: 'Calls the vendor API' }, 'env:process']}
                mode="install"
                onAccept={vi.fn()}
                onCancel={vi.fn()}
            />,
        );
        expect(screen.getByText('Pro Module requests permissions')).toBeInTheDocument();
        expect(screen.getByText('Full database access, including organisation and user data')).toBeInTheDocument();
        expect(screen.getByText("Can invoke this instance's AI providers (may incur cost)")).toBeInTheDocument();
        expect(screen.getByText('Can make outbound HTTP requests to any internet host')).toBeInTheDocument();
        expect(screen.getByText('Calls the vendor API')).toBeInTheDocument();
        // env:* ids live in the server-privileges section with its disclaimer.
        const envSection = screen.getByTestId('perm-env-section');
        expect(envSection).toHaveTextContent('Server environment access');
        expect(envSection).toHaveTextContent('Only install modules from vendors you trust.');
        expect(envSection).toHaveTextContent('env:process');
    });

    it('accept passes exactly the shown permission ids', async () => {
        const user = userEvent.setup();
        const onAccept = vi.fn();
        render(
            <PermissionConsentDialog
                module={MODULE}
                permissions={['db', { id: 'email:send' }]}
                mode="update"
                onAccept={onAccept}
                onCancel={vi.fn()}
            />,
        );
        expect(screen.getByText('Pro Module requests new permissions')).toBeInTheDocument();
        await user.click(screen.getByTestId('consent-accept'));
        expect(onAccept).toHaveBeenCalledWith(['db', 'email:send']);
    });

    it('cancel fires onCancel and never onAccept', async () => {
        const user = userEvent.setup();
        const onAccept = vi.fn();
        const onCancel = vi.fn();
        render(
            <PermissionConsentDialog module={MODULE} permissions={['db']} onAccept={onAccept} onCancel={onCancel} />,
        );
        await user.click(screen.getByText('Cancel'));
        expect(onCancel).toHaveBeenCalled();
        expect(onAccept).not.toHaveBeenCalled();
    });
});
