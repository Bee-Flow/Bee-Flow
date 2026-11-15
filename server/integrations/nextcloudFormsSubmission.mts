/**
 * One Nextcloud Forms submission as nextcloud_forms_get_submissions returns
 * it (nextcloudFormsTools.js): the raw answers joined against the form's
 * questions.
 *
 * Questions with no answer are omitted rather than emitted as null, so
 * `Object.keys(answers)` means "what they actually filled in". A question
 * whose text is reused twice in one form would collide, so the numeric-keyed
 * original is preserved alongside as `answersByQuestionId`.
 *
 * Uploaded files (a question of type "file"): Forms stores one answer row per
 * file, its `text` the file name and its `fileId` the Nextcloud file id
 * (Forms' Answer::read()). `answers` keeps the names as before; `files` /
 * `filesByQuestionId` add a list of `{ fileId, name }` per question, a list
 * even for one file, so a loop or `[0].fileId` binding has one shape. Forms
 * returns no path.
 */

type AnswerValue = string | string[];
export type UploadedFile = { fileId: number | string, name: string | null };

/** One answer row as Forms' Answer::read() serialises it. */
export interface FormAnswer { id?: number, submissionId?: number, questionId: number | string, text?: unknown, fileId?: number | string | null }
export interface FormSubmission { id: number, formId?: number, userId?: string | null, timestamp?: number | null, answers?: FormAnswer[] }
export interface FormQuestion { id: number | string, text?: string, type?: string }

/** The uploaded file an answer row of a file question names, or null when it names none. */
function uploadedFileOf(a: FormAnswer): UploadedFile | null {
    if (a.fileId === null || a.fileId === undefined || a.fileId === '') return null;
    return { fileId: a.fileId, name: typeof a.text === 'string' && a.text !== '' ? a.text : null };
}

/** Multiple-choice answers arrive as one row per selected option: the second makes a list. */
function pushAnswer(bag: Record<string, AnswerValue>, key: string, text: string): void {
    const had = bag[key];
    if (had === undefined) bag[key] = text;
    else if (Array.isArray(had)) had.push(text);
    else bag[key] = [had, text];
}

export function mapSubmission(sub: FormSubmission, questions: FormQuestion[]) {
    const textById = new Map(questions.map(q => [String(q.id), q.text]));
    const fileQuestionIds = new Set(questions.filter(q => q.type === 'file').map(q => String(q.id)));
    const answers: Record<string, AnswerValue> = {};
    const answersByQuestionId: Record<string, AnswerValue> = {};
    const files: Record<string, UploadedFile[]> = {};
    const filesByQuestionId: Record<string, UploadedFile[]> = {};
    for (const a of Array.isArray(sub.answers) ? sub.answers : []) {
        const qid = String(a.questionId);
        const text = textById.get(qid);
        const value = a.text as string;
        pushAnswer(answersByQuestionId, qid, value);
        if (text !== undefined) pushAnswer(answers, text, value);
        const file = fileQuestionIds.has(qid) ? uploadedFileOf(a) : null;
        if (file) {
            (filesByQuestionId[qid] ||= []).push(file);
            if (text !== undefined) (files[text] ||= []).push({ ...file });
        }
    }
    return {
        id: sub.id,
        formId: sub.formId,
        userId: sub.userId || null,
        timestamp: sub.timestamp ?? null,
        submittedAt: sub.timestamp ? new Date(sub.timestamp * 1000).toISOString() : null,
        answers,
        answersByQuestionId,
        files,
        filesByQuestionId,
    };
}
