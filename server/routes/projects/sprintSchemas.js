// @typecheck
'use strict';
/**
 * What the sprint routes accept (routes/projects/sprints.js). Closed bodies,
 * every refusal a sentence (core/http/schemaParts.js).
 */

const { z, worded, bodyOf } = require('../../core/http/schemaParts');

const NAME_MAX = 200;
const GOAL_MAX = 2000;
const ID_MAX = 200;
const MAX_ITEMS = 100;

const NAME_TEXT = `name is the name of the sprint, 1 to ${NAME_MAX} characters.`;
const name = worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(NAME_MAX, NAME_TEXT);

const GOAL_TEXT = `goal is text of at most ${GOAL_MAX} characters.`;
const goal = worded(GOAL_TEXT).max(GOAL_MAX, GOAL_TEXT);

const DAY_TEXT = 'a day like 2026-10-31, or null for none.';
const day = worded(DAY_TEXT).regex(/^\d{4}-\d{2}-\d{2}$/, DAY_TEXT)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), DAY_TEXT)
    .nullable();

const CAPACITY_TEXT = 'capacityPoints is the velocity the sprint should fit, a whole number of story points, or null for none.';
const capacityPoints = z.number({ invalid_type_error: CAPACITY_TEXT }).int(CAPACITY_TEXT).min(0, CAPACITY_TEXT).nullable();

const ITEMS_TEXT = `taskIds is a list of 1 to ${MAX_ITEMS} task ids.`;
const taskId = worded(ITEMS_TEXT).trim().min(1, ITEMS_TEXT).max(ID_MAX, ITEMS_TEXT);

const fields = {
    goal: goal.optional(),
    startDate: day.optional(),
    endDate: day.optional(),
    capacityPoints: capacityPoints.optional(),
};

const CreateSprintBody = bodyOf({ name, ...fields }, 'Creating a sprint');
const UpdateSprintBody = bodyOf({ name: name.optional(), ...fields }, 'Changing a sprint');
const AssignItemsBody = bodyOf({
    taskIds: z.array(taskId, { required_error: ITEMS_TEXT, invalid_type_error: ITEMS_TEXT }).min(1, ITEMS_TEXT).max(MAX_ITEMS, ITEMS_TEXT),
}, 'Putting tasks in a sprint');

module.exports = { NAME_MAX, GOAL_MAX, MAX_ITEMS, CreateSprintBody, UpdateSprintBody, AssignItemsBody };
