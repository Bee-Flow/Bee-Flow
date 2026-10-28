// The frame, the status screens and the request scope the three document
// components share (document_viewer, document_compare, input_document).

import { RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { documentErrorCode } from '@/api/queries/studioAppDocuments';
import useTranslation from '@/hooks/useTranslation';
import { useDataContext } from '../../DataContext';
import { useRuntime } from '../../RuntimeContext';
import { HEIGHT_PX } from '../../styleResolver.constants';
import { isFill, resolveHeightCss } from '../../styleResolver.helpers';
import type { AppNode } from '@/components/admin/Studio/AppStudio/inspector/appDefinition';
import { useHasQueryClient } from '../comboBox';
import type { TFn } from './summary';

const CENTERED = 'flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-[var(--text-secondary)]';

/** The bordered box: the style's height when it has one, fill in a fill layout, else a sensible default. */
export function DocShell<P>({ node, status, children }: { node: AppNode<P>; status: string; children: ReactNode }) {
    const fill = isFill(node as never);
    const style = node?.style as { height?: string } | undefined;
    const boxed = fill || Boolean(resolveHeightCss(style as never)) || Boolean(HEIGHT_PX[style?.height || '']);
    return (
        <div
            className={`flex w-full min-w-0 flex-col overflow-hidden rounded-[var(--app-radius,inherit)] border border-[var(--border-default)] bg-[var(--bg-primary)]${fill ? ' app-fill' : ''}${boxed ? ' h-full min-h-0' : ' h-[36rem]'}`}
            data-app-document={status}
        >
            {children}
        </div>
    );
}

/** A centred line with an optional icon and "Try again". */
export function DocMessage({ icon, children, retry }: { icon?: ReactNode; children: ReactNode; retry?: () => void }) {
    const { t } = useTranslation();
    return (
        <div className={CENTERED} role={retry ? 'alert' : undefined}>
            {icon}
            <span>{children}</span>
            {retry ? (
                <button type="button" onClick={retry} className="inline-flex items-center gap-1.5 rounded border border-[var(--border-default)] px-2.5 py-1.5 text-xs">
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />{t('studio_app_documents.try_again', 'Try again')}
                </button>
            ) : null}
        </div>
    );
}

/** What a refused read says to the person looking at the app. */
export function documentErrorText(t: TFn, error: unknown): string {
    switch (documentErrorCode(error)) {
        case 'document_not_found': return t('studio_app_documents.error.not_found', 'This document is not available in this app.');
        case 'document_component_not_found': return t('studio_app_documents.error.no_access', 'This part of the app is not available for your role.');
        case 'sheet_versions_unavailable': return t('studio_app_documents.error.sheet_versions', 'A spreadsheet keeps no earlier versions to show.');
        case 'documents_not_comparable': return t('studio_app_documents.error.not_comparable', 'A spreadsheet can only be compared with another spreadsheet.');
        case 'app_not_published': return t('studio_app_documents.error.not_published', 'This app has no published version yet.');
        default: return t('studio_app_documents.error.load_failed', 'The document could not be loaded.');
    }
}

/**
 * Where a document request goes: this app, this component, draft or
 * published. `live` only in a running app: the editor canvas re-renders on
 * every keystroke and must never fetch, and a preview without a query client
 * cannot.
 */
export function useDocumentScope<P>(node: AppNode<P>) {
    const { mode } = useRuntime();
    const { appId, draft } = useDataContext();
    const hasQueryClient = useHasQueryClient();
    const live = mode === 'run' && !!appId && hasQueryClient;
    return { appId: appId || null, nodeId: String(node?.id || ''), draft: !!draft, enabled: live, live };
}
