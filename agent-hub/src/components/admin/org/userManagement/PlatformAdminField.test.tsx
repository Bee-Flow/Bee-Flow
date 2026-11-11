import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { tParams } from '@/test/i18n';
import PlatformAdminField from './PlatformAdminField';

const renderField = (props: Partial<Parameters<typeof PlatformAdminField>[0]> = {}) => {
    const onChange = vi.fn();
    render(
        <PlatformAdminField role="admin" storedRole="admin" personName="Jan" isSelf={false} onChange={onChange} t={tParams} {...props} />,
    );
    return { onChange, toggle: screen.getByRole('checkbox', { name: 'Platform administrator' }) };
};

describe('PlatformAdminField', () => {
    it('turns the role off for someone else at once, back to the plain user role', async () => {
        const { onChange, toggle } = renderField();
        await userEvent.click(toggle);
        expect(onChange).toHaveBeenCalledWith('user');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('gives back the role the account had before it was switched on', async () => {
        const { onChange, toggle } = renderField({ role: 'admin', storedRole: 'editor' });
        await userEvent.click(toggle);
        expect(onChange).toHaveBeenCalledWith('editor');
    });

    it('does not change the role until the grant is confirmed', async () => {
        const { onChange, toggle } = renderField({ role: 'user', storedRole: 'user' });
        await userEvent.click(toggle);
        expect(onChange).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: 'Make platform administrator' }));
        expect(onChange).toHaveBeenCalledWith('admin');
    });

    it('names a person without a name yet as "this person"', async () => {
        const { toggle } = renderField({ role: 'user', storedRole: '', personName: '' });
        await userEvent.click(toggle);
        expect(screen.getByText('Make this person a platform administrator?')).toBeInTheDocument();
    });

    it('shows the server refusal', () => {
        renderField({ refusal: 'Kept by the server' });
        expect(screen.getByRole('alert')).toHaveTextContent('Kept by the server');
    });
});
