import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TranslateFn } from '@/hooks/useTranslation';
import NextcloudBindingsSection from './NextcloudBindingsSection';
import PermissionsSection from './PermissionsSection';
import RolesSection from './RolesSection';
import type { AdminOrganization } from './types';

const t = ((key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key)) as TranslateFn;

// The dashboard page (Roles & permissions, Nextcloud instances) and its in-page tab name these sections:
// they draw no heading of their own, and keep their one-line hint and their add action.
describe('the user-management sections under a dashboard page header', () => {
    it('Roles: no heading, the hint and the add action', async () => {
        const onAddRole = vi.fn();
        render(<RolesSection roles={[{ id: 'admin', name: 'Admin', description: '', permissions: [] }]} onAddRole={onAddRole} onEditRole={vi.fn()} onDeleteRole={vi.fn()} />);
        expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
        expect(screen.getByText('Define role templates with permissions')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: /Add Role/ }));
        expect(onAddRole).toHaveBeenCalledOnce();
    });

    it('Permissions: no heading, the hint', () => {
        render(<PermissionsSection permissions={[{ id: 'all', name: 'All', description: '' }]} />);
        expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
        expect(screen.getByText('Available permissions for roles and groups')).toBeInTheDocument();
    });

    it('Nextcloud bindings: no heading, the hint', () => {
        const orgs = [{ id: 'org-b', name: 'Org B', nc_instance_id: 'nc-1' }] as unknown as AdminOrganization[];
        render(<NextcloudBindingsSection organizations={orgs} onRemoveNcBinding={vi.fn()} t={t} />);
        expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
        expect(screen.getByText('admin.nc_bindings_desc')).toBeInTheDocument();
        expect(screen.getByText('Org B')).toBeInTheDocument();
    });
});
