/**
 * The form under an answer in which the assistant filled in a template with
 * the user (TemplateFillForm), one per document. The documents come from the
 * turn's template-fill tool results, or after a reload from their short
 * previews (templateFillResults.ts); each document is read from the server,
 * so the form shows what is stored now, edits in the form included.
 */
import useTranslation from '@/hooks/useTranslation';
import { useFillDocumentQuery } from '@/api/queries/chatTemplateFill';
import { templateFillApi, type TemplateFillApi } from '@/api/templateFillApi';
import TemplateFillForm from './TemplateFillForm';
import { templateFillRefs, type TemplateFillRef } from './templateFillResults';

function FillDocumentForm({ fill, api }: { fill: TemplateFillRef; api: TemplateFillApi }) {
    const { t } = useTranslation();
    const query = useFillDocumentQuery(fill.documentId, fill.revision, api.load);
    if (query.isError) {
        return <p className="m-0 text-xs text-[var(--text-secondary)]">{t('chat_templates.form_load_failed', 'The form could not be loaded.')}</p>;
    }
    if (!query.data) {
        return <p className="m-0 text-xs text-[var(--text-tertiary)]" aria-busy="true">{t('chat_templates.form_loading', 'Loading the form…')}</p>;
    }
    // A new read (a new tool result) starts the form again from what is stored.
    return <TemplateFillForm key={query.dataUpdatedAt} doc={query.data} api={api} />;
}

export default function TemplateFillCard({ toolResults, toolHistory, api = templateFillApi }: { toolResults?: unknown; toolHistory?: unknown; api?: TemplateFillApi }) {
    const fills = templateFillRefs(toolResults, toolHistory);
    if (fills.length === 0) return null;
    return (
        <div className="not-prose flex flex-col gap-2 my-2">
            {fills.map((fill) => <FillDocumentForm key={fill.documentId} fill={fill} api={api} />)}
        </div>
    );
}
