/**
 * The answers to the builder's questions, in the two shapes they travel in.
 *
 * On screen they are a structured list ({ prompt, answer } per question) that
 * the chat shows as a compact Q/A block. The model, and every provider adapter
 * behind it, only gets text, and that text is the history of the next turns as
 * well: one "Q: ... / A: ..." pair per question. The labels are not markdown on
 * purpose. The old echo of the raw prompt started a line with "- " or "1." now
 * and then, and the bubble then rendered the whole message as a document.
 */

export interface QuestionAnswer {
    prompt: string;
    answer: string;
    /** True when the answer is the model's own recommendation (the first option). Display only; never in the text. */
    suggested?: boolean;
}

// A prompt or an answer is one line in the text: a newline inside it would let
// the next line be read as a list item, and would break the parse below.
const oneLine = (text: string): string => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();

/** The plain text the model receives, and what the saved conversation keeps. */
export function answersToText(answers: readonly QuestionAnswer[]): string {
    return answers.map(({ prompt, answer }) => `Q: ${oneLine(prompt)}\nA: ${oneLine(answer)}`).join('\n\n');
}

const PAIR = /^Q: ([^\n]+)\nA: ([^\n]+)$/;

/**
 * Read answersToText back. A conversation restored from the server has only the
 * text, and it should still show as Q/A, not as the raw labels. Returns null
 * for anything that is not exactly that shape, so a typed message that happens
 * to start with "Q:" stays a typed message.
 */
export function parseAnswersText(content: unknown): QuestionAnswer[] | null {
    if (typeof content !== 'string' || !content.startsWith('Q: ')) return null;
    const blocks = content.split('\n\n');
    const answers: QuestionAnswer[] = [];
    for (const block of blocks) {
        const m = PAIR.exec(block);
        if (!m) return null;
        answers.push({ prompt: m[1], answer: m[2] });
    }
    return answers;
}
