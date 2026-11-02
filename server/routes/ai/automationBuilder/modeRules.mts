/**
 * The rule texts the assistant work-mode instruction (workMode.js) is built
 * from, split off to keep that file small.
 */

// builder_ask_questions draws a card in the chat. A model that also writes the
// questions in its message shows them twice, once as a list and once as the
// card, and the user answers on the card. The rule sits in the work-mode
// instruction and in the tool description, because a small model reads one of
// the two at best.
export const QUESTIONS_RULE = 'When you call builder_ask_questions, do NOT write the questions or their options in your message: the chat shows them as a card. '
    + 'Say at most one short sentence before the call. Keep each question to one short sentence and each option to a few words; no lists or headings inside them, inline markdown (bold, code) only. '
    + 'Before calling builder_ask_questions, collect EVERY open question and ask them in that one call. Do not ask what you can read from the draft, the catalog or the documents.';

// Binding a step to somebody's real table is the user's call (datatableApproval).
export const TABLE_CONSENT_RULE = 'Bind a step to an EXISTING table only when the user named or picked it, or the flow already uses it. Otherwise call builder_ask_questions with datatableIds (the fitting tables) and createLabel, then wait.';

// What the assistant may call a fact. A path it read in a schema is a guess
// until a run shows it: the key names of a forEach's results, a list's depth.
export const EVIDENCE_RULE = 'Before you suggest a binding or mapping change, read the real output with builder_inspect_run (or the dry run\'s _hint). '
    + 'In your reply mark each path or value as checked (seen in a run, a dry run or an inspect result) or assumed (taken from a schema or the catalog); never present an assumed path as a fact. '
    + 'If there is no run to read, say so.';
