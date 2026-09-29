/**
 * `knowledge_write` — put text into a knowledge base, so an agent can answer
 * from it later.
 *
 * The other step whose effect outlives the run (the first is `datatable`), and
 * the one whose output an agent will state as FACT. A row somebody can read
 * back and correct is one thing; a paragraph an agent quotes to a customer with
 * a citation is another.
 *
 * ── THE AUTHORISATION IS CHECKED THREE TIMES, ON PURPOSE ────────────
 * At save and at activate (`routes/automation/crud.js`), so the author is told
 * while they can still do something about it — and again HERE, keyed on the
 * identity the run actually has.
 *
 * The third is not redundant. A routine is saved once and runs for months: the
 * author's `manage_knowledge` can be taken away, the base's sharing can narrow,
 * and the definition is data that an import, a restored version or an MCP patch
 * can put an id into that no save path ever saw. A stored definition records
 * what somebody asked for; it is never evidence that it was allowed.
 *
 * The check lives in `integrations/kbIngestTools.executeKbIngestTool`, which
 * this step calls — one gate, shared with the legacy `integration_action`
 * form of the same write, so the two cannot drift.
 *
 * ── A DRY RUN WRITES NOTHING ────────────────────────────────────────
 * Every other step's dry run is a preview; for this one a "preview" that
 * ingested would put a document into a knowledge base an author was only
 * testing against. It reports what it WOULD write and stops there.
 */

const { KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES } = require('../../automation/validate/constants');

/** How much text one step may store. Beyond this it is a document, not a note. */
const MAX_CONTENT_CHARS = 200_000;
const MAX_TITLE_CHARS = 200;

/**
 * A skip in the shape the engine reads: the CODE goes top-level (runDag maps a
 * `skippedReason` to an amber row instead of a green one) and the SENTENCE goes
 * on `output.skipped`, which is where the run view reads it from. The same
 * split `execDatatable` uses.
 *
 * The output always carries the bindable keys too, so a downstream step reading
 * `steps.<id>.output.written` gets `false` rather than a crash — a routine that
 * branches on "did this land" must keep working on the run where it did not.
 */
function skipped(reason, message, extra = {}) {
    return {
        output: {
            written: false, knowledgeBaseId: null, documentId: null, chunks: 0,
            refreshed: false, deduped: false, sourceUri: null, title: '',
            ...extra,
            skipped: message,
        },
        skippedReason: reason,
    };
}

async function execKnowledgeWrite(step, ctx, runState, mode) {
    const { resolveValue, interpolateTemplate } = require('../../automation/bind');
    /**
     * ── SECRETS NEVER REACH A KNOWLEDGE BASE ────────────────────────
     * `resolveValue` strips them when asked (`allowSecrets: false`);
     * `interpolateTemplate` does not — it reads whatever state it is handed.
     * So the state is emptied of them HERE, once, and both paths read the same
     * one. Without it `{{secrets.api_key}}` in the text area would put a live
     * credential into a knowledge base, which is the worst place for one: an
     * agent would quote it back, with a citation, to whoever asked.
     *
     * The same `{ ...runState, secrets: {} }` the approval renderer uses.
     */
    const safeState = { ...runState, secrets: {} };

    /**
     * `content`, `title` and `sourceUri` are `{{…}}` template STRINGS on the
     * step — the shape `generate_document` uses, and the shape the editor's
     * text areas produce. A binding OBJECT still resolves, because a
     * definition is data: an import or an MCP patch can carry one.
     */
    const resolve = (v) => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'string') return interpolateTemplate(v, safeState);
        return resolveValue(v, safeState, { allowSecrets: false });
    };

    const knowledgeBaseId = step.knowledgeBaseId;
    if (!knowledgeBaseId) {
        return skipped('knowledge_write_no_kb', 'This step has no knowledge base to write to.');
    }

    const content = String(resolve(step.content) ?? '').trim();
    if (!content) {
        /**
         * Skipped, not failed. The usual reason is an upstream step that found
         * nothing this run — a ticket with no resolution yet, a summary that
         * did not generate — and a routine that turns amber every time there
         * is nothing to say is a routine somebody switches off.
         */
        return skipped('knowledge_write_empty', 'There was nothing to write this run.', { knowledgeBaseId });
    }
    if (content.length > MAX_CONTENT_CHARS) {
        return skipped('knowledge_write_too_long',
            `The text is ${content.length.toLocaleString()} characters — more than a knowledge-base document holds (${MAX_CONTENT_CHARS.toLocaleString()}). Split it, or summarise it first.`,
            { knowledgeBaseId });
    }

    /**
     * Trimmed by CODE POINT, not by UTF-16 code unit. `String.slice` cuts at
     * 200 units, and an emoji or a CJK extension character is two — so a title
     * landing exactly on the boundary was persisted with a lone surrogate, an
     * unpaired half that renders as a replacement glyph and breaks a JSON
     * round-trip through anything strict.
     */
    const rawTitle = String(resolve(step.title) ?? '').trim();
    const title = [...rawTitle].slice(0, MAX_TITLE_CHARS).join('') || 'Untitled';
    const sourceUri = String(resolve(step.sourceUri) ?? '').trim() || null;
    const nearDuplicateStrategy = KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES.includes(step.nearDuplicateStrategy)
        ? step.nearDuplicateStrategy
        : 'skip';

    if (mode === 'dry_run') {
        // A preview that ingested would leave a document behind in a knowledge
        // base somebody was only testing against — and the whole point of a
        // dry run is that it can be run again.
        /**
         * The SAME key set a live run returns, plus the preview-only extras.
         * The first version returned `wouldWrite` and omitted `written`, so a
         * downstream step binding `steps.<id>.output.written` resolved on a
         * live run and to nothing on a dry run — the branch you were testing
         * behaved differently precisely because you were testing it.
         */
        return {
            output: {
                written: false, knowledgeBaseId, documentId: null, chunks: 0,
                refreshed: false, deduped: false, sourceUri, title,
                // Preview-only, and named so nothing mistakes it for a result.
                wouldWrite: true, characters: content.length, nearDuplicateStrategy,
            },
            dryRunSynthesised: true,
        };
    }

    const { executeKbIngestTool } = require('../../integrations/kbIngestTools');
    const result = await executeKbIngestTool('knowledge_base_ingest', {
        knowledgeBaseId, title, content, sourceUri, nearDuplicateStrategy,
    }, {
        // The routine's OWNER, which is who a run acts as everywhere else —
        // so a trigger anyone can fire cannot become a way to write as
        // somebody with rights the person firing it does not have.
        userId: ctx.userId,
        orgId: ctx.orgId,
        automationId: ctx.automationId || null,
        // How the document is FILED. Without this every routine's article was
        // stamped `support_ticket` / provider `support` — the tool's original
        // and only caller — so a nightly system summary showed up in the
        // Sources list as a support ticket.
        origin: 'routine',
        automationTitle: ctx.automationTitle || null,
    });

    if (result?.error) {
        /**
         * A refusal is a SKIP with the reason on the row, not a thrown error.
         *
         * The commonest one is the gate above — the author's permission was
         * taken away, or the base's sharing narrowed — and that is a
         * configuration problem the author has to see and fix, not a run that
         * should fail loudly at 3am and page somebody. The step goes amber and
         * says which knowledge base and why.
         */
        return skipped('knowledge_write_refused', result.error, { knowledgeBaseId, title, sourceUri });
    }

    return {
        output: {
            written: true,
            knowledgeBaseId,
            documentId: result?.documentId || null,
            chunks: Number(result?.chunks_created) || 0,
            // `refreshed` means the same sourceUri replaced its own document
            // rather than adding a second — which is what makes a nightly
            // routine idempotent, and worth being able to branch on.
            refreshed: !!result?.refreshed,
            deduped: !!result?.deduped,
            sourceUri: result?.sourceUri ?? sourceUri,
            title,
        },
    };
}

module.exports = { execKnowledgeWrite, MAX_CONTENT_CHARS, MAX_TITLE_CHARS };
