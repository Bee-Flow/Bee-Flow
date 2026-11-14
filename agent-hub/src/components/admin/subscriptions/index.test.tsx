// The Subscriptions console puts its section in the URL
// (admin/subscriptions/<section>): the nav marks the section the URL names,
// a click asks the dashboard to navigate, and a bare or unknown segment opens
// Plans, as admin/subscriptions always did.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import SubscriptionsPanel from './index';
import { subscriptionsPath, subscriptionsSectionOf } from './subscriptionsSections';
import { renderWithClient } from '@/test/render';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { setDemoTransport(async () => json([])); });
afterEach(() => { setDemoTransport(null); });

const nav = () => screen.getByRole('navigation', { name: 'Subscriptions' });

describe('SubscriptionsPanel sections', () => {
    it('opens Plans when the URL names no section or an unknown one', () => {
        expect(subscriptionsSectionOf(undefined)).toBe('plans');
        expect(subscriptionsSectionOf('nope')).toBe('plans');
        expect(subscriptionsSectionOf('audit')).toBe('audit');
        expect(subscriptionsPath('settings')).toBe('admin/subscriptions/settings');

        renderWithClient(<SubscriptionsPanel />);
        expect(screen.getByRole('button', { name: 'Plans' })).toHaveAttribute('aria-current', 'page');
    });

    it('shows the section the URL names', async () => {
        renderWithClient(<SubscriptionsPanel activeSection="audit" />);
        expect(screen.getByRole('button', { name: 'Audit' })).toHaveAttribute('aria-current', 'page');
        expect(await screen.findByRole('heading', { level: 2, name: 'Subscription Audit Log' })).toBeInTheDocument();
    });

    it('navigates to admin/subscriptions/<section> from the nav', async () => {
        const user = userEvent.setup();
        const onNavigate = vi.fn();
        renderWithClient(<SubscriptionsPanel activeSection="plans" onNavigate={onNavigate} />);
        await user.click(screen.getByRole('button', { name: 'Stripe' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/subscriptions/settings');
        expect(nav()).toBeInTheDocument();
    });
});
