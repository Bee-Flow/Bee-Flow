import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DetailLayout, DetailListGroup, DetailListNav, DetailListRow } from './DetailList';

describe('DetailList', () => {
    it('renders a named list of grouped rows beside the detail and reports a click', async () => {
        const onClick = vi.fn();
        render(
            <DetailLayout
                list={(
                    <DetailListNav label="Engines">
                        <DetailListGroup title="Cloud" count={2}>
                            <DetailListRow icon="A" name="Alpha" live meta="Active" active onClick={() => {}} />
                            <DetailListRow icon="B" name="Beta" live={false} active={false} onClick={onClick} />
                        </DetailListGroup>
                    </DetailListNav>
                )}
            >
                <p>Alpha detail</p>
            </DetailLayout>,
        );
        const nav = screen.getByRole('navigation', { name: 'Engines' });
        const group = within(nav).getByRole('region', { name: 'Cloud' });
        expect(within(group).getByText('2')).toBeInTheDocument();
        expect(within(group).getByRole('button', { name: /Alpha/ })).toHaveAttribute('aria-current', 'true');
        expect(within(group).getByRole('button', { name: /Alpha/ })).toHaveTextContent('Active');
        expect(within(group).getByRole('button', { name: /Beta/ })).not.toHaveAttribute('aria-current');
        expect(screen.getByText('Alpha detail')).toBeInTheDocument();
        await userEvent.setup().click(within(group).getByRole('button', { name: /Beta/ }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('leaves the count out when none is given', () => {
        render(<DetailListGroup title="Local"><span>row</span></DetailListGroup>);
        expect(screen.getByRole('region', { name: 'Local' })).toHaveTextContent(/^Localrow$/);
    });
});
