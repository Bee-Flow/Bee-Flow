import { FileDiff, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppDocumentCompare, useAppDocumentVersions, type AppDocumentCompare as CompareData, type AppDocumentVersion, type DocumentRef } from '@/api/queries/studioAppDocuments';
import useTranslation from '@/hooks/useTranslation';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { EmptyText } from '../uiBits';
import type { NodeProps } from './appNode.types';
import CompareToolbar, { type CompareMode, type VersionChoice } from './documentCompare/CompareToolbar';
import DeckDiffView from './documentCompare/DeckDiffView';
import { parseDocumentRef, sameDocument } from './documentCompare/docRef';
import { DocMessage, DocShell, documentErrorText, useDocumentScope } from './documentCompare/DocShell';
import SheetDiffView from './documentCompare/SheetDiffView';
import { hasChanges, summaryText, type TFn } from './documentCompare/summary';
import TextDiffView from './documentCompare/TextDiffView';
import type { StepFn } from './documentCompare/useStepper';

/**
 * App Studio runtime — 'document_compare'. Spec: server/appStudio/componentSpecs/documentSpecs.js.
 *
 * What changed between two Studio documents, computed on the server from the
 * documents' structured model (server/core/documents/compare): text block by
 * block, presentations slide by slide with both decks rendered, spreadsheets
 * by row, column and cell. The toolbar is the PDF compare's (side by side /
 * inline, only changes, previous / next change, a one-line summary).
 *
 * Two documents: `left` and `right` resolve to references. VERSION MODE: only
 * `left` set (or both the same document): the document as it is now against
 * an earlier version the viewer picks, the one before the current by default.
 */

interface Props { left?: unknown; right?: unknown; leftLabel?: string; rightLabel?: string; mode?: string; onlyChanges?: boolean; emptyText?: string }

const MODES: CompareMode[] = ['side', 'inline'];
type Scope = ReturnType<typeof useDocumentScope>;

type Picked = { documentId: string; versionId: string } | null;

/** The earlier version to compare with: the viewer's pick for THIS document, else the newest earlier one. */
function fromVersion(earlier: AppDocumentVersion[], picked: Picked, documentId: string | null): string | null {
    const chosen = picked && picked.documentId === documentId && earlier.some((v) => v.versionId === picked.versionId);
    return chosen && picked ? picked.versionId : (earlier[0]?.versionId ?? null);
}

/** The two sides: as bound, or in version mode the chosen earlier version against the current one. */
function sidesOf(left: DocumentRef | null, right: DocumentRef | null, documentId: string | null, from: string | null): [DocumentRef | null, DocumentRef | null] {
    if (!documentId) return [left, right];
    return from ? [{ documentId, versionId: from }, { documentId, versionId: null }] : [null, null];
}

/** The two sides, and in version mode which earlier version to compare with. */
function useSides(left: DocumentRef | null, right: DocumentRef | null, scope: Scope) {
    const versionMode = !!left && (!right || sameDocument(left, right));
    const documentId = versionMode && left ? left.documentId : null;
    const versions = useAppDocumentVersions({ ...scope, enabled: scope.enabled && versionMode }, documentId);
    const all = versions.data?.versions;
    const earlier = useMemo(() => (all || []).filter((v) => !v.current), [all]);
    // The pick belongs to the document it was made for: another document starts at its own default.
    const [picked, setPicked] = useState<Picked>(null);
    const from = fromVersion(earlier, picked, documentId);
    const choice: VersionChoice | null = documentId && earlier.length
        ? { versions: all || [], selected: from, onSelect: (versionId) => setPicked({ documentId, versionId }) }
        : null;
    return { versionMode, versions, choice, sides: sidesOf(left, right, documentId, from) };
}

/** The screen for everything short of a compare to show: empty, design, loading, refused. */
function statusScreen(t: TFn, s: {
    leftRef: DocumentRef | null; rightRef: DocumentRef | null; live: boolean; labels: { left: string; right: string; empty: string };
    sides: ReturnType<typeof useSides>; compare: ReturnType<typeof useAppDocumentCompare>;
}): [string, ReactNode] | null {
    const icon = <FileDiff className="h-6 w-6 text-[var(--text-muted)]" aria-hidden="true" />;
    const loading: [string, ReactNode] = ['loading', <DocMessage key="l" icon={<Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" aria-hidden="true" />}>{t('studio_app_documents.comparing', 'Comparing…')}</DocMessage>];
    if (!s.leftRef && !s.rightRef) return ['empty', <EmptyText key="e" text={s.labels.empty} />];
    if (!s.live) return ['design', <DocMessage key="d" icon={icon}>{s.labels.left} / {s.labels.right}</DocMessage>];
    if (!s.leftRef) return ['empty', <EmptyText key="e" text={s.labels.empty} />];
    const { versionMode, versions, choice } = s.sides;
    if (versionMode) {
        if (versions.isError) return ['error', <DocMessage key="x" retry={() => { void versions.refetch(); }}>{documentErrorText(t, versions.error)}</DocMessage>];
        if (!versions.data) return loading;
        if (!versions.data.supported) return ['no-versions', <DocMessage key="n" icon={icon}>{t('studio_app_documents.error.sheet_versions', 'A spreadsheet keeps no earlier versions to show.')}</DocMessage>];
        if (!choice) return ['no-versions', <DocMessage key="n" icon={icon}>{t('studio_app_documents.no_versions', 'This document has no earlier version yet.')}</DocMessage>];
    }
    if (s.compare.isError) return ['error', <DocMessage key="x" retry={() => { void s.compare.refetch(); }}>{documentErrorText(t, s.compare.error)}</DocMessage>];
    if (!s.compare.data) return loading;
    return null;
}

/** Which compare this is: a new pair of documents (or revisions) starts the views afresh. */
const compareKey = (d: CompareData) => [d.left.id, d.left.versionId, d.right.id, d.right.versionId].join(':');

function CompareBody({ data, choice, labels, mode0, onlyChanges0 }: {
    data: CompareData; choice: VersionChoice | null; labels: { left: string; right: string }; mode0: CompareMode; onlyChanges0: boolean;
}) {
    const { t } = useTranslation();
    const [mode, setMode] = useState<CompareMode>(mode0);
    const [onlyChanges, setOnlyChanges] = useState(onlyChanges0);
    const step = useRef<StepFn | null>(null);
    const registerStep = useCallback((fn: StepFn | null) => { step.current = fn; }, []);
    const { result } = data;
    const view = { mode, onlyChanges, registerStep };
    const key = compareKey(data);
    return (
        <>
            <CompareToolbar
                mode={mode} onMode={setMode} onlyChanges={onlyChanges} onOnlyChanges={setOnlyChanges}
                onStep={(dir) => step.current?.(dir)} summary={summaryText(t, result)} changed={hasChanges(result)} versions={choice}
            />
            {result.family === 'deck' ? <DeckDiffView key={key} result={result} leftHtml={data.leftHtml} rightHtml={data.rightHtml} leftLabel={labels.left} rightLabel={labels.right} {...view} /> : null}
            {result.family === 'sheet' ? <SheetDiffView key={key} result={result} {...view} /> : null}
            {result.family === 'text' ? <TextDiffView key={key} result={result} leftLabel={labels.left} rightLabel={labels.right} {...view} /> : null}
        </>
    );
}

export default function AppDocumentCompare({ node }: NodeProps<Props>) {
    const { t } = useTranslation();
    const { actionState, dataState, scope } = useRuntime();
    const props = node.props || {};
    const ctx = { actionState, dataState, scope } as never;
    const leftRef = parseDocumentRef(resolveBinding(props.left as never, ctx).value);
    const rightRef = parseDocumentRef(resolveBinding(props.right as never, ctx).value);
    const docScope = useDocumentScope(node);
    const sides = useSides(leftRef, rightRef, docScope);
    const compare = useAppDocumentCompare(docScope, sides.sides[0], sides.sides[1]);
    const labels = {
        left: props.leftLabel || t('studio_app_documents.before', 'Before'),
        right: props.rightLabel || t('studio_app_documents.after', 'After'),
        empty: props.emptyText || t('studio_app_documents.compare_empty', 'No documents to compare.'),
    };
    const status = statusScreen(t, { leftRef, rightRef, live: docScope.live, labels, sides, compare });
    if (status || !compare.data) return <DocShell node={node} status={status ? status[0] : 'loading'}>{status ? status[1] : null}</DocShell>;
    return (
        <DocShell node={node} status="ready">
            <CompareBody
                data={compare.data} choice={sides.choice} labels={labels}
                mode0={MODES.includes(props.mode as CompareMode) ? (props.mode as CompareMode) : 'side'} onlyChanges0={props.onlyChanges !== false}
            />
        </DocShell>
    );
}
