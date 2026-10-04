import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WebpageEditorHeader, { WEBPAGE_TABS } from './WebpageEditorHeader';

/**
 * The open webpage's 48px header (plan W2).
 *
 * The composition itself is StudioSectionHeader's contract and is pinned
 * there. What is pinned HERE is what this file decides, and every one of
 * those decisions is a claim the screen makes about visibility:
 *
 *   - a page reachable by a public link never reads as "Personal" alone;
 *   - an UNKNOWN share count claims nothing either way;
 *   - the status word follows `is_published`, not the published-version
 *     pointer (statusOf.test.js pins that precedence — a header reading the
 *     pointer would contradict it without turning that test red);
 *   - a viewer gets no rename, no capsule and no publish action;
 *   - a tab count that nobody can answer yet ("Used by") renders NOTHING,
 *     not a confident zero.
 */

const PAGE = {
    id: 'wp1', name: 'Offerte-status', userId: 'alice',
    isPublished: false, sharedGroups: [], publicShareCount: 0,
};

function renderHeader(props = {}) {
    return render(
        <WebpageEditorHeader
            page={PAGE}
            isOwner
            activeTab="preview"
            onTab={() => {}}
            onPublish={() => {}}
            {...props}
        />,
    );
}

describe('WebpageEditorHeader — the row', () => {
    it('is the shared header, mounted once, with the webpage tile', () => {
        renderHeader();
        expect(screen.getAllByTestId('studio-section-header')).toHaveLength(1);
        expect(screen.getByTestId('studio-section-kind').dataset.kind).toBe('webpage');
        expect(screen.getByTestId('studio-section-title')).toHaveTextContent('Offerte-status');
    });

    it('names where back goes — the list, not just "Back"', () => {
        const onBack = vi.fn();
        renderHeader({ onBack });
        const back = screen.getByTestId('studio-section-back');
        expect(back).toHaveAttribute('title', 'Back to list');
        fireEvent.click(back);
        expect(onBack).toHaveBeenCalled();
    });

    it('offers the five sections in artboard order', () => {
        renderHeader();
        const strip = screen.getByRole('radiogroup');
        const labels = within(strip).getAllByRole('radio').map(b => b.textContent.trim());
        expect(labels).toEqual(['Preview', 'Data & links', 'Code', 'History', 'Used by']);
        expect(WEBPAGE_TABS).toEqual(['preview', 'data', 'code', 'history', 'usedby']);
    });

    it('shows a count it has and NOTHING for one it does not', () => {
        renderHeader({ counts: { data: 3 } });
        const strip = screen.getByRole('radiogroup');
        const [, data, , history, usedBy] = within(strip).getAllByRole('radio');
        expect(data.textContent).toContain('3');
        // "Used by" has no endpoint; "History" was not loaded. Neither may
        // invent a zero — an unknown count is silent.
        expect(history.textContent.replace(/\s/g, '')).toBe('History');
        expect(usedBy.textContent.replace(/\s/g, '')).toBe('Usedby');
    });

    it('reports the picked tab', () => {
        const onTab = vi.fn();
        renderHeader({ onTab });
        fireEvent.click(within(screen.getByRole('radiogroup')).getAllByRole('radio')[2]);
        expect(onTab).toHaveBeenCalledWith('code');
    });
});

describe('WebpageEditorHeader — the status split', () => {
    it('a draft offers Publish', () => {
        renderHeader();
        const pill = screen.getByTestId('status-pill');
        expect(pill.dataset.status).toBe('draft');
        expect(within(pill).getByRole('button')).toHaveAccessibleName('Publish');
    });

    it('a published page offers Republish — published is not finished', () => {
        renderHeader({ page: { ...PAGE, isPublished: true } });
        const pill = screen.getByTestId('status-pill');
        expect(pill.dataset.status).toBe('published');
        expect(within(pill).getByRole('button')).toHaveAccessibleName('Republish');
    });

    it('the status follows the flag, NOT the published-version pointer', () => {
        // statusOf.test.js pins `is_published` winning over the pointer. A
        // header that read the pointer would disagree with it silently.
        renderHeader({ page: { ...PAGE, isPublished: false, publishedVersionId: 'v9' } });
        expect(screen.getByTestId('status-pill').dataset.status).toBe('draft');
    });

    it('a publish in flight cannot be fired twice', () => {
        const onPublish = vi.fn();
        renderHeader({ onPublish, publishBusy: true });
        const btn = within(screen.getByTestId('status-pill')).getByRole('button');
        expect(btn).toBeDisabled();
        fireEvent.click(btn);
        expect(onPublish).not.toHaveBeenCalled();
    });
});

describe('WebpageEditorHeader — what it may claim about visibility', () => {
    it('a live public link is stated, and stated BEFORE the audience capsule', () => {
        renderHeader({ page: { ...PAGE, publicShareCount: 1 } });
        const marker = screen.getByTestId('webpage-public-marker');
        const capsule = screen.getByTestId('visibility-capsule');
        expect(marker).toBeInTheDocument();
        // "Personal" is still true of the org audience — but it is not the
        // whole truth, and the wider fact is read first.
        expect(marker.compareDocumentPosition(capsule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('no live links means no marker', () => {
        renderHeader();
        expect(screen.queryByTestId('webpage-public-marker')).not.toBeInTheDocument();
        expect(screen.getByTestId('visibility-capsule').dataset.mode).toBe('personal');
    });

    it('an UNKNOWN share count claims nothing — it does not become "public"', () => {
        // publicShareCount null is what the server sends when the count could
        // not be read. The marker is a positive claim; it needs a real count.
        renderHeader({ page: { ...PAGE, publicShareCount: null } });
        expect(screen.queryByTestId('webpage-public-marker')).not.toBeInTheDocument();
    });

    it('the capsule is the shared one, in capsule shape', () => {
        renderHeader({ page: { ...PAGE, isPublished: true, sharedGroups: ['g1'] } });
        const capsule = screen.getByTestId('visibility-capsule');
        expect(capsule.dataset.variant).toBe('capsule');
        expect(capsule.dataset.mode).toBe('groups');
    });
});

describe('WebpageEditorHeader — the viewer', () => {
    const viewer = { isOwner: false, onRename: vi.fn(), onAddImage: vi.fn() };

    it('gets no rename, no capsule and no publish action', () => {
        renderHeader(viewer);
        expect(screen.queryByTestId('visibility-capsule')).not.toBeInTheDocument();
        expect(within(screen.getByTestId('status-pill')).queryByRole('button')).toBeNull();
        // The title is a plain heading, not a rename button.
        expect(screen.getByTestId('studio-section-title').tagName).toBe('H1');
    });

    it('is not offered Code or History — both refuse a viewer server-side', () => {
        renderHeader(viewer);
        const labels = within(screen.getByRole('radiogroup')).getAllByRole('radio').map(b => b.textContent.trim());
        expect(labels).toEqual(['Preview', 'Data & links', 'Used by']);
    });

    it('gets no Add image either — file management is owner-only', () => {
        renderHeader(viewer);
        expect(screen.queryByRole('button', { name: 'Add image' })).toBeNull();
    });

    it('but IS told when the page is reachable by a public link', () => {
        renderHeader({ ...viewer, page: { ...PAGE, publicShareCount: 2 } });
        expect(screen.getByTestId('webpage-public-marker')).toBeInTheDocument();
    });
});

describe('WebpageEditorHeader — the hoisted IDE buttons', () => {
    it('carries Add image and ZIP for the owner', () => {
        const onAddImage = vi.fn();
        const onDownloadZip = vi.fn();
        renderHeader({ onAddImage, onDownloadZip });
        fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
        fireEvent.click(screen.getByRole('button', { name: 'Download ZIP' }));
        expect(onAddImage).toHaveBeenCalled();
        expect(onDownloadZip).toHaveBeenCalled();
    });

    it('renames through the title, refusing an empty name', () => {
        const onRename = vi.fn();
        renderHeader({ onRename });
        fireEvent.click(screen.getByTestId('studio-section-title'));
        const input = screen.getByTestId('studio-section-title-input');
        fireEvent.change(input, { target: { value: '   ' } });
        fireEvent.blur(input);
        expect(onRename).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('studio-section-title'));
        const again = screen.getByTestId('studio-section-title-input');
        fireEvent.change(again, { target: { value: 'Nieuwe naam' } });
        fireEvent.blur(again);
        expect(onRename).toHaveBeenCalledWith('Nieuwe naam');
    });
});

describe('WebpageEditorHeader — a page a Solution stage manages', () => {
    const MANAGED = { solutionId: 's1', solutionName: 'Intake', stage: 'uat', releaseSeq: 2, devRef: { kind: 'webpage', id: 'dev-wp' } };
    const names = () => within(screen.getByRole('radiogroup')).getAllByRole('radio').map(b => b.textContent.trim());

    it('says who manages it and links to the Dev page', () => {
        renderHeader({ managed: MANAGED });
        expect(screen.getByTestId('managed-part-banner')).toHaveTextContent('Managed by Intake · UAT · Release 2.');
        expect(screen.getByRole('link', { name: 'Open in Dev' })).toHaveAttribute('href', '/app/studio/webpages/dev-wp');
    });

    it('reads `managed` off the page row when no prop is given', () => {
        renderHeader({ page: { ...PAGE, managed: MANAGED } });
        expect(screen.getByTestId('managed-part-banner')).toBeInTheDocument();
    });

    it('takes the ways to write the page away: rename, Code, History, Add image', () => {
        renderHeader({ managed: MANAGED, onAddImage: () => {}, onRename: () => {}, counts: { history: 3 } });
        expect(names().join(' ')).not.toMatch(/Code|History/);
        expect(names().join(' ')).toMatch(/Preview/);
        expect(screen.queryByLabelText('Add image')).toBeNull();
        fireEvent.click(screen.getByTestId('studio-section-title'));
        expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('keeps the audience: a draft still gets its Publish, a live page no Republish', () => {
        const { unmount } = renderHeader({ managed: MANAGED });
        expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
        unmount();
        renderHeader({ managed: MANAGED, page: { ...PAGE, isPublished: true } });
        expect(screen.queryByRole('button', { name: 'Republish' })).toBeNull();
    });

    it('an unmanaged page keeps all of it', () => {
        renderHeader({ onAddImage: () => {} });
        expect(screen.queryByTestId('managed-part-banner')).toBeNull();
        expect(names().join(' ')).toMatch(/Code/);
        expect(screen.getByLabelText('Add image')).toBeInTheDocument();
    });
});
