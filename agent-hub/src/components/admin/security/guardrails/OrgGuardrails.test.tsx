import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import OrgGuardrails from './OrgGuardrails';
import { AdminScopeOverrideProvider } from '../../dashboard/useAdminScopeOverride';
import type { AdminScope } from '../../dashboard/adminTabs';

describe('OrgGuardrails', () => {
    // The view holds one shield: the viewer's home organisation's, so the chip says one organisation.
    it('reports one organisation to the dashboard', () => {
        const set = vi.fn<(scope: AdminScope | null) => void>();
        render(<AdminScopeOverrideProvider value={set}><OrgGuardrails orgId={null} /></AdminScopeOverrideProvider>);
        expect(set).toHaveBeenCalledWith('org');
        expect(set).not.toHaveBeenCalledWith('mixed');
    });
});
