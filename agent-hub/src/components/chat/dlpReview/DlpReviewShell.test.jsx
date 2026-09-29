import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import DlpReviewShell from './DlpReviewShell';

describe('DlpReviewShell', () => {
    beforeEach(cleanup);

    it('renders the chat-bubble renderer for a chat_text review, with the finding highlighted', () => {
        const pending = {
            kind: 'chat_text',
            decisionId: 'd1',
            provider: { displayName: 'OpenAI', isExternal: true },
            reviewText: 'hello Alice',
            findings: [{ id: 'pii_0', category: 'Person', source: 'pii', offset: 6, length: 5, text: 'Alice', confidenceBand: 'high' }],
            summary: { name: 1 },
        };
        render(<DlpReviewShell pending={pending} onSubmit={() => {}} submitting={false} error={null} />);
        expect(screen.getByText('Alice')).toBeTruthy();
        expect(screen.getByText('OpenAI')).toBeTruthy();
    });

    it('renders the document-card renderer with the filename for an attachment review', () => {
        const pending = {
            kind: 'attachment',
            decisionId: 'd2',
            filename: 'report.pdf',
            provider: { displayName: 'OpenAI', isExternal: true },
            reviewText: 'contact leak@example.com for details',
            findings: [{ id: 'pii_0', category: 'Email', source: 'pii', offset: 8, length: 17, text: 'leak@example.com', confidenceBand: 'high' }],
            summary: { Email: 1 },
        };
        render(<DlpReviewShell pending={pending} onSubmit={() => {}} submitting={false} error={null} />);
        expect(screen.getByText('report.pdf')).toBeTruthy();
        expect(screen.getByText('leak@example.com')).toBeTruthy();
    });

    it('shows "No personal data detected" copy when a dlpAlwaysReview pause finds nothing', () => {
        const pending = { kind: 'chat_text', decisionId: 'd3', reviewText: 'volledig onschuldig bericht', findings: [], summary: {} };
        render(<DlpReviewShell pending={pending} onSubmit={() => {}} submitting={false} error={null} />);
        expect(screen.getByText(/No personal data detected/)).toBeTruthy();
    });
});
