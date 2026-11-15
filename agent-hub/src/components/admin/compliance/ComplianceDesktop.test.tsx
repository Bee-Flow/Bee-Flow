import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ComplianceDesktop, { RAIL_FOLD, type ComplianceDesktopProps } from './ComplianceDesktop';
import { sectionById } from './sections';
import { partial } from '@/test/mocks';

const COUNTS = { attention_open: 3, frameworks: { gdpr: { score: 79 }, aia: { score: 58 }, iso27001: { score: 88 } }, dsr: { open: 2 } };

function renderDesktop(over: Partial<ComplianceDesktopProps> = {}) {
    const navigate = vi.fn();
    const props: ComplianceDesktopProps = {
        active: 'overview',
        section: sectionById('overview'),
        currentTab: 'status',
        setTab: vi.fn(),
        navigate,
        onBack: null,
        counts: { counts: COUNTS },
        frameworks: partial<ComplianceDesktopProps['frameworks']>({ isEnabled: () => false }),
        core: { overview: null, checks: [] },
        exportsEnabled: true,
        page: <div data-testid="page" />,
        headerCtx: {},
        ...over,
    };
    render(<ComplianceDesktop {...props} />);
    return { navigate };
}

describe('ComplianceDesktop', () => {
    it('leaves the inset to the dashboard frame and names the page once: the section header only', () => {
        renderDesktop({ active: 'dsr', section: sectionById('dsr') });
        const frame = screen.getByTestId('compliance-desktop');
        // AdminTabContent frames Compliance as an inset fill page (AdminPage `inset`): padding here would double it.
        expect(frame.className).not.toMatch(/(^| )(md:)?(p|px|py|pt|pb)-\d/);
        expect(frame.className).toMatch(/@container\/chub/);
        expect(screen.getByTestId('studio-section-title')).toHaveTextContent('Requests (DSR)');
        // The rail carries no "Compliance" title of its own: the dashboard frame already shows it.
        expect(within(screen.getByTestId('compliance-rail')).queryByText('Compliance')).toBeNull();
        expect(screen.getAllByRole('heading')).toHaveLength(1);
    });

    it('folds the 300px rail into a menu below 48rem of frame width (container query)', () => {
        renderDesktop();
        const column = screen.getByTestId('compliance-rail-column');
        for (const c of RAIL_FOLD.rail.split(' ')) expect(column.className.split(' ')).toContain(c);
        const menu = screen.getByTestId('compliance-section-menu');
        for (const c of RAIL_FOLD.menu.split(' ')) expect(menu.parentElement!.className.split(' ')).toContain(c);
        expect(menu).toHaveAccessibleName('Compliance sections: Overview');
        expect(menu).toHaveAttribute('aria-expanded', 'false');
    });

    it('the menu opens every section as a drawer; picking one navigates and closes it', async () => {
        const user = userEvent.setup();
        const { navigate } = renderDesktop();
        await user.click(screen.getByTestId('compliance-section-menu'));
        const drawer = screen.getByRole('dialog', { name: 'Compliance sections' });
        expect(within(drawer).getByTestId('mobile-row-overview')).toHaveAttribute('aria-current', 'page');
        expect(within(drawer).getByTestId('mobile-row-gdpr')).toBeInTheDocument();
        expect(within(drawer).getByTestId('mobile-row-settings')).toBeInTheDocument();
        await user.click(within(drawer).getByTestId('mobile-row-dsr'));
        expect(navigate).toHaveBeenCalledWith('dsr');
        expect(screen.queryByRole('dialog', { name: 'Compliance sections' })).toBeNull();
    });
});
