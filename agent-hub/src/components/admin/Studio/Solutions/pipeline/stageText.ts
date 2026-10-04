import { useTranslation } from '../../../../../hooks/useTranslation';
import StatusActionPillJs from '../../../../shared/StatusActionPill';
import type { ErrorKind, SubmitBlock } from './pipelineModel';
import { isTerminal, type DeploymentSummary, type PlanAck } from './stagesApi';

/** The words for deployments, errors and blocks: one place, shared by every pipeline view. */

export const fmt = (iso?: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

export type T = ReturnType<typeof useTranslation>['t'];

export const StatusPill = StatusActionPillJs;

/** The words for a deployment kind. Plain strings, so a pill label and a sentence share them. */
export function kindLabel(t: T, kind: DeploymentSummary['kind']): string {
    switch (kind) {
        case 'rollback': return t('solution_stages.kind_rollback', 'Rollback');
        case 'redeploy': return t('solution_stages.kind_redeploy', 'Redeploy');
        case 'settings': return t('solution_stages.kind_settings', 'Settings change');
        case 'remove': return t('solution_stages.kind_remove', 'Removal');
        default: return t('solution_stages.kind_deploy', 'Deploy');
    }
}

/** The words for a deployment status. */
export function statusLabel(t: T, status: string): string {
    switch (status) {
        case 'awaiting_approval': return t('solution_stages.status_awaiting_approval', 'Waiting for approval');
        case 'approved': return t('solution_stages.status_approved', 'Approved');
        case 'rejected': return t('solution_stages.status_rejected', 'Rejected');
        case 'queued': return t('solution_stages.status_queued', 'Queued');
        case 'preparing': return t('solution_stages.status_preparing', 'Preparing');
        case 'committing': return t('solution_stages.status_committing', 'Switching');
        case 'converging': return t('solution_stages.status_converging', 'Finishing');
        case 'compensating': return t('solution_stages.status_compensating', 'Undoing');
        case 'succeeded': return t('solution_stages.status_succeeded', 'Succeeded');
        case 'succeeded_with_warnings': return t('solution_stages.status_succeeded_with_warnings', 'Live, with warnings');
        case 'failed': return t('solution_stages.status_failed', 'Failed');
        case 'cancelled': return t('solution_stages.status_cancelled', 'Cancelled');
        default: return t('solution_stages.status_unknown', 'Unknown');
    }
}

export function errorText(t: T, kind: ErrorKind): string {
    const texts: Record<ErrorKind, string> = {
        plan_stale: t('solution_stages.err_plan_stale', 'Something changed while you were looking. The plan has been read again; check it and confirm once more.'),
        acknowledgement_missing: t('solution_stages.err_ack_missing', 'Tick every box that asks for your agreement first.'),
        stage_busy: t('solution_stages.err_stage_busy', 'Another deployment is running in this stage. Wait for it to finish.'),
        approval_pending: t('solution_stages.err_approval_pending', 'A request for approval is already waiting for this stage. Cancel it or wait for the decision.'),
        release_not_in_uat: t('solution_stages.err_not_in_uat', 'This release has not succeeded in UAT yet, so it cannot go to Production.'),
        release_blocked: t('solution_stages.err_release_blocked', 'This release has problems that have to be fixed in Dev first.'),
        rollback_target_invalid: t('solution_stages.err_rollback_target', 'Production only rolls back to a release that ran there before.'),
        plan_blocked: t('solution_stages.err_plan_blocked', 'The plan has problems that have to be solved first.'),
        solution_owner_only: t('solution_stages.err_owner_only', 'Only the owner of this Solution can do this.'),
        run_as_mismatch: t('solution_stages.err_run_as', 'This stage runs with another person\'s accounts, so only that person can deploy to it.'),
        stage_not_found: t('solution_stages.err_stage_not_found', 'This stage does not exist (any more).'),
        stages_need_org: t('solution_stages.err_needs_org', 'Stages need an organisation. Move this Solution into one first.'),
        capture_raced: t('solution_stages.err_capture_raced', 'The Solution changed while the release was being cut. Try again.'),
        no_licence: t('solution_stages.err_licence', 'Your plan does not include release pipelines.'),
        forbidden: t('solution_stages.err_forbidden', 'You are not allowed to do this.'),
        network: t('solution_stages.err_network', 'The request did not arrive. Check your connection and try again.'),
        unknown: t('solution_stages.err_unknown', 'That did not work. Nothing was changed.'),
    };
    return texts[kind];
}

// ── Words for the deploy dialog ──────────────────────────────────────────────

/**
 * One finding of a plan or a release cut. The server's own sentence wins when
 * it sent one; the codes it sends bare are named here, so the dialog never
 * prints `app.data_model_not_additive` at a person.
 */
export function findingText(t: T, f: { code: string; message?: string | null }): string {
    const known: Record<string, string> = {
        'app.data_model_not_additive': t('solution_stages.finding_app_data_model', 'An app\'s data model drops or changes a field. Stages only take additive changes.'),
        'skill.resource_not_in_solution': t('solution_stages.finding_skill_resource', 'A skill uses a file or resource that is not part of this Solution.'),
        'schema.type_change': t('solution_stages.finding_type_change', 'A column changes type. That cannot be applied to a table that already holds data.'),
        'release_not_in_uat': t('solution_stages.err_not_in_uat', 'This release has not succeeded in UAT yet, so it cannot go to Production.'),
        'rollback_target_invalid': t('solution_stages.err_rollback_target', 'Production only rolls back to a release that ran there before.'),
        'release_blocked': t('solution_stages.err_release_blocked', 'This release has problems that have to be fixed in Dev first.'),
    };
    return f.message || known[f.code] || t('solution_stages.finding_generic', 'Problem: {code}', { code: f.code });
}

export function ackText(t: T, a: PlanAck, name: string): string {
    const texts: Record<string, string> = {
        'kb.personal_data': t('solution_stages.ack_kb_personal', 'I know documents in {name} may contain personal data, and I accept that they are copied.', { name }),
        'privacy.no_lawful_basis': t('solution_stages.ack_no_lawful_basis', 'I know {name} holds personal data without a recorded lawful basis.', { name }),
        'schema.retire_column': t('solution_stages.ack_retire_column', 'I know columns of {name} are retired. Their data is kept, but their constraints are relaxed.', { name }),
        drift: t('solution_stages.ack_drift', 'I know {name} was changed directly in this stage and will be overwritten.', { name }),
        'slug.takeover': t('solution_stages.ack_slug', 'I know {name} takes over an address that was in use.', { name }),
        'reference.personal_data': t('solution_stages.ack_reference_personal', 'I know the reference rows of {name} may contain personal data.', { name }),
        'stage.remove': t('solution_stages.ack_stage_remove', 'I know {name} and everything deployed in it is taken down.', { name }),
        'stage.delete_data': t('solution_stages.ack_stage_delete_data', 'I know the tables and knowledge bases of {name} are deleted with their data.', { name }),
    };
    return texts[a.code] || t('solution_stages.ack_generic', 'I agree ({code}) for {name}.', { code: a.code, name });
}

export function outcomeText(t: T, d: DeploymentSummary, stage: string, seq: number | string): string {
    const params = { seq, stage };
    const texts: Record<string, string> = {
        awaiting_approval: t('solution_stages.done_awaiting', 'Requested. {stage} changes once it is approved; until then nothing changes.', params),
        succeeded: t('solution_stages.done_ok', 'Release {seq} is live in {stage}.', params),
        succeeded_with_warnings: t('solution_stages.done_warnings', 'Release {seq} is live in {stage}, but some follow-up steps did not finish. You can retry them from History.', params),
        failed: t('solution_stages.done_failed', 'Nothing changed in {stage}. {reason}', { stage, reason: d.error?.message || '' }),
    };
    if (texts[d.status]) return texts[d.status];
    return isTerminal(d.status) ? statusLabel(t, d.status) : t('solution_stages.in_progress', 'This takes a moment. You can close this window; it keeps going.');
}

export function blockTexts(t: T): Record<SubmitBlock, string> {
    return {
        no_plan: t('solution_stages.block_no_plan', 'The plan has not loaded.'),
        blocking: t('solution_stages.block_blocking', 'Solve the problems above first.'),
        bindings_missing: t('solution_stages.block_bindings', 'Fill in the missing settings first.'),
        variables_missing: t('solution_stages.block_variables', 'Give the missing variables a value first.'),
        variables_invalid: t('solution_stages.block_variables_invalid', 'Correct the variables that do not fit first.'),
        ack_missing: t('solution_stages.block_acks', 'Tick every box that asks for your agreement.'),
        name_mismatch: t('solution_stages.block_name', 'Type the name of the Solution to confirm.'),
    };
}

export function footerLabels(t: T, seq: number | string): Record<string, string> {
    return {
        deploy_uat: t('solution_stages.go_deploy_uat', 'Deploy R{seq} to UAT', { seq }),
        deploy_prd: t('solution_stages.go_deploy_prd', 'Deploy R{seq} to Production', { seq }),
        promote: t('solution_stages.go_promote', 'Promote R{seq} to Production', { seq }),
        request_approval: t('solution_stages.go_request_approval', 'Request approval for R{seq}', { seq }),
        rollback: t('solution_stages.go_rollback', 'Roll back to R{seq}', { seq }),
        redeploy: t('solution_stages.go_redeploy', 'Redeploy R{seq}', { seq }),
        apply_settings: t('solution_stages.go_apply_settings', 'Apply settings'),
    };
}
