import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The stage TIMELINE — an approval detail for a chain of named steps.
 *
 * The thing worth pinning is that every stage the approval was created with
 * stays on screen, including the two that never ran. "Why did this never get
 * to finance?" is an audit question, and a stage that quietly vanished from
 * the timeline cannot answer it — so `skipped` must read as deliberately
 * passed over and `never_reached` as "the chain stopped first", not as two
 * flavours of blank.
 *
 * And the panel rendering that predates stages must survive untouched: the
 * server sends `kind: 'stages'` for a chain and NO kind at all for a panel,
 * and this view branches on exactly that.
 */

const getApproval = vi.fn();
vi.mock('../../../../hooks/useAutomationApi', () => ({
    default: () => ({
        getApproval: (id) => getApproval(id),
        approvalFileUrl: (id, fileId) => `/files/${id}/${fileId}`,
        decideApproval: vi.fn(),
        withdrawApproval: vi.fn(),
    }),
}));

const { default: ApprovalDetail } = await import('./ApprovalDetail');

const STAGES_PROGRESS = {
    kind: 'stages',
    stage: 's3',
    position: { index: 2, total: 4 },
    stages: [
        {
            key: 's1', name: 'Team lead', description: 'Sanity-check the numbers.',
            rule: 'all', seatCount: 1, approvals: 1, rejects: 0, needed: 1, state: 'done',
            votes: [{ by: 'u9', name: 'Ada', decision: 'approve', reason: 'fine by me', stage: 's1' }],
        },
        {
            key: 's2', name: 'Finance', description: 'Only over €5.000.',
            rule: 'all', seatCount: 2, approvals: 0, rejects: 0, needed: 2, state: 'skipped', votes: [],
        },
        {
            key: 's3', name: 'Director', description: null,
            rule: 'quorum', seatCount: 3, approvals: 1, rejects: 0, needed: 2, state: 'current', votes: [],
        },
        {
            key: 's4', name: 'Board', description: null,
            rule: 'all', seatCount: 2, approvals: 0, rejects: 0, needed: 2, state: 'waiting', votes: [],
        },
        {
            key: 's5', name: 'Notary', description: null,
            rule: 'first', seatCount: 1, approvals: 0, rejects: 0, needed: 1, state: 'never_reached', votes: [],
        },
    ],
};

const stagedApproval = (over = {}) => ({
    id: 'apr_1', status: 'pending', prompt: 'Sign the Acme contract?',
    automationTitle: 'Contracts', createdAt: '2026-08-20T10:00:00Z', expiresAt: null,
    stage: 's3',
    stages: [
        { key: 's1', name: 'Team lead', approvers: [{ userId: 'u9' }], rule: 'all' },
        { key: 's2', name: 'Finance', approvers: [{ userId: 'u8' }], rule: 'all', skipped: true },
        { key: 's3', name: 'Director', approvers: [{ userId: 'u1' }], rule: 'quorum', quorum: 2 },
        { key: 's4', name: 'Board', approvers: [{ userId: 'u2' }], rule: 'all' },
        { key: 's5', name: 'Notary', approvers: [{ userId: 'u3' }], rule: 'first' },
    ],
    ...over,
});

function renderDetail(payload) {
    getApproval.mockResolvedValue(payload);
    return render(<ApprovalDetail approvalId="apr_1" onBack={() => {}} />);
}

beforeEach(() => { getApproval.mockReset(); });

describe('ApprovalDetail — the stage timeline', () => {
    it('renders every stage, in order, including the ones that never ran', async () => {
        renderDetail({
            approval: stagedApproval(), audit: [], runLink: null,
            canDecide: false, canWithdraw: false, votes: [], progress: STAGES_PROGRESS,
        });
        await screen.findByText('Approval chain');
        for (const name of ['Team lead', 'Finance', 'Director', 'Board', 'Notary']) {
            expect(screen.getByText(name)).toBeInTheDocument();
        }
    });

    it('gives each of the five states its own sentence', async () => {
        renderDetail({
            approval: stagedApproval(), audit: [], runLink: null,
            canDecide: false, canWithdraw: false, votes: [], progress: STAGES_PROGRESS,
        });
        await screen.findByText('Approval chain');
        expect(screen.getByText(/Decided/)).toBeInTheDocument();
        expect(screen.getByText(/Waiting on this stage/)).toBeInTheDocument();
        expect(screen.getByText(/Not started yet/)).toBeInTheDocument();
        // A skip is a decision the chain made, not an absence.
        expect(screen.getByText(/Skipped — its condition was not met/)).toBeInTheDocument();
        expect(screen.getByText(/Never reached — the chain stopped before this stage/)).toBeInTheDocument();
    });

    it('numbers the stages over the ones that actually run', async () => {
        renderDetail({
            approval: stagedApproval(), audit: [], runLink: null,
            canDecide: false, canWithdraw: false, votes: [], progress: STAGES_PROGRESS,
        });
        // Four active stages (Finance is skipped), and the header agrees with
        // the server's own position for the current one.
        expect(await screen.findByText('Stage 1 of 4')).toBeInTheDocument();
        expect(screen.getAllByText('Stage 2 of 4').length).toBe(2);   // the header and the current stage's own row
        expect(screen.getByText('Stage 4 of 4')).toBeInTheDocument();
        // The skipped stage gets NO number — it was never a step anybody
        // waited on.
        expect(screen.queryByText('Stage 5 of 4')).not.toBeInTheDocument();
    });

    it('shows each stage its own votes, and its own rule', async () => {
        renderDetail({
            approval: stagedApproval(), audit: [], runLink: null,
            canDecide: false, canWithdraw: false, votes: [], progress: STAGES_PROGRESS,
        });
        await screen.findByText('Approval chain');
        expect(screen.getByText('Ada')).toBeInTheDocument();
        expect(screen.getByText(/fine by me/)).toBeInTheDocument();
        expect(screen.getByText(/At least 2 of 3 must approve/)).toBeInTheDocument();
    });

    it('tells a bystander which stage is holding things up', async () => {
        renderDetail({
            approval: stagedApproval(), audit: [], runLink: null,
            canDecide: false, canWithdraw: false, votes: [], progress: STAGES_PROGRESS,
        });
        expect(await screen.findByText('Waiting for Director — stage 2 of 4.')).toBeInTheDocument();
    });

    it('names the chain rather than claiming a panel', async () => {
        renderDetail({
            approval: stagedApproval(), audit: [], runLink: null,
            canDecide: false, canWithdraw: false, votes: [], progress: STAGES_PROGRESS,
        });
        expect(await screen.findByText('Chain of 4 stages')).toBeInTheDocument();
        expect(screen.queryByText(/^Panel of/)).not.toBeInTheDocument();
    });

    it('reads the stage advance out of the audit trail instead of a raw code', async () => {
        renderDetail({
            approval: stagedApproval(),
            audit: [{ id: 'ev1', ts: '2026-08-21T09:00:00Z', decision: 'stage_passed', comment: 'Team lead → Director' }],
            runLink: null, canDecide: false, canWithdraw: false, votes: [], progress: STAGES_PROGRESS,
        });
        expect(await screen.findByText(/Stage passed — Team lead → Director/)).toBeInTheDocument();
        expect(screen.queryByText('stage_passed')).not.toBeInTheDocument();
    });
});

describe('ApprovalDetail — the panel rendering is untouched', () => {
    it('a progress payload with no `kind` still renders the panel block', async () => {
        renderDetail({
            approval: {
                id: 'apr_2', status: 'pending', prompt: 'Publish?', automationTitle: 'Marketing',
                createdAt: '2026-08-20T10:00:00Z', expiresAt: null,
                approvers: [{ userId: 'u1' }, { userId: 'u2' }],
            },
            audit: [], runLink: null, canDecide: false, canWithdraw: false,
            votes: [{ by: 'u1', name: 'Bo', decision: 'approve', reason: null, stage: 'panel' }],
            progress: {
                rule: 'all', stage: 'panel', seatCount: 2, approvals: 1, rejects: 0,
                needed: 2, hasFinalStage: true,
            },
        });
        await waitFor(() => expect(screen.getByText(/Approval panel/)).toBeInTheDocument());
        expect(screen.getByText('Panel of 2')).toBeInTheDocument();
        expect(screen.getByText(/A final sign-off follows once the panel approves/)).toBeInTheDocument();
        expect(screen.queryByText('Approval chain')).not.toBeInTheDocument();
    });
});
