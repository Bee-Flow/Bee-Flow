/**
 * The Privacy Shield header and its detection pill.
 *
 * The pill has three states and a fourth that is silence: before the probe
 * answers (`guard` null) the header must claim neither health nor failure.
 *
 * Run: npx vitest run src/components/admin/security/guardrails/orgShield/parts/ShieldHeader.test.tsx
 */
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';

const t: TranslateFn = (key, fallbackOrParams, paramsArg) => {
    const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : key;
    const params = typeof fallbackOrParams === 'object' ? fallbackOrParams : paramsArg;
    return Object.entries(params || {}).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), fallback);
};

vi.mock('../../../../../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t, locale: 'en' }),
    __esModule: true,
}));

import { DetectionStatusPill } from './DetectionStatusPill';
import { ShieldHeader } from './ShieldHeader';

const NOW = new Date('2026-09-28T12:00:00Z').getTime();

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('DetectionStatusPill', () => {
    it('says nothing before the probe has answered', () => {
        const { container } = render(<DetectionStatusPill guard={null} checkedAt={null} t={t} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('says detection is running, and when that was checked', () => {
        render(<DetectionStatusPill guard={{ configured: true, reachable: true }} checkedAt={NOW - 2 * 60_000} t={t} />);
        // "checked", never "last check": that is the name of step 4's pre-flight.
        expect(screen.getByText('Detection running · checked 2m ago')).toBeInTheDocument();
        // A standing fact that rewords itself each minute: not a live region.
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('keeps the relative time true while the page sits open, without probing again', () => {
        render(<DetectionStatusPill guard={{ configured: true, reachable: true }} checkedAt={NOW} t={t} />);
        expect(screen.getByText('Detection running · checked just now')).toBeInTheDocument();
        act(() => { vi.advanceTimersByTime(3 * 60_000); });
        expect(screen.getByText('Detection running · checked 3m ago')).toBeInTheDocument();
    });

    it('drops the time rather than inventing one when there is no stamp', () => {
        render(<DetectionStatusPill guard={{ configured: true, reachable: true }} t={t} />);
        expect(screen.getByText('Detection running')).toBeInTheDocument();
    });

    it('names a service that is not installed', () => {
        render(<DetectionStatusPill guard={{ configured: false, reachable: false }} checkedAt={NOW} t={t} />);
        expect(screen.getByRole('status')).toHaveTextContent('Detection service not installed');
        expect(screen.queryByText(/Detection running/)).toBeNull();
    });

    it('names a service that is installed but not answering', () => {
        render(<DetectionStatusPill guard={{ configured: true, reachable: false }} checkedAt={NOW} t={t} />);
        expect(screen.getByRole('status')).toHaveTextContent('Detection service not responding');
    });
});

describe('ShieldHeader', () => {
    it('shows the title, the organisation, and the strip inside the same block', () => {
        render(
            <ShieldHeader orgName="Alpha BV" guard={null} strip={<div data-testid="strip" />} t={t}>
                <button type="button">How this works</button>
            </ShieldHeader>,
        );
        const title = screen.getByRole('heading', { name: 'Organization Privacy Shield' });
        expect(screen.getByText('Alpha BV')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'How this works' })).toBeInTheDocument();
        // One surface, one bottom border: the strip is a child of the header block.
        const block = title.closest('div.border-b');
        expect(block).not.toBeNull();
        expect(block).toContainElement(screen.getByTestId('strip'));
    });

    it('decorates without naming: no image without an accessible name', () => {
        render(<ShieldHeader orgName="Alpha BV" guard={{ configured: true, reachable: true }} guardCheckedAt={NOW} t={t} />);
        for (const img of screen.queryAllByRole('img')) expect(img).toHaveAccessibleName();
    });
});
