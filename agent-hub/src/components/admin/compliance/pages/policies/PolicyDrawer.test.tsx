import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PolicyDrawerJs from './PolicyDrawer';
import { unchangedSincePublished } from './policyDraft';

/**
 * Publishing a policy freezes a new version and asks every member to
 * acknowledge it again. The drawer used to do that on one click, even when
 * nothing had changed; it now refuses an unchanged text and asks first.
 */
vi.mock('../../../../../hooks/useTranslation', () => {
    const t = (key: string, fallback?: unknown, vars?: Record<string, unknown>) => {
        let s = typeof fallback === 'string' ? fallback : key;
        for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(String(v));
        return s;
    };
    const hook = () => ({ t, locale: 'en', resolvedLocale: 'en' });
    return { useTranslation: hook, default: hook };
});

interface Doc { slug: string; title: string; status: string; current_version?: number; ack_count?: number; edited?: boolean }
interface FullDoc extends Doc {
    draft_body?: string; owner_user_id?: string | null; review_due_at?: string | null;
    published?: { version: number; title: string; body: string } | null;
}

// PolicyDrawer is plain JavaScript; these are the props it takes.
const PolicyDrawer = PolicyDrawerJs as unknown as React.ComponentType<{
    doc: Doc; orgUsers?: unknown[] | null; busy?: boolean;
    onLoadDoc?: (slug: string) => Promise<FullDoc | null>;
    onSave?: (slug: string, patch: Record<string, unknown>) => unknown;
    onPublish?: (slug: string) => unknown;
    onClose?: () => void; mode?: string;
}>;

afterEach(cleanup);

const DOC: Doc = { slug: 'information-security-policy', title: 'Information security policy', status: 'published', current_version: 3, ack_count: 5, edited: true };
const FULL: FullDoc = {
    ...DOC, draft_body: 'Our policy, v3.', owner_user_id: null, review_due_at: null,
    published: { version: 3, title: 'Information security policy', body: 'Our policy, v3.' },
};

function renderDrawer({ full = FULL, doc = DOC }: { full?: FullDoc; doc?: Doc } = {}) {
    const calls: string[] = [];
    const onLoadDoc = vi.fn(async () => full);
    const onSave = vi.fn(async () => { calls.push('save'); });
    const onPublish = vi.fn(async () => { calls.push('publish'); });
    render(<PolicyDrawer doc={doc} orgUsers={[]} onLoadDoc={onLoadDoc} onSave={onSave} onPublish={onPublish} onClose={vi.fn()} />);
    return { onLoadDoc, onSave, onPublish, calls };
}

describe('PolicyDrawer — Publish only when there is something new, and only after asking', () => {
    it('is disabled while title and text equal the published version, and says why', async () => {
        renderDrawer();
        const publish = await screen.findByTestId('policy-drawer-publish');
        expect(publish).toBeDisabled();
        expect(screen.getByTestId('policy-drawer-unchanged').textContent).toBe('Nothing changed since the published version');
    });

    it('enables once the text changes, asks with the number of acknowledgements it resets, and only then saves and publishes', async () => {
        const user = userEvent.setup();
        const { onPublish, onLoadDoc, calls } = renderDrawer();
        const body = await screen.findByTestId('policy-drawer-body');
        await user.type(body, ' Amended.');
        const publish = screen.getByTestId('policy-drawer-publish');
        expect(publish).toBeEnabled();
        expect(screen.queryByTestId('policy-drawer-unchanged')).toBeNull();
        await user.click(publish);
        expect(onPublish).not.toHaveBeenCalled();
        expect(screen.getByTestId('policy-drawer-confirm-text').textContent).toBe('Publish v4? 5 members will be asked to acknowledge again.');
        // The confirm button takes the focus, so Enter answers the question.
        expect(document.activeElement).toBe(screen.getByTestId('policy-drawer-confirm-go'));
        await user.click(screen.getByTestId('policy-drawer-confirm-go'));
        await waitFor(() => expect(onPublish).toHaveBeenCalledWith('information-security-policy'));
        expect(calls).toEqual(['save', 'publish']);
        // The new version is read back as the baseline.
        await waitFor(() => expect(onLoadDoc).toHaveBeenCalledTimes(2));
    });

    it('Cancel leaves without publishing; one acknowledgement reads in the singular', async () => {
        const user = userEvent.setup();
        const { onPublish } = renderDrawer({ full: { ...FULL, ack_count: 1, draft_body: 'A saved, unpublished draft.' } });
        await user.click(await screen.findByTestId('policy-drawer-publish'));
        expect(screen.getByTestId('policy-drawer-confirm-text').textContent).toBe('Publish v4? 1 member will be asked to acknowledge again.');
        await user.click(screen.getByTestId('policy-drawer-confirm-cancel'));
        expect(screen.queryByTestId('policy-drawer-confirm')).toBeNull();
        expect(onPublish).not.toHaveBeenCalled();
    });

    it('a draft never published can always be published, after the same question', async () => {
        const user = userEvent.setup();
        const draft: FullDoc = { slug: 'access-control', title: 'Access control policy', status: 'draft', current_version: 0, draft_body: 'Template body', edited: false, published: null };
        renderDrawer({ doc: { slug: 'access-control', title: 'Access control policy', status: 'draft' }, full: draft });
        const publish = await screen.findByTestId('policy-drawer-publish');
        expect(publish).toBeEnabled();
        await user.click(publish);
        expect(screen.getByTestId('policy-drawer-confirm-text').textContent).toBe('Publish v1? Members will be asked to acknowledge this version.');
    });

    it('unchangedSincePublished compares title (trimmed) and text, and only for a published document', () => {
        const base = { title: 'T', body: 'B' };
        expect(unchangedSincePublished({ title: ' T ', body: 'B', status: 'published' }, base)).toBe(true);
        expect(unchangedSincePublished({ title: 'T', body: 'B ', status: 'published' }, base)).toBe(false);
        expect(unchangedSincePublished({ title: 'T2', body: 'B', status: 'published' }, base)).toBe(false);
        expect(unchangedSincePublished({ title: 'T', body: 'B', status: 'draft' }, base)).toBe(false);
        expect(unchangedSincePublished({ title: 'T', body: 'B', status: 'published' }, null)).toBe(false);
    });
});

describe('PolicyDrawer — layout', () => {
    it('Save draft sits left and Publish right in the DrawerFooter; the pill carries the version', async () => {
        renderDrawer();
        await screen.findByTestId('policy-drawer-body');
        const footer = screen.getByTestId('policy-drawer-footer');
        const secondary = footer.querySelector('[class*="flex-wrap"]') as HTMLElement;
        expect(within(secondary).getByTestId('policy-drawer-save')).toBeTruthy();
        expect(within(secondary).queryByTestId('policy-drawer-publish')).toBeNull();
        expect(within(footer).getByTestId('policy-drawer-publish')).toBeTruthy();
        const pill = screen.getByTestId('policy-drawer-status');
        expect(pill.textContent).toBe('Published · v3');
        expect(pill.className).toMatch(/\bself-start\b/);
        expect(screen.getByTestId('policy-drawer-slug').textContent).toBe('information-security-policy');
    });

    it('the template nudge is a drawer-sized callout', async () => {
        renderDrawer({ full: { ...FULL, edited: false } });
        const nudge = await screen.findByTestId('policy-drawer-nudge');
        expect(nudge.dataset.size).toBe('sm');
    });
});
