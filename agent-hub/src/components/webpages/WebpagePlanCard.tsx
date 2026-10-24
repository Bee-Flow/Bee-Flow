import React, { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { CheckCircle2, X, Loader2, ChevronRight, FileCode2, Palette, Cpu } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface PlanStep {
    file: string;
    action: string;
    why?: string;
    preview?: string;
}

interface WebpagePlan {
    title?: string;
    summary?: string;
    steps: PlanStep[];
}

interface WebpagePlanCardProps {
    plan?: WebpagePlan | null;
    status?: 'pending' | 'approved' | 'executed' | 'rejected';
    planId?: string;
    onApprove?(planId?: string): void;
    onReject?(planId?: string): void;
}

const FILE_ICON: Record<string, LucideIcon> = { html: FileCode2, css: Palette, js: Cpu };
const FILE_LABEL: Record<string, string> = { html: 'index.html', css: 'style.css', js: 'script.js' };
const ACTION_LABEL: Record<string, string> = { edit: 'Edit', create: 'Create', rewrite: 'Rewrite', partial_edit: 'Edit' };
const ACTION_TONE: Record<string, { bg: string; fg: string }> = {
    edit: { bg: 'rgba(234,179,8,0.16)', fg: 'rgb(133,77,14)' },
    partial_edit: { bg: 'rgba(234,179,8,0.16)', fg: 'rgb(133,77,14)' },
    create: { bg: 'rgba(22,163,74,0.12)', fg: 'rgb(22,101,52)' },
    rewrite: { bg: 'rgba(2,132,199,0.12)', fg: 'rgb(7,89,133)' },
};

/**
 * Plan-then-build approval card. Mirrors the EmailDraftCard status state
 * machine: pending → approved → executed | rejected.
 *
 * Props:
 *   plan      = { title, summary, steps[] }
 *   status    = 'pending' | 'approved' | 'executed' | 'rejected'
 *   onApprove(planId) — fired when the user clicks Approve & build
 *   onReject(planId)
 *   planId
 */
export default function WebpagePlanCard({ plan, status = 'pending', planId, onApprove, onReject }: WebpagePlanCardProps) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(true);

    if (!plan) return null;

    const stepCount = Array.isArray(plan.steps) ? plan.steps.length : 0;

    const tone = (() => {
        switch (status) {
            case 'approved': return { border: 'rgba(2,132,199,0.45)', bg: 'rgba(2,132,199,0.05)' };
            case 'executed': return { border: 'rgba(22,163,74,0.45)', bg: 'rgba(22,163,74,0.05)' };
            case 'rejected': return { border: 'var(--border-subtle)', bg: 'transparent', muted: true };
            default:         return { border: 'var(--accent-primary)', bg: 'color-mix(in srgb, var(--accent-primary) 5%, transparent)' };
        }
    })();

    return (
        <div
            className="my-2 rounded-xl border"
            style={{
                borderColor: tone.border,
                background: tone.bg,
                opacity: status === 'rejected' ? 0.55 : 1,
                transition: 'all .15s',
            }}
        >
            {/* Header */}
            <button
                type="button"
                onClick={() => setExpanded((e: boolean) => !e)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left"
            >
                <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-semibold truncate text-[var(--text-primary)]">
                        {plan.title || 'Plan'}
                    </div>
                    <div className="text-[10px] truncate text-[var(--text-tertiary)]">
                        {stepCount === 1 ? t('webpages.plan.step_one', '1 step') : t('webpages.plan.steps', '{count} steps', { count: stepCount })}
                        {status === 'approved' && ' · ' + t('webpages.plan.building', 'Building…')}
                        {status === 'executed' && ' · ' + t('webpages.plan.built', 'Built')}
                        {status === 'rejected' && ' · Rejected'}
                    </div>
                </div>
                {status === 'approved' && <Loader2 size={13} className="animate-spin text-[var(--accent-primary)]" />}
                {status === 'executed' && <CheckCircle2 size={14} className="[color:rgb(22,163,74)]" />}
                <ChevronRight
                    size={14}
                    style={{
                        color: 'var(--text-tertiary)',
                        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform .12s',
                    }}
                />
            </button>

            {/* Body */}
            {expanded && (
                <div className="px-3 pb-2 pt-0">
                    {plan.summary && (
                        <p className="text-[11px] mb-2 leading-relaxed text-[var(--text-secondary)]">
                            {plan.summary}
                        </p>
                    )}

                    {/* Steps */}
                    {stepCount > 0 && (
                        <ol className="space-y-1.5 mb-2">
                            {plan.steps.map((s: PlanStep, i: number) => {
                                const Icon = FILE_ICON[s.file] || FileCode2;
                                const action = ACTION_TONE[s.action] || ACTION_TONE.partial_edit;
                                return (
                                    <li
                                        key={i}
                                        className="flex items-start gap-2 rounded-lg p-1.5 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]"
                                    >
                                        <span
                                            className="shrink-0 inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold rounded bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
                                        >
                                            {i + 1}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <Icon size={12} className="text-[var(--text-secondary)]" />
                                                <span className="text-[11px] font-mono text-[var(--text-primary)]">
                                                    {FILE_LABEL[s.file] || s.file}
                                                </span>
                                                <span
                                                    className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                                                    style={{ background: action.bg, color: action.fg }}
                                                >
                                                    {ACTION_LABEL[s.action] || s.action}
                                                </span>
                                            </div>
                                            {s.why && (
                                                <p className="text-[11px] mt-0.5 leading-snug text-[var(--text-secondary)]">
                                                    {s.why}
                                                </p>
                                            )}
                                            {s.preview && (
                                                <pre
                                                    className="mt-1 text-[10px] font-mono whitespace-pre-wrap break-words rounded p-1.5 overflow-x-auto [background:var(--bg-secondary)] [color:var(--text-tertiary)]! max-h-[120px]"
                                                >
                                                    {s.preview}
                                                </pre>
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    )}

                    {/* Action buttons (only while pending) */}
                    {status === 'pending' && (
                        <div className="flex items-center gap-1.5 mt-2">
                            <button
                                onClick={() => onApprove?.(planId)}
                                className="px-2.5 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1 hover:opacity-90 [background:var(--accent-primary)] [color:white]!"
                            >
                                <CheckCircle2 size={12} /> {t('webpages.plan.approve', 'Approve & build')}
                            </button>
                            <button
                                onClick={() => onReject?.(planId)}
                                className="px-2 py-1 rounded-md text-[11px] flex items-center gap-1 hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
                            >
                                <X size={12} /> {t('webpages.plan.reject', 'Reject')}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
