/**
 * The template a person picked in the composer, carried in their message for
 * the assistant without showing a raw id in the chat.
 *
 * The message ends with one line `[template:<id>]`: the assistant reads it
 * (templateFillToolDefs.mts tells it to), and the user's bubble leaves that
 * line out (withoutTemplatePick), so the person sees only "Fill in the
 * template “X” with me."
 */

const PREFIX = '[template:';

/** The picked template's message: the person's sentence, then the marker line. */
export function templatePickMessage(text: string, templateId: string): string {
    return `${text}\n\n${PREFIX}${templateId}]`;
}

/** The message as the person should see it: without a trailing marker line. */
export function withoutTemplatePick(text: string): string {
    const end = text.trimEnd();
    const lineStart = end.lastIndexOf('\n') + 1;
    const last = end.slice(lineStart);
    if (!last.startsWith(PREFIX) || !last.endsWith(']')) return text;
    return end.slice(0, lineStart).trimEnd();
}
