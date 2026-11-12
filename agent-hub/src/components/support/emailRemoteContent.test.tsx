/**
 * A mail in an app's mailbox loads nothing from another host until the viewer
 * shows the images of that message.
 *
 * Run: cd agent-hub && npx vitest run src/components/support/emailRemoteContent.test.tsx
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import EmailHtmlBody from './EmailHtmlBody';
import { ALLOW_REMOTE_CSP, BLOCK_REMOTE_CSP, hasRemoteContent } from './emailRemoteContent';

const PIXEL = '<p>Hello</p><img src="https://track.example/p.gif?u=1"><link rel="stylesheet" href="https://cdn.example/s.css">';

const srcdocOf = (container: HTMLElement) => container.querySelector('iframe')?.getAttribute('srcdoc') || '';

describe('remote content in a mail', () => {
    it('is recognised in pictures, srcset, background, style url() and @import, and links', () => {
        expect(hasRemoteContent('<img src="https://x.example/a.png">')).toBe(true);
        expect(hasRemoteContent('<img srcset="a.png 1x, //x.example/b.png 2x">')).toBe(true);
        expect(hasRemoteContent('<table background="http://x.example/bg.png"></table>')).toBe(true);
        expect(hasRemoteContent('<div style="background:url( \'https://x.example/a.png\')"></div>')).toBe(true);
        expect(hasRemoteContent('<style>@import "https://x.example/s.css";</style>')).toBe(true);
        expect(hasRemoteContent('<link rel="dns-prefetch" href="//x.example">')).toBe(true);
        expect(hasRemoteContent('<p>plain</p><img src="data:image/png;base64,AAAA">')).toBe(false);
    });

    it('in ask mode: a policy that blocks remote loads comes first, links are gone, and the viewer is told', () => {
        const { container } = render(<EmailHtmlBody html={PIXEL} remoteImages="ask" />);
        const doc = srcdocOf(container);
        expect(doc).toContain(`content="${BLOCK_REMOTE_CSP}"`);
        expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('track.example'));
        expect(doc).not.toContain('cdn.example');
        expect(screen.getByTestId('email-remote-held')).toBeTruthy();
    });

    it('"Show images" loads them for this message only', async () => {
        const { container } = render(
            <>
                <div data-testid="one"><EmailHtmlBody html={PIXEL} remoteImages="ask" /></div>
                <div data-testid="two"><EmailHtmlBody html={PIXEL} remoteImages="ask" /></div>
            </>,
        );
        const [first] = screen.getAllByRole('button', { name: 'Show images' });
        await userEvent.click(first);
        const frames = container.querySelectorAll('iframe');
        expect(frames[0].getAttribute('srcdoc')).toContain(`content="${ALLOW_REMOTE_CSP}"`);
        expect(frames[0].getAttribute('srcdoc')).toContain('cdn.example');
        expect(frames[1].getAttribute('srcdoc')).toContain(`content="${BLOCK_REMOTE_CSP}"`);
        expect(screen.getAllByRole('button', { name: 'Show images' })).toHaveLength(1);
    });

    it('a full document gets the policy at the start of its own head; without remote content there is no notice', () => {
        const { container } = render(<EmailHtmlBody html={'<!doctype html><html><head><style>p{color:red}</style></head><body><img src="https://t.example/x.gif"></body></html>'} remoteImages="ask" />);
        expect(srcdocOf(container)).toMatch(/<head><meta http-equiv="Content-Security-Policy"/);
        const plain = render(<EmailHtmlBody html="<p>No pictures</p>" remoteImages="ask" />);
        expect(plain.container.querySelector('[data-testid="email-remote-held"]')).toBeNull();
    });

    it('other surfaces keep loading as before', () => {
        const { container } = render(<EmailHtmlBody html={PIXEL} />);
        expect(srcdocOf(container)).not.toContain('Content-Security-Policy');
        expect(screen.queryByTestId('email-remote-held')).toBeNull();
    });
});
