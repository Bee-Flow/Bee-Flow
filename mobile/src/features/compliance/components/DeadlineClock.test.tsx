/** The deadline clock's words, tone and bar per state; the server's verdict wins; quiet clocks. */

import { act, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { Text } from '@/shared/ui';

import { DeadlineClock } from './DeadlineClock';

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 9, 5, 12);
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
    jest.useRealTimers();
});

const label = () => screen.getByTestId('deadline-clock-label');
const bar = () => screen.queryAllByLabelText(String(label().props.accessibilityLabel)).find((el) => el.props.accessibilityRole === 'progressbar') ?? null;
const colour = (el: { props: { style?: unknown } }) => (StyleSheet.flatten(el.props.style as never) as { color?: string } | undefined)?.color;

it('says days left on a month clock, green, with a bar', async () => {
    await renderWithProviders(<DeadlineClock variant="row" clock={{ dueAt: iso(NOW + 10 * D), startedAt: iso(NOW - 20 * D), urgentBelowMs: 5 * D }} />);
    expect(label()).toHaveTextContent('10 d left');
    expect(label().props.accessibilityLabel).toBe('10 days left');
    expect(bar()?.props.accessibilityValue).toEqual(expect.objectContaining({ now: 67 }));
});

it('turns urgent on a 72-hour clock with hours left', async () => {
    await renderWithProviders(<DeadlineClock variant="inline" clock={{ dueAt: iso(NOW + 5 * H), startedAt: iso(NOW - 67 * H), urgentBelowMs: 24 * H }} />);
    expect(label()).toHaveTextContent('5 h left');
    expect(bar()).toBeNull();
});

it('counts an overdue clock, and the server state and pct win', async () => {
    await renderWithProviders(
        <DeadlineClock variant="block" clock={{ dueAt: iso(NOW - 31 * D), startedAt: iso(NOW - 61 * D), state: 'overdue', pct: 0.5, label: 'Authority' }}>
            received 5 Sep
        </DeadlineClock>,
    );
    expect(label()).toHaveTextContent('Authority · overdue by 31 days');
    expect(bar()?.props.accessibilityValue).toEqual(expect.objectContaining({ now: 50 }));
    expect(screen.getByText('received 5 Sep')).toBeTruthy();
});

it('says a done clock without a bar', async () => {
    await renderWithProviders(<DeadlineClock variant="row" clock={{ dueAt: iso(NOW + D), startedAt: iso(NOW - 2 * D), doneAt: iso(NOW) }} />);
    expect(label()).toHaveTextContent('completed in 2 days');
    expect(bar()).toBeNull();
});

it('keeps a quiet clock neutral and lets it carry its own words', async () => {
    await renderWithProviders(
        <>
            <DeadlineClock variant="inline" clock={{ dueAt: iso(NOW + 2 * H), startedAt: iso(NOW - 70 * H), urgentBelowMs: 24 * H, quiet: 'closed · not notified' }} />
            <Text testID="neutral" tone="secondary">
                x
            </Text>
            <Text testID="warning" tone="warning">
                x
            </Text>
        </>,
    );
    expect(label()).toHaveTextContent('closed · not notified');
    expect(colour(label())).toBe(colour(screen.getByTestId('neutral')));
    expect(colour(label())).not.toBe(colour(screen.getByTestId('warning')));
});

it('re-reads the clock every minute', async () => {
    await renderWithProviders(<DeadlineClock variant="inline" clock={{ dueAt: iso(NOW + 2 * H + 30 * 60_000), startedAt: iso(NOW - 60 * H) }} />);
    expect(label()).toHaveTextContent('3 h left');
    await act(async () => {
        jest.advanceTimersByTime(31 * 60_000);
    });
    expect(label()).toHaveTextContent('2 h left');
});
