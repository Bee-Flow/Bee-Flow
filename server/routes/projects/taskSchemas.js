// @typecheck
'use strict';
/**
 * What the task routes accept (routes/projects/tasks.js). Closed bodies, every
 * refusal a sentence (core/http/schemaParts.js).
 */

const { z, worded, bodyOf, closedObject, choice } = require('../../core/http/schemaParts');

const closedObjectOf = (shape) => closedObject(shape, 'A task');

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20000;
const ID_MAX = 200;
const MAX_ASSIGNEES = 50;
const MAX_LINKS = 25;
const MAX_LABELS = 20;
const LABEL_MAX = 40;
const MAX_CHECKLIST = 50;
const CHECK_TEXT_MAX = 200;
const MAX_BATCH = 50;

const TITLE_TEXT = `title is the name of the task, 1 to ${TITLE_MAX} characters.`;
const title = worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).max(TITLE_MAX, TITLE_TEXT);

const DESCRIPTION_TEXT = `description is text of at most ${DESCRIPTION_MAX} characters.`;
const description = worded(DESCRIPTION_TEXT).max(DESCRIPTION_MAX, DESCRIPTION_TEXT);

const status = choice(['todo', 'doing', 'done'], 'status is todo, doing or done.');

const ASSIGNEES_TEXT = `assigneeIds is a list of at most ${MAX_ASSIGNEES} member ids.`;
const assigneeIds = z.array(worded(ASSIGNEES_TEXT).trim().min(1, ASSIGNEES_TEXT).max(ID_MAX, ASSIGNEES_TEXT), {
    invalid_type_error: ASSIGNEES_TEXT,
}).max(MAX_ASSIGNEES, ASSIGNEES_TEXT);

const DUE_TEXT = 'dueDate is a day like 2026-10-31, or null for none.';
const dueDate = worded(DUE_TEXT).regex(/^\d{4}-\d{2}-\d{2}$/, DUE_TEXT)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), DUE_TEXT)
    .nullable();

const LINKS_TEXT = `links is a list of at most ${MAX_LINKS} objects like {"kind":"document","id":"..."}; kind is document, notebook, meeting, chat, thread or task (a thread also needs chatId).`;
const linkId = worded(LINKS_TEXT).trim().min(1, LINKS_TEXT).max(ID_MAX, LINKS_TEXT);
const link = z.object({
    kind: choice(['document', 'notebook', 'meeting', 'chat', 'thread', 'task'], LINKS_TEXT),
    id: linkId,
    chatId: linkId.optional(),
    relation: choice(['depends_on'], 'relation is depends_on for a task link.').optional(),
}, { invalid_type_error: LINKS_TEXT }).strict()
    .refine((l) => l.kind !== 'thread' || !!l.chatId, LINKS_TEXT)
    .refine((l) => !l.relation || l.kind === 'task', 'Only a task link can have a dependency relation.');
const links = z.array(link, { invalid_type_error: LINKS_TEXT }).max(MAX_LINKS, LINKS_TEXT);

const priority = choice(['low', 'normal', 'high', 'urgent'], 'priority is low, normal, high or urgent.');
const itemType = choice(['epic', 'story', 'user-story', 'task'], 'itemType is epic, story, user-story or task.');
const parentTaskId = worded('parentTaskId is a task id or null.').trim().min(1, 'parentTaskId is a task id or null.').max(ID_MAX, 'parentTaskId is a task id or null.').nullable();
const storyPoints = z.number({ invalid_type_error: 'storyPoints is null or a Fibonacci estimate.' }).int().refine(v => [1, 2, 3, 5, 8, 13, 21].includes(v), 'storyPoints is null or a Fibonacci estimate.').nullable();

const LABELS_TEXT = `labels is a list of at most ${MAX_LABELS} names of 1 to ${LABEL_MAX} characters.`;
const labels = z.array(worded(LABELS_TEXT).trim().min(1, LABELS_TEXT).max(LABEL_MAX, LABELS_TEXT), { invalid_type_error: LABELS_TEXT }).max(MAX_LABELS, LABELS_TEXT);

const CHECKLIST_TEXT = `checklist is a list of at most ${MAX_CHECKLIST} items like {"id":"...","text":"...","done":false}, the text at most ${CHECK_TEXT_MAX} characters.`;
const checkItem = z.object({
    id: worded(CHECKLIST_TEXT).trim().min(1, CHECKLIST_TEXT).max(64, CHECKLIST_TEXT),
    text: worded(CHECKLIST_TEXT).trim().min(1, CHECKLIST_TEXT).max(CHECK_TEXT_MAX, CHECKLIST_TEXT),
    done: z.boolean({ invalid_type_error: CHECKLIST_TEXT }),
}, { invalid_type_error: CHECKLIST_TEXT }).strict();
const checklist = z.array(checkItem, { invalid_type_error: CHECKLIST_TEXT }).max(MAX_CHECKLIST, CHECKLIST_TEXT);

const SOURCE_TEXT = 'source is {"kind":"meeting","id":"...","itemId":"..."}: the meeting and the action item the task came from.';
const sourceId = worded(SOURCE_TEXT).trim().min(1, SOURCE_TEXT).max(ID_MAX, SOURCE_TEXT);
const source = z.object({ kind: z.literal('meeting', { errorMap: () => ({ message: SOURCE_TEXT }) }), id: sourceId, itemId: sourceId }, { invalid_type_error: SOURCE_TEXT }).strict();

const BEFORE_TEXT = 'beforeId is the id of the task that should come right after this one in its column, or null for the end.';
const beforeId = worded(BEFORE_TEXT).trim().min(1, BEFORE_TEXT).max(ID_MAX, BEFORE_TEXT).nullable();

const fields = {
    description: description.optional(),
    status: status.optional(),
    priority: priority.optional(),
    itemType: itemType.optional(),
    parentTaskId: parentTaskId.optional(),
    storyPoints: storyPoints.optional(),
    labels: labels.optional(),
    checklist: checklist.optional(),
    assigneeIds: assigneeIds.optional(),
    links: links.optional(),
    startDate: dueDate.optional(),
    dueDate: dueDate.optional(),
};

const CreateTaskBody = bodyOf({
    title,
    ...fields,
    source: source.optional(),
}, 'Creating a task');

const BATCH_TEXT = `items is a list of 1 to ${MAX_BATCH} tasks.`;
const BatchTasksBody = bodyOf({
    items: z.array(closedObjectOf({ title, ...fields, source: source.optional() }), { required_error: BATCH_TEXT, invalid_type_error: BATCH_TEXT })
        .min(1, BATCH_TEXT).max(MAX_BATCH, BATCH_TEXT),
}, 'Creating tasks');

const UpdateTaskBody = bodyOf({
    title: title.optional(),
    ...fields,
    beforeId: beforeId.optional(),
}, 'Changing a task');

const POKER_QUEUE_TEXT = 'taskIds is a list of 1 to 50 task ids to estimate in order; the first is voted on now, the rest are queued.';
const PokerStartBody = bodyOf({
    taskId: sourceId.optional(),
    taskIds: z.array(sourceId, { invalid_type_error: POKER_QUEUE_TEXT }).min(1, POKER_QUEUE_TEXT).max(50, POKER_QUEUE_TEXT).optional(),
}, 'Starting planning poker')
    .refine((b) => b.taskId || (b.taskIds && b.taskIds.length), { message: `Starting planning poker takes taskId or taskIds. ${POKER_QUEUE_TEXT}` });
const PokerSessionBody = bodyOf({ sessionId: sourceId }, 'Changing a planning poker session');
const PokerVoteBody = bodyOf({
    sessionId: sourceId,
    vote: choice(['1', '2', '3', '5', '8', '13', '21', '?'], 'vote is a Fibonacci card or ?.')
}, 'Voting in planning poker');
const PokerFinishBody = bodyOf({
    sessionId: sourceId,
    storyPoints: z.number({ invalid_type_error: 'storyPoints is a Fibonacci estimate.' }).int().refine(v => [1, 2, 3, 5, 8, 13, 21].includes(v), 'storyPoints is a Fibonacci estimate.')
}, 'Finishing planning poker');

module.exports = { TITLE_MAX, DESCRIPTION_MAX, MAX_ASSIGNEES, MAX_LINKS, MAX_BATCH, CreateTaskBody, BatchTasksBody, UpdateTaskBody,
    PokerStartBody, PokerSessionBody, PokerVoteBody, PokerFinishBody };
