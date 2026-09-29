import { Bot, Lock, PenLine, Sparkles } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import Button from '../../../../../../shared/Button';
import type { AssistInput, CustomDataError, PersonalDataFinding } from '../../../../../../../api/queries/customData';
import { customDataErrorCode, useAssistMutation, useAssistPreviewQuery } from '../../../../../../../api/queries/customData';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { errorLine } from '../ownDataCopy';
import type { Method } from '../ownDataModel';
import { assistExamples } from '../useTypeWizard';
import { LinkButton, Note } from '../ui';
import type { StepProps } from './stepTypes';

/**
 * The assistant that writes test sentences, and exactly what it is shown.
 *
 * The card renders the server's own preview of the outgoing request, so
 * what the admin reads IS what would be sent: the name, the description,
 * and made-up look-alikes of the examples. The real examples are never in
 * it. "Write test sentences" sends the look-alikes it showed along with the
 * request, and the server refuses (409) if they are no longer what it would
 * send, so the card can never be shown one thing while another goes out.
 */

const SEP = '\u0000';

function methodName(m: Method, t: TranslateFn): string {
    if (m === 'pattern') return t('shield_data.method_pattern', 'A fixed format');
    if (m === 'ai') return t('shield_data.method_ai', 'Recognised by AI');
    return t('shield_data.method_words', 'A list of words');
}

/**
 * The finding's offsets point into the PREVIEW text (`outbound.name` /
 * `outbound.description`), which is what the check read, not into the raw
 * input: quote from there.
 */
function personalDataLine(findings: PersonalDataFinding[], outbound: { name: string; description: string } | undefined, t: TranslateFn): string {
    const f = findings[0];
    const source = (f?.field === 'name' ? outbound?.name : outbound?.description) || '';
    const text = f ? source.slice(f.start, f.end) : '';
    return f?.category === 'Person' && f.field !== 'name'
        ? t('shield_data.assist_personal_name', 'Your description seems to contain a name: “{text}”. Remove it, then try again.', { text })
        : t('shield_data.assist_personal_other', 'This seems to contain personal data: “{text}”. Remove it, then try again.', { text });
}

function Outbound({ name, description, lookalikes, t }: { name: string; description: string; lookalikes: string[]; t: TranslateFn }) {
    const row = (label: string, value: string) => (
        <div className="flex gap-2 text-xs">
            <dt className="shrink-0 w-32 text-[var(--text-tertiary)]">{label}</dt>
            <dd className="m-0 min-w-0 break-words text-[var(--text-primary)]">{value}</dd>
        </div>
    );
    return (
        <dl className="m-0 flex flex-col gap-1">
            {row(t('shield_data.assist_sees_name', 'The name'), name)}
            {row(t('shield_data.assist_sees_desc', 'Your description'), description || t('shield_data.assist_sees_nothing', '(nothing)'))}
            {lookalikes.length > 0 && row(t('shield_data.assist_sees_lookalikes', 'Look-alikes'), lookalikes.join(', '))}
        </dl>
    );
}

function Suggestion({ state, dispatch, t }: Pick<StepProps, 'state' | 'dispatch' | 't'>) {
    const m = state.suggestedMethod;
    if (!m) return null;
    const accept = () => {
        dispatch({ type: 'set_method', method: m });
        if (m === 'pattern' && !state.type.pattern?.source && state.candidates.patterns[0]) {
            dispatch({ type: 'patch_block', block: 'pattern', patch: { source: state.candidates.patterns[0] } });
        }
        if (m === 'ai' && state.candidates.aiLabels[0]) {
            dispatch({ type: 'patch_block', block: 'ai', patch: { prompt: state.candidates.aiLabels[0] } });
        }
        dispatch({ type: 'go', step: 0 });
    };
    return (
        <p role="status" className="m-0 text-xs text-[var(--text-primary)]">
            {t('shield_data.assist_suggests', 'The assistant thinks {method} fits better.', { method: methodName(m, t) })}{' '}
            <LinkButton onClick={accept}>{t('shield_data.assist_switch', 'Switch')}</LinkButton>{' '}
            <LinkButton onClick={() => dispatch({ type: 'dismiss_suggestion' })}>{t('shield_data.assist_keep', 'Keep mine')}</LinkButton>
        </p>
    );
}

function KeepFixed({ state, dispatch, proposal, t }: Pick<StepProps, 'state' | 'dispatch' | 't'> & { proposal: string[] }) {
    if (state.type.method !== 'pattern' || proposal.length === 0) return null;
    const on = (state.tests.keepFixed || []).length > 0;
    return (
        <label className="flex items-start gap-2 text-xs text-[var(--text-primary)] cursor-pointer">
            <input
                type="checkbox"
                className="mt-0.5"
                checked={on}
                onChange={e => dispatch({ type: 'set_keep_fixed', keepFixed: e.target.checked ? proposal : [] })}
            />
            {t('shield_data.keep_fixed', 'Keep “{fixed}” as it is. It is the same in every example.', { fixed: proposal.join('”, “') })}
        </label>
    );
}

function errorText(error: CustomDataError | null, outbound: { name: string; description: string } | undefined, t: TranslateFn): string | null {
    if (!error) return null;
    return error.code === 'assist_personal_data' ? personalDataLine(error.findings, outbound, t) : errorLine(error.code, t);
}

export function AssistantCard({ state, dispatch, ctx, t, onWriteOwn }: StepProps & { onWriteOwn: () => void }) {
    const { id, name, description, method } = state.type;
    // Keyed on the VALUES, joined, rather than on array identities that
    // change on every render: the preview must re-ask only when what it
    // would send actually changes.
    const examplesKey = assistExamples(state).join(SEP);
    const keepKey = method === 'pattern' ? (state.tests.keepFixed || []).join(SEP) : '';
    const input = useMemo<AssistInput>(() => ({
        type: { id, name: name.trim(), description: description.trim(), method },
        examples: examplesKey ? examplesKey.split(SEP) : [],
        ...(keepKey ? { keepFixed: keepKey.split(SEP) } : {}),
    }), [id, name, description, method, examplesKey, keepKey]);
    const preview = useAssistPreviewQuery(ctx.orgId, input);
    const assist = useAssistMutation(ctx.orgId);
    const [stale, setStale] = useState(false);

    const write = async () => {
        if (!preview.data) return;
        setStale(false);
        try {
            const res = await assist.mutateAsync({ ...input, expectLookalikes: preview.data.outbound.lookalikes });
            dispatch({
                type: 'assist_done',
                sentences: [...res.sentences, ...res.nearMisses],
                patterns: res.candidates.patterns.map(p => p.source),
                aiLabels: res.candidates.aiLabels,
                suggestedMethod: res.suggestedMethod,
            });
        } catch (e) {
            if (customDataErrorCode(e) === 'preview_stale') { setStale(true); preview.refetch(); }
        }
    };

    const outbound = preview.data?.outbound;
    const problem = stale ? null : errorText(assist.error, outbound, t) || errorText(preview.error, outbound, t);
    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3.5 py-3 flex flex-col gap-2.5">
            <p className="m-0 flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                <Bot className="w-4 h-4 text-[var(--text-secondary)]" aria-hidden="true" />
                {t('shield_data.assist_intro', 'The assistant can write sentences to test with. It only sees:')}
            </p>
            {preview.data
                ? <Outbound {...preview.data.outbound} t={t} />
                : preview.isFetching && <p className="m-0 text-xs text-[var(--text-tertiary)]">{t('shield_data.assist_checking', 'Checking what the assistant would see…')}</p>}
            <Note Icon={Lock} tone="muted">
                {t('shield_data.assist_footnote', 'Your real examples stay on your server. We put them into the sentences here, after the assistant is done.')}
            </Note>
            <KeepFixed state={state} dispatch={dispatch} proposal={preview.data?.keepFixedProposal || []} t={t} />
            {stale && <p role="status" className="m-0 text-[11px] text-[var(--warning-ink)]">{t('shield_data.assist_stale', 'Something changed. Check what the assistant will see above, then press the button again.')}</p>}
            {problem && <p role="alert" className="m-0 text-[11px] text-[var(--error-ink)]">{problem}</p>}
            <span className="flex gap-2 flex-wrap">
                <Button size="sm" icon={Sparkles} onClick={write} disabled={!preview.data} busy={assist.isPending}>
                    {t('shield_data.assist_write', 'Write test sentences')}
                </Button>
                <Button size="sm" variant="secondary" icon={PenLine} onClick={onWriteOwn}>{t('shield_data.assist_own', 'Write my own')}</Button>
            </span>
            <Suggestion state={state} dispatch={dispatch} t={t} />
        </div>
    );
}

export default AssistantCard;
