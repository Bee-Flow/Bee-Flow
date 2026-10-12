/**
 * Nextcloud Forms Tools — the intake side of a workflow.
 *
 * Forms is where work *enters* an organisation: a leave request, a support
 * intake, an event signup. Paired with the `forms.submitted` push trigger it
 * closes the loop Nextcloud's own Flow documentation holds up as the canonical
 * example and that users have publicly struggled to build — form in, table
 * row out, document generated, reply sent.
 *
 * API: OCS v3 at `/ocs/v2.php/apps/forms/api/v3/...` (responses are wrapped in
 * the usual `ocs.data` envelope). v3 is what current Forms ships; older v2
 * instances answer 404 and are reported as "upgrade Forms" rather than as a
 * generic failure.
 *
 * Answer shape. A submission's answers are keyed by numeric question id, which
 * is meaningless to an agent or to an automation binding. `nextcloud_forms_get_submissions`
 * joins them against the form's questions and returns answers keyed by question
 * TEXT, so `{{trigger.output.answers.Department}}` works in the builder.
 */

const ncClient = require('./nextcloudClient');

const FORMS_API = '/ocs/v2.php/apps/forms/api/v3';
const MAX_SUBMISSIONS = 200;
const DEFAULT_SUBMISSIONS = 50;

const NEXTCLOUD_FORMS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_forms_list',
            description: 'List the Nextcloud Forms the user owns or has been given access to, with id, hash, title and state. Call this first to find a form id.',
            parameters: {
                type: 'object',
                properties: {
                    includeShared: { type: 'boolean', description: 'Also include forms shared with the user, not just owned ones. Default true.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_forms_get',
            description: 'Get one form in full: settings, access, and the list of questions with their ids, types and options.',
            parameters: {
                type: 'object',
                properties: {
                    formId: { type: 'integer', description: 'Form id (from nextcloud_forms_list).' }
                },
                required: ['formId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_forms_create',
            description: 'Create an empty form and set its title/description. Add questions afterwards with nextcloud_forms_add_question.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Form title.' },
                    description: { type: 'string', description: 'Optional description shown above the questions.' }
                },
                required: ['title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_forms_add_question',
            description: 'Add a question to a form. For multiple-choice types pass the options list.',
            parameters: {
                type: 'object',
                properties: {
                    formId: { type: 'integer', description: 'Form id.' },
                    text: { type: 'string', description: 'The question itself.' },
                    type: { type: 'string', description: 'One of "short", "long", "multiple", "multiple_unique", "dropdown", "date", "datetime", "time", "file". Defaults to "short".' },
                    options: { type: 'array', items: { type: 'string' }, description: 'Answer options — required for multiple/multiple_unique/dropdown.' },
                    isRequired: { type: 'boolean', description: 'Whether an answer is mandatory.' },
                    description: { type: 'string', description: 'Optional helper text under the question.' }
                },
                required: ['formId', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_forms_get_submissions',
            description: 'Read the responses to a form. Answers are returned keyed by QUESTION TEXT so they can be read and bound directly in an automation.',
            parameters: {
                type: 'object',
                properties: {
                    formId: { type: 'integer', description: 'Form id.' },
                    submissionId: { type: 'integer', description: 'Optional — return only this one submission (e.g. the one a forms.submitted trigger reported).' },
                    limit: { type: 'integer', description: `Max submissions (default ${DEFAULT_SUBMISSIONS}, max ${MAX_SUBMISSIONS}).` }
                },
                required: ['formId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_forms_update_settings',
            description: 'Change a form\'s settings: title, description, expiry, anonymity, whether multiple submissions are allowed, or open/close it.',
            parameters: {
                type: 'object',
                properties: {
                    formId: { type: 'integer', description: 'Form id.' },
                    title: { type: 'string', description: 'New title.' },
                    description: { type: 'string', description: 'New description.' },
                    expires: { type: 'string', description: 'ISO 8601 date-time after which the form stops accepting responses. Pass an empty string to remove the expiry.' },
                    isAnonymous: { type: 'boolean', description: 'Record submissions without the submitter\'s identity.' },
                    submitMultiple: { type: 'boolean', description: 'Allow one person to submit more than once.' },
                    state: { type: 'integer', description: 'Form state: 0 = open, 1 = closed/archived.' },
                    submissionMessage: { type: 'string', description: 'Message shown after submitting.' }
                },
                required: ['formId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_forms_delete',
            description: 'Permanently delete a form and all of its submissions. Destructive — consider closing it with nextcloud_forms_update_settings (state: 1) instead.',
            parameters: {
                type: 'object',
                properties: {
                    formId: { type: 'integer', description: 'Form id to delete.' }
                },
                required: ['formId']
            }
        }
    }
];

const HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'OCS-APIRequest': 'true',
};

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

async function handle(res, authError, what) {
    if (res.status === 401 || res.status === 403) return { error: authError };
    if (res.status === 404) {
        return {
            error: `Nextcloud Forms did not answer the ${what} call. Install/enable the "Forms" app `
                + '(these tools need Forms with its v3 API — Nextcloud 29+).',
        };
    }
    if (!res.ok) {
        const body = await readJsonSafe(res);
        const detail = typeof body === 'string' ? body.slice(0, 200) : (body?.ocs?.meta?.message || body?.message || '');
        return { error: `Nextcloud Forms ${what} failed (${res.status})${detail ? `: ${detail}` : ''}` };
    }
    const body = await readJsonSafe(res);
    return { ok: true, data: body?.ocs?.data ?? body };
}

function mapForm(f) {
    return {
        id: f.id,
        hash: f.hash,
        title: f.title,
        description: f.description || '',
        ownerId: f.ownerId,
        created: f.created ?? null,
        expires: f.expires || null,
        isAnonymous: !!f.isAnonymous,
        submitMultiple: !!f.submitMultiple,
        state: f.state ?? 0,
        submissionCount: f.submissionCount ?? null,
    };
}

function mapQuestion(q) {
    return {
        id: q.id,
        text: q.text,
        type: q.type,
        isRequired: !!q.isRequired,
        description: q.description || '',
        options: Array.isArray(q.options) ? q.options.map(o => ({ id: o.id, text: o.text })) : [],
    };
}

/**
 * Join a raw submission against the form's questions so answers come back
 * keyed by question text. Questions with no answer are omitted rather than
 * emitted as null, so `Object.keys(answers)` means "what they actually filled
 * in". A question whose text is reused twice in one form would collide, so the
 * numeric-keyed original is preserved alongside as `answersByQuestionId`.
 */
function mapSubmission(sub, questions) {
    const textById = new Map(questions.map(q => [String(q.id), q.text]));
    const answers = {};
    const answersByQuestionId = {};
    for (const a of Array.isArray(sub.answers) ? sub.answers : []) {
        const qid = String(a.questionId);
        const text = textById.get(qid);
        // Multiple-choice answers arrive as one row per selected option.
        const push = (bag, key) => {
            if (bag[key] === undefined) bag[key] = a.text;
            else if (Array.isArray(bag[key])) bag[key].push(a.text);
            else bag[key] = [bag[key], a.text];
        };
        push(answersByQuestionId, qid);
        if (text !== undefined) push(answers, text);
    }
    return {
        id: sub.id,
        formId: sub.formId,
        userId: sub.userId || null,
        timestamp: sub.timestamp ?? null,
        submittedAt: sub.timestamp ? new Date(sub.timestamp * 1000).toISOString() : null,
        answers,
        answersByQuestionId,
    };
}

async function executeNextcloudFormsTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const api = `${baseUrl}${FORMS_API}`;

    switch (toolName) {
        case 'nextcloud_forms_list': {
            const res = await ncFetch(`${api}/forms`, { headers: HEADERS });
            const out = await handle(res, authError, 'form list');
            if (out.error) return out;
            let forms = (Array.isArray(out.data) ? out.data : []).map(mapForm);
            if (args.includeShared === false) {
                // The API returns owned + shared in one list; filter locally.
                const me = ctx.uid;
                forms = forms.filter(f => !me || f.ownerId === me);
            }
            return { count: forms.length, forms };
        }

        case 'nextcloud_forms_get': {
            if (!args.formId) return { error: 'formId is required' };
            const res = await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}`, { headers: HEADERS });
            const out = await handle(res, authError, 'form fetch');
            if (out.error) return out;
            const f = out.data || {};
            return {
                form: mapForm(f),
                questions: Array.isArray(f.questions) ? f.questions.map(mapQuestion) : [],
                // The public URL is what you send to a respondent.
                shareUrl: f.hash ? `${baseUrl}/index.php/apps/forms/s/${f.hash}` : null,
            };
        }

        case 'nextcloud_forms_create': {
            if (!args.title) return { error: 'title is required' };
            // v3 creates an empty form first, then applies the properties.
            const created = await handle(
                await ncFetch(`${api}/forms`, { method: 'POST', headers: HEADERS, body: '{}' }),
                authError, 'form create',
            );
            if (created.error) return created;
            const form = created.data || {};
            if (!form.id) return { error: 'Nextcloud Forms did not return a form id' };

            const keyValuePairs = { title: args.title };
            if (args.description) keyValuePairs.description = args.description;
            const updated = await handle(
                await ncFetch(`${api}/forms/${encodeURIComponent(form.id)}`, {
                    method: 'PATCH', headers: HEADERS, body: JSON.stringify({ keyValuePairs }),
                }),
                authError, 'form update',
            );
            if (updated.error) return updated;
            return {
                success: true,
                form: mapForm({ ...form, ...keyValuePairs }),
                shareUrl: form.hash ? `${baseUrl}/index.php/apps/forms/s/${form.hash}` : null,
            };
        }

        case 'nextcloud_forms_add_question': {
            if (!args.formId) return { error: 'formId is required' };
            if (!args.text) return { error: 'text is required' };
            const type = args.type || 'short';
            const needsOptions = ['multiple', 'multiple_unique', 'dropdown'].includes(type);
            if (needsOptions && (!Array.isArray(args.options) || args.options.length === 0)) {
                return { error: `Question type "${type}" needs an "options" list.` };
            }

            const created = await handle(
                await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}/questions`, {
                    method: 'POST', headers: HEADERS, body: JSON.stringify({ type, text: args.text }),
                }),
                authError, 'question create',
            );
            if (created.error) return created;
            const question = created.data || {};
            if (!question.id) return { error: 'Nextcloud Forms did not return a question id' };

            // Properties that are not settable at create time.
            const keyValuePairs = {};
            if (args.isRequired !== undefined) keyValuePairs.isRequired = !!args.isRequired;
            if (args.description) keyValuePairs.description = args.description;
            if (Object.keys(keyValuePairs).length) {
                const patched = await handle(
                    await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}/questions/${encodeURIComponent(question.id)}`, {
                        method: 'PATCH', headers: HEADERS, body: JSON.stringify({ keyValuePairs }),
                    }),
                    authError, 'question update',
                );
                if (patched.error) return patched;
            }

            const options = [];
            for (const label of (needsOptions ? args.options : [])) {
                const opt = await handle(
                    await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}/questions/${encodeURIComponent(question.id)}/options`, {
                        method: 'POST', headers: HEADERS, body: JSON.stringify({ optionTexts: [String(label)] }),
                    }),
                    authError, 'option create',
                );
                if (opt.error) return opt;
                options.push(String(label));
            }

            return {
                success: true,
                question: mapQuestion({ ...question, ...keyValuePairs, text: args.text, type }),
                options,
            };
        }

        case 'nextcloud_forms_get_submissions': {
            if (!args.formId) return { error: 'formId is required' };
            const formRes = await handle(
                await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}`, { headers: HEADERS }),
                authError, 'form fetch',
            );
            if (formRes.error) return formRes;
            const questions = Array.isArray(formRes.data?.questions)
                ? formRes.data.questions.map(mapQuestion) : [];

            const out = await handle(
                await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}/submissions`, { headers: HEADERS }),
                authError, 'submission fetch',
            );
            if (out.error) return out;

            const raw = Array.isArray(out.data?.submissions) ? out.data.submissions
                : (Array.isArray(out.data) ? out.data : []);
            let submissions = raw.map(s => mapSubmission(s, questions));
            if (args.submissionId) {
                submissions = submissions.filter(s => String(s.id) === String(args.submissionId));
            }
            const limit = Math.min(Math.max(args.limit || DEFAULT_SUBMISSIONS, 1), MAX_SUBMISSIONS);
            const truncated = submissions.length > limit;
            submissions = submissions.slice(0, limit);

            return {
                formId: args.formId,
                formTitle: formRes.data?.title || '',
                questions: questions.map(q => q.text),
                count: submissions.length,
                truncated,
                submissions,
            };
        }

        case 'nextcloud_forms_update_settings': {
            if (!args.formId) return { error: 'formId is required' };
            const keyValuePairs = {};
            if (args.title !== undefined) keyValuePairs.title = args.title;
            if (args.description !== undefined) keyValuePairs.description = args.description;
            if (args.isAnonymous !== undefined) keyValuePairs.isAnonymous = !!args.isAnonymous;
            if (args.submitMultiple !== undefined) keyValuePairs.submitMultiple = !!args.submitMultiple;
            if (args.state !== undefined) keyValuePairs.state = Number(args.state);
            if (args.submissionMessage !== undefined) keyValuePairs.submissionMessage = args.submissionMessage;
            if (args.expires !== undefined) {
                if (args.expires === '') {
                    keyValuePairs.expires = 0; // Forms stores "no expiry" as 0
                } else {
                    const ts = Date.parse(args.expires);
                    if (Number.isNaN(ts)) return { error: `Could not parse "expires" as a date: ${args.expires}` };
                    keyValuePairs.expires = Math.floor(ts / 1000);
                }
            }
            if (!Object.keys(keyValuePairs).length) {
                return { error: 'Nothing to update — pass at least one setting.' };
            }
            const out = await handle(
                await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}`, {
                    method: 'PATCH', headers: HEADERS, body: JSON.stringify({ keyValuePairs }),
                }),
                authError, 'settings update',
            );
            if (out.error) return out;
            return { success: true, formId: args.formId, updated: Object.keys(keyValuePairs) };
        }

        case 'nextcloud_forms_delete': {
            if (!args.formId) return { error: 'formId is required' };
            const out = await handle(
                await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}`, {
                    method: 'DELETE', headers: HEADERS,
                }),
                authError, 'form delete',
            );
            if (out.error) return out;
            return { success: true, formId: args.formId };
        }

        default:
            return { error: `Unknown Nextcloud Forms tool: ${toolName}` };
    }
}

function isNextcloudFormsTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_forms_');
}

module.exports = {
    NEXTCLOUD_FORMS_TOOLS,
    executeNextcloudFormsTool,
    isNextcloudFormsTool,
    // exported for tests
    mapSubmission,
};
