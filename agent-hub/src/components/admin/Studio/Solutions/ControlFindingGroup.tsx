import { AlertCircle, AlertTriangle, ArrowUpRight } from 'lucide-react';
import React from 'react';

export interface ControlFinding {
    code?: string;
    severity?: string;
    blockedAt?: 'activate' | 'publish' | string | null;
    message?: string;
    remediation?: string | null;
    deepLink?: unknown;
    targetRef?: { id?: string } | null;
}

type T = (key: string, fallback: string) => string;

const BLOCKED_AT_LABEL: Record<string, [string, string]> = {
    activate: ['solutions.blocks_activate', 'blocks turning it on'],
    publish: ['solutions.blocks_publish', 'blocks publishing'],
};

/** Does this finding stop a release? The publish gate's own rule, in one place. */
export function isBlocking(finding: ControlFinding | null | undefined): boolean {
    return finding?.severity === 'error' || finding?.blockedAt === 'publish';
}

/**
 * The row of the Check screen, deliberately NOT shared/FindingRow: an <li> in a
 * list, a visible "Show me" button instead of a clickable row, and the blockedAt
 * ladder that only means something here.
 */
function SolutionFindingRow({ finding, onOpen, readOnly, t }: { finding: ControlFinding; onOpen?: (link: unknown) => void; readOnly: boolean; t: T }) {
    const blocking = isBlocking(finding);
    const ladder = finding.blockedAt ? BLOCKED_AT_LABEL[finding.blockedAt] : null;
    const Icon = blocking ? AlertCircle : AlertTriangle;
    return (
        <li
            className={`flex flex-wrap sm:flex-nowrap items-start gap-2.5 px-3 py-2.5 rounded-[var(--radius-md)] border-l-2 bg-[var(--bg-secondary)] ${blocking ? 'border-[var(--error)]' : 'border-[var(--warning)]'}`}
            data-testid="solution-finding"
        >
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${blocking ? 'text-[var(--error)]' : 'text-[var(--warning)]'}`} aria-hidden="true" />
            <span className="flex-1 min-w-0">
                <span className="block text-[13px] text-[var(--text-primary)]">{finding.message}</span>
                {(finding.remediation || ladder) && (
                    <span className="block text-xs mt-0.5 text-[var(--text-tertiary)]">
                        {ladder && <span className="mr-1.5">{t(ladder[0], ladder[1])} ·</span>}
                        {finding.remediation}
                    </span>
                )}
            </span>
            {/* A link only where the server could name a row to open; a button to nowhere is worse than none. */}
            {Boolean(finding.deepLink) && !readOnly && (
                <button
                    type="button"
                    onClick={() => onOpen?.(finding.deepLink)}
                    className="inline-flex items-center gap-1 px-2.5 min-h-10 sm:min-h-8 rounded-[var(--radius-sm)] text-xs font-medium shrink-0 text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                    data-testid="solution-finding-open"
                >
                    {t('solutions.show_me', 'Show me')}
                    <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                </button>
            )}
        </li>
    );
}

/** One severity group: a heading with a count, then its findings. */
export default function ControlFindingGroup({ title, findings, onOpen, readOnly, t }: { title: string; findings: ControlFinding[]; onOpen?: (link: unknown) => void; readOnly: boolean; t: T }) {
    if (findings.length === 0) return null;
    return (
        <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold mb-2 text-[var(--text-primary)]">
                {title}
                <span className="rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{findings.length}</span>
            </h3>
            <ul className="space-y-1.5">
                {findings.map((f, i) => (
                    <SolutionFindingRow key={`${f.code}-${f.targetRef?.id || 'x'}-${i}`} finding={f} onOpen={onOpen} readOnly={readOnly} t={t} />
                ))}
            </ul>
        </section>
    );
}
