/**
 * The regulatory calendar's layouts (full and compact), its earlier-dates
 * toggle, the countdown tone, the uncertain footer and its states; the
 * Upcoming dates card; the Timeline tab.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { CalendarPage, calendarPage } from './CalendarPage';
import { RegulatoryCalendar } from './RegulatoryCalendar';
import { TimelineTab } from './TimelineTab';
import { UpcomingDates } from './UpcomingDates';
import type { Milestone } from '../api/calendar';
import { readCalendar } from '../api/calendar';
import { sectionById } from '../model/sections';

const mockPush = jest.fn();
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter(() => mockPush));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('../hooks/useComplianceAccess', () => ({ useComplianceAccess: () => ({ access: { state: 'open' }, open: true, hint: '' }) }));

const NOW = new Date(2026, 8, 14, 12).getTime();
const RAW = {
    milestones: [
        { id: 'p1', date: '2024-08-01', framework_id: 'aia', kind: 'in_force', label_key: 'x.p1', detail_key: null, relevant: true, affects: null, expected: null },
        { id: 'p2', date: '2025-02-02', framework_id: 'aia', kind: 'phase', label_key: 'x.p2', detail_key: null, relevant: true, affects: null, expected: null },
        { id: 'p3', date: '2025-08-02', framework_id: 'aia', kind: 'phase', label_key: 'x.p3', detail_key: null, relevant: true, affects: null, expected: null },
        { id: 'p4', date: '2026-08-02', framework_id: 'aia', kind: 'phase', label_key: 'x.p4', detail_key: null, relevant: true, affects: null, expected: null },
        { id: 'u1', date: '2026-12-02', framework_id: 'aia', kind: 'transition_end', label: 'Art. 50 transition ends', detail: 'Disclose AI', relevant: true, affects: { automations: 3, agents: 0 }, expected: null },
        { id: 'u2', date: '2027-01-20', framework_id: 'machinery', kind: 'in_force', label: 'Machinery Regulation', relevant: false, affects: null, expected: null },
        { id: 'u3', date: '2027-08-02', framework_id: 'aia', kind: 'phase', label: 'Annex I', relevant: true, affects: null, expected: null },
        { id: 'u4', date: '2026-10-01', framework_id: 'aia', kind: 'phase', label: 'Soon one', relevant: true, affects: null, expected: null },
        { id: 'x1', date: null, framework_id: 'aia', kind: 'uncertain', label: 'Digital Omnibus', detail: 'may move Annex III', relevant: true, affects: null, expected: 'Q1 2027' },
    ],
    today_hint: null,
};
const MILESTONES: Milestone[] = readCalendar(RAW).milestones;

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(path.endsWith('/calendar') ? RAW : path.endsWith('/frameworks') ? { frameworks: [], custom: [] } : []));
});

describe('RegulatoryCalendar', () => {
    it('reads the calendar answer through its contract', () => {
        expect(MILESTONES[4]).toMatchObject({ id: 'u1', affects: { automations: 3, agents: 0 }, relevant: true });
        expect(readCalendar(null).milestones).toEqual([]);
    });

    it('shows the two recent past dates, hides older ones behind a toggle, and the today divider', async () => {
        await renderWithProviders(<RegulatoryCalendar milestones={MILESTONES} now={NOW} />);
        expect(screen.getAllByTestId('cal-row-recent')).toHaveLength(2);
        expect(screen.queryAllByTestId('cal-row-past')).toHaveLength(0);
        expect(screen.getByText('today · 14 Sep 2026'.toUpperCase())).toBeTruthy();
        await fireEvent.press(screen.getByText('Show 2 earlier dates'));
        expect(screen.getAllByTestId('cal-row-past')).toHaveLength(2);
        await fireEvent.press(screen.getByText('Show fewer'));
        expect(screen.queryAllByTestId('cal-row-past')).toHaveLength(0);
    });

    it('words every upcoming row with its countdown, in warning ink within 90 days', async () => {
        await renderWithProviders(<RegulatoryCalendar milestones={MILESTONES} now={NOW} />);
        expect(screen.getAllByTestId('cal-row-upcoming')).toHaveLength(4);
        expect(screen.getAllByTestId('cal-countdown-soon').map((n) => n.props.children)).toEqual(['in 17 days', 'in 79 days']);
        expect(screen.getAllByTestId('cal-countdown').map((n) => n.props.children)).toEqual(['in 4 months', 'in 11 months']);
        expect(screen.getByText(/Disclose AI · affects 3 automations/)).toBeTruthy();
        expect(screen.getByText(/not relevant/)).toBeTruthy();
    });

    it('lists the uncertain items with when they are expected', async () => {
        await renderWithProviders(<RegulatoryCalendar milestones={MILESTONES} now={NOW} />);
        expect(screen.getByTestId('cal-uncertain')).toBeTruthy();
        expect(screen.getByText(/Digital Omnibus — may move Annex III · expected Q1 2027/)).toBeTruthy();
    });

    it('shows the next three in compact and opens the calendar for the rest', async () => {
        const open = jest.fn();
        await renderWithProviders(<RegulatoryCalendar variant="compact" milestones={MILESTONES} now={NOW} onOpenCalendar={open} />);
        expect(screen.getAllByTestId(/^cal-row-/)).toHaveLength(3);
        expect(screen.queryByTestId('cal-today')).toBeNull();
        expect(screen.queryByTestId('cal-uncertain')).toBeNull();
        await fireEvent.press(screen.getByText('1 more dates ›'));
        expect(open).toHaveBeenCalled();
    });

    it('has its own failed line', async () => {
        await renderWithProviders(<RegulatoryCalendar milestones={null} failed />);
        expect(screen.getByText('The regulatory calendar could not be read.')).toBeTruthy();
    });

    it('has its own loading line', async () => {
        await renderWithProviders(<RegulatoryCalendar milestones={undefined} />);
        expect(screen.getByText('Reading the calendar…')).toBeTruthy();
    });

    it('has its own empty line', async () => {
        await renderWithProviders(<RegulatoryCalendar milestones={[]} now={NOW} />);
        expect(screen.getByText('No upcoming dates')).toBeTruthy();
    });
});

describe('the calendar surfaces', () => {
    it('the Upcoming dates card stamps today and opens the calendar page', async () => {
        await renderWithProviders(<UpcomingDates enabled now={NOW} />);
        expect(await screen.findByText('Soon one')).toBeTruthy();
        expect(screen.getByTestId('upcoming-dates-today').props.children).toBe('today 14 Sep 2026');
        await fireEvent.press(screen.getByTestId('upcoming-dates-open'));
        expect(mockPush).toHaveBeenCalledWith('/org/compliance/calendar');
    });

    it('the Upcoming dates card says when the read failed', async () => {
        (api.get as jest.Mock).mockRejectedValue(new Error('down'));
        await renderWithProviders(<UpcomingDates enabled now={NOW} />);
        expect(await screen.findByText('Could not read the regulatory calendar right now.')).toBeTruthy();
    });

    it('the calendar page links to the AI Act timeline', async () => {
        expect(calendarPage.title.i18nKey).toBe('compliance.tab_overview_calendar');
        await renderWithProviders(<CalendarPage />);
        expect(await screen.findByText('Only the frameworks that affect you — not legal advice.')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('calendar-aia-phasing'));
        expect(mockPush).toHaveBeenCalledWith('/org/compliance/aia?tab=timeline');
    });

    it('the Timeline tab draws the stepper and the framework calendar', async () => {
        const aia = sectionById('aia');
        if (!aia) throw new Error('no aia section');
        await renderWithProviders(<TimelineTab section={aia} now={NOW} />);
        expect(await screen.findByTestId('timeline-stepper')).toBeTruthy();
        expect(screen.getByTestId('timeline-step-today')).toBeTruthy();
        expect(screen.getAllByTestId('timeline-step-upcoming')).toHaveLength(2);
        expect(screen.getByTestId('timeline-calendar')).toBeTruthy();
    });

    it('the Timeline tab says a framework without stages applies in full', async () => {
        const gdpr = sectionById('gdpr');
        if (!gdpr) throw new Error('no gdpr section');
        await renderWithProviders(<TimelineTab section={gdpr} now={NOW} />);
        expect(await screen.findByText('This framework has no staged dates — it applies in full.')).toBeTruthy();
    });
});
