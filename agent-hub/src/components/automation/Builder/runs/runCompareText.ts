/**
 * The words of the run compare: the overall verdict, a step's verdict, why a
 * difference is only "soft", and a file's slides or sheets in plain language.
 * Pure; every caller passes its own t().
 */
import type { TranslateFn } from '@/hooks/useTranslation';
import type {
    CompareResult, CompareSummary, FilePart, FileSummary, SoftReason, StepCompare, StepVerdict,
} from '@/api/queries/automation/runChecks';

export type VerdictTone = 'good' | 'soft' | 'bad';

/** Which expected reasons the soft steps of a compare carry. */
function softReasons(steps: StepCompare[]): Set<SoftReason> {
    const found = new Set<SoftReason>();
    for (const s of steps) if (s.verdict === 'soft' && s.softReason) found.add(s.softReason);
    return found;
}

/** The overall verdict in plain words, with the tone the header takes. */
export function verdictText(t: TranslateFn, result: Pick<CompareResult, 'verdict' | 'steps'>): { text: string; tone: VerdictTone } {
    if (result.verdict === 'same') return { text: t('automation_run_checks.verdict.same', 'Same result'), tone: 'good' };
    if (result.verdict === 'changed') return { text: t('automation_run_checks.verdict.changed', 'Different'), tone: 'bad' };
    const reasons = softReasons(result.steps);
    if (reasons.size === 1 && reasons.has('ai')) {
        return { text: t('automation_run_checks.verdict.soft_ai', 'Only AI answers differ'), tone: 'soft' };
    }
    if (reasons.size === 1 && reasons.has('simulated')) {
        return { text: t('automation_run_checks.verdict.soft_simulated', 'Only simulated steps differ'), tone: 'soft' };
    }
    return { text: t('automation_run_checks.verdict.soft_mixed', 'Only expected differences'), tone: 'soft' };
}

/** "2 steps differ · 1 may vary · 5 are the same". */
export function summaryLine(t: TranslateFn, s: CompareSummary): string {
    const differ = s.changed + s.onlyA + s.onlyB;
    const parts = [
        t('automation_run_checks.summary.differ', '{n} different', { n: differ }),
        t('automation_run_checks.summary.soft', '{n} may vary', { n: s.soft }),
        t('automation_run_checks.summary.same', '{n} the same', { n: s.same }),
    ];
    if (s.notComparable) parts.push(t('automation_run_checks.summary.not_comparable', '{n} not comparable', { n: s.notComparable }));
    return parts.join(' · ');
}

/** The badge on a step row. */
export function stepVerdictText(t: TranslateFn, verdict: StepVerdict): string {
    switch (verdict) {
        case 'same': return t('automation_run_checks.step.same', 'Same');
        case 'soft': return t('automation_run_checks.step.soft', 'Differs, as expected');
        case 'only_a': return t('automation_run_checks.step.only_a', 'Only in run A');
        case 'only_b': return t('automation_run_checks.step.only_b', 'Only in run B');
        case 'status_changed': return t('automation_run_checks.step.status_changed', 'Different outcome');
        case 'not_comparable': return t('automation_run_checks.step.not_comparable', 'Cannot compare');
        default: return t('automation_run_checks.step.changed', 'Different');
    }
}

/** The chip that says why a soft difference is no cause for worry. */
export function softChipText(t: TranslateFn, reason: SoftReason | null): string | null {
    if (reason === 'ai') return t('automation_run_checks.soft.ai', 'AI answer: may vary between runs');
    if (reason === 'simulated') return t('automation_run_checks.soft.simulated', 'Simulated in a test run');
    return null;
}

/** The hint under a step the compare could not read. */
export function notComparableHint(t: TranslateFn): string {
    return t('automation_run_checks.step.not_comparable_hint', 'The data of this step is hidden from you, or it was too large to keep.');
}

/** How a run was executed: a live run, a test run or a dry run. */
export function modeText(t: TranslateFn, mode: string | null, triggerKind: string | null): string {
    if (mode === 'dry_run' || triggerKind === 'dry_run') return t('automation_run_checks.mode.dry_run', 'test run, nothing sent');
    if (mode === 'test') return t('automation_run_checks.mode.test', 'test run');
    return t('automation_run_checks.mode.live', 'live run');
}

/** "1.4 MB", "820 B". */
export function formatBytes(bytes: number | null): string {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PartDetail { field: string; was: string; becomes: string }
export interface PartChange {
    key: string;
    label: string;
    status: 'changed' | 'added' | 'removed';
    details: PartDetail[];
}

const show = (v: string | number | null): string => (v == null ? '-' : String(v));

function partLabel(t: TranslateFn, part: FilePart): string {
    const n = part.index + 1;
    const name = part.title || part.name;
    if (part.kind === 'sheet') {
        return name ? t('automation_run_checks.part.sheet_named', 'Sheet {n} ({name})', { n, name }) : t('automation_run_checks.part.sheet', 'Sheet {n}', { n });
    }
    if (part.kind === 'slide') {
        return name ? t('automation_run_checks.part.slide_named', 'Slide {n} ({name})', { n, name }) : t('automation_run_checks.part.slide', 'Slide {n}', { n });
    }
    return t('automation_run_checks.part.generic', 'Part {n}', { n });
}

function detailsOf(t: TranslateFn, a: FilePart, b: FilePart): PartDetail[] {
    const rows: Array<[string, string | number | null, string | number | null]> = [
        [t('automation_run_checks.part.title', 'Title'), a.title ?? a.name, b.title ?? b.name],
        [t('automation_run_checks.part.rows', 'Rows'), a.rows, b.rows],
        [t('automation_run_checks.part.cols', 'Columns'), a.cols, b.cols],
        [t('automation_run_checks.part.text_length', 'Text length'), a.textChars, b.textChars],
    ];
    const out: PartDetail[] = rows
        .filter(([, was, becomes]) => was !== becomes)
        .map(([field, was, becomes]) => ({ field, was: show(was), becomes: show(becomes) }));
    // Same length and title, other words: the text hash is the only signal left.
    if (!out.length && a.textHash && b.textHash && a.textHash !== b.textHash) {
        out.push({ field: t('automation_run_checks.part.text', 'Text'), was: t('automation_run_checks.part.text_was', 'one wording'), becomes: t('automation_run_checks.part.text_becomes', 'another wording') });
    }
    return out;
}

/** Per slide or sheet: what changed between two versions of a file, matched by position. */
export function partChanges(t: TranslateFn, a: FileSummary | null, b: FileSummary | null): PartChange[] {
    const pa = a?.parts ?? [];
    const pb = b?.parts ?? [];
    const out: PartChange[] = [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i];
        const y = pb[i];
        const key = `${(x || y).kind}-${i}`;
        if (x && !y) out.push({ key, label: partLabel(t, x), status: 'removed', details: [] });
        else if (!x && y) out.push({ key, label: partLabel(t, y), status: 'added', details: [] });
        else if (x && y) {
            const details = detailsOf(t, x, y);
            if (details.length) out.push({ key, label: partLabel(t, y), status: 'changed', details });
        }
    }
    return out;
}
