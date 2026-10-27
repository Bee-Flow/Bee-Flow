import { FileText, Loader2, Presentation, Sheet } from 'lucide-react';
import { useState } from 'react';
import { useAppDocument, type DocumentFamily } from '@/api/queries/studioAppDocuments';
import useTranslation from '@/hooks/useTranslation';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { EmptyText } from '../uiBits';
import type { NodeProps } from './appNode.types';
import { parseDocumentRef } from './documentCompare/docRef';
import DocumentFrame from './documentCompare/DocumentFrame';
import { DocMessage, DocShell, documentErrorText, useDocumentScope } from './documentCompare/DocShell';
import SheetGrid from './documentCompare/SheetGrid';

/**
 * App Studio runtime — 'document_viewer'. Spec: server/appStudio/componentSpecs/documentSpecs.js.
 *
 * One Studio document, read-only. A page, a designed document or a
 * presentation is the Studio preview itself, in a sandboxed frame
 * (./documentCompare/DocumentFrame); a spreadsheet is its computed values on
 * a grid, one tab at a time. `source` resolves to a document reference
 * ("id", "id@versionId", { documentId }); which documents may be read is the
 * server's decision (routes/studioAppDocuments.js), and a refusal is shown as
 * a sentence, never as a broken frame.
 */

interface Props { source?: unknown; emptyText?: string; showHeader?: boolean }

const FAMILY_ICON: Record<DocumentFamily, typeof FileText> = { text: FileText, deck: Presentation, sheet: Sheet };

function FamilyIcon({ family }: { family: DocumentFamily }) {
    const Icon = FAMILY_ICON[family] || FileText;
    return <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />;
}

export default function AppDocumentViewer({ node }: NodeProps<Props>) {
    const { t } = useTranslation();
    const { actionState, dataState, scope } = useRuntime();
    const props = node.props || {};
    const emptyText = props.emptyText || t('studio_app_documents.viewer_empty', 'No document selected.');
    const ref = parseDocumentRef(resolveBinding(props.source as never, { actionState, dataState, scope } as never).value);
    const docScope = useDocumentScope(node);
    const view = useAppDocument(docScope, ref);
    const [tab, setTab] = useState(0);

    if (!ref) return <DocShell node={node} status="empty"><EmptyText text={emptyText} /></DocShell>;
    if (!docScope.live) {
        return (
            <DocShell node={node} status="design">
                <DocMessage icon={<FileText className="h-6 w-6 text-[var(--text-muted)]" aria-hidden="true" />}>{t('studio_app_documents.viewer_design', 'The document shows here when the app runs.')}</DocMessage>
            </DocShell>
        );
    }
    if (view.isError) return <DocShell node={node} status="error"><DocMessage retry={() => { void view.refetch(); }}>{documentErrorText(t, view.error)}</DocMessage></DocShell>;
    if (!view.data) {
        return (
            <DocShell node={node} status="loading">
                <DocMessage icon={<Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" aria-hidden="true" />}>{t('studio_app_documents.loading', 'Loading the document…')}</DocMessage>
            </DocShell>
        );
    }

    const { document, html, sheet } = view.data;
    const tabs = sheet?.tabs || [];
    const current = tabs[Math.min(tab, Math.max(tabs.length - 1, 0))];
    return (
        <DocShell node={node} status="ready">
            {props.showHeader !== false ? (
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3">
                    <FamilyIcon family={document.family} />
                    <span className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]" data-document-name="true">{document.name}</span>
                    {ref.versionId ? <span className="shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">{t('studio_app_documents.earlier_version', 'Earlier version')}</span> : null}
                </div>
            ) : null}
            {html !== undefined ? (
                <div className="min-h-0 flex-1"><DocumentFrame html={html} title={document.name} /></div>
            ) : (
                <>
                    {tabs.length > 1 ? (
                        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-default)] px-2 py-1" role="tablist" aria-label={t('studio_app_documents.tabs', 'Tabs')}>
                            {tabs.map((tb, i) => (
                                <button key={tb.name} type="button" role="tab" aria-selected={tb === current} onClick={() => setTab(i)}
                                    className="shrink-0 rounded px-2 py-1 text-xs text-[var(--text-secondary)] aria-selected:bg-[var(--bg-tertiary)] aria-selected:text-[var(--text-primary)]">
                                    {tb.name}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {current ? <SheetGrid display={current.display} label={current.name} /> : <EmptyText text={t('studio_app_documents.sheet_empty', 'This tab is empty.')} />}
                </>
            )}
        </DocShell>
    );
}
