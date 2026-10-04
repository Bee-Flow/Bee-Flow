// The e-mail draft card: Send for every provider, Save as Draft only where the
// grant allows it. Outlook drafts need Mail.ReadWrite, which Bee Flow never
// requests, so the button would only ever fail there.

import { render, screen } from '@testing-library/react';
import React from 'react';
import { expect, it, vi } from 'vitest';
import EmailDraftCard from './EmailDraftCard';

const draft = (extra: Record<string, unknown> = {}) => ({
    to: 'anna@example.com', subject: 'Offer', body: 'Hello Anna', ...extra,
});

function renderCard(d: Record<string, unknown>) {
    render(<EmailDraftCard msg={{ emailDrafts: [d] }} emailDraftStatuses={{}} setEmailDraftStatuses={vi.fn()} />);
}

it('offers Send and Save as Draft on a Gmail draft', () => {
    renderCard(draft());
    expect(screen.getByRole('button', { name: /Send Email/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Save as Draft/ })).toBeTruthy();
});

it('offers Send but no Save as Draft on an Outlook draft', () => {
    renderCard(draft({ _provider: 'microsoft' }));
    expect(screen.getByRole('button', { name: /Send Email/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save as Draft/ })).toBeNull();
});
