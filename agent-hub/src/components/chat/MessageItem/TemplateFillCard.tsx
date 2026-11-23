/**
 * The form under an answer in which the assistant filled in a template with
 * the user, one per document. The documents come from the turn's
 * template-fill tool results, or after a reload from their short previews
 * (templateFillResults.ts); each document is read from the server, so the form
 * shows what is stored now, edits in the form included.
 *
 * The form itself is the one every place shows (DocumentFillPanel). A
 * conversation answers many times about the same document: only the last of
 * those answers carries the form (FillSlot), the earlier ones point to it.
 */
import { templateFillApi, type TemplateFillApi } from '@/api/templateFillApi';
import DocumentFillPanel from '../../documents/fill/DocumentFillPanel';
import FillSlot from '../../documents/fill/FillSlot';
import { templateFillRefs } from './templateFillResults';

export default function TemplateFillCard({ toolResults, toolHistory, api = templateFillApi }: { toolResults?: unknown; toolHistory?: unknown; api?: TemplateFillApi }) {
    const fills = templateFillRefs(toolResults, toolHistory);
    if (fills.length === 0) return null;
    return (
        <div className="not-prose flex flex-col gap-2 my-2">
            {fills.map((fill) => (
                <FillSlot key={fill.documentId} documentId={fill.documentId}>
                    <DocumentFillPanel documentId={fill.documentId} revision={fill.revision} api={api} />
                </FillSlot>
            ))}
        </div>
    );
}
