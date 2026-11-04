/**
 * One saved action test, checked against the action it tests. Pure.
 *
 * Runs at save time (app_save_test) AND at run time (app_run_tests) against the CURRENT action:
 * a test whose mock or expectation names a step that is gone is stale, and reports status
 * error with a fix hint instead of a misleading pass or fail.
 *
 *   name     1-80 characters, no line break
 *   scope    as app_run_action's (readScope, at most 64 KB)
 *   mock     keys on mockable walker paths of the action (checkMock), at most 50, 64 KB
 *   expect   1-50 items { path ≤300, op, value ≤4 KB }; a parseable path with a known root
 *   whole    at most 128 KB as JSON
 */

import { readScope } from '../mcpRunActionPolicy.mts';
import type { Obj, RunScope } from '../mcpRunActionPolicy.mts';
import { stepPaths } from '../sequenceWalk.mts';
import { checkMock, mockablePaths } from './mockStep.mts';
import { expectationOps, isUnaryOp, pathProblem } from './expectations.mts';
import type { Expectation } from './expectations.mts';

export const MAX_TEST_NAME = 80;
export const MAX_EXPECTATIONS = 50;
export const MAX_EXPECT_PATH = 300;
export const MAX_EXPECT_VALUE_BYTES = 4 * 1024;
export const MAX_SPEC_BYTES = 128 * 1024;

export type TestSpec = { scope: RunScope; mock: Obj; expect: Expectation[] };
export type CheckedTest = { name: string; spec: TestSpec; mockPaths: string[]; unmockedAiPaths: string[]; hints: string[] };
export type SpecProblem = { error: string; _fixHint?: string };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = (v: unknown): number => (JSON.stringify(v) ?? '').length;

/** A test name, trimmed, or the reason it is not one. */
export function readTestName(raw: unknown): { name: string } | SpecProblem {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) return { error: 'A test needs a name (1-80 characters).' };
    if (name.length > MAX_TEST_NAME) return { error: `The test name is ${name.length} characters; at most ${MAX_TEST_NAME}.` };
    if (/[\r\n]/.test(name)) return { error: 'The test name must be one line.' };
    return { name };
}

function readExpectation(raw: unknown, i: number, known: Set<string>, ops: string[]): Expectation | SpecProblem {
    const where = `expect[${i}]`;
    if (!isObject(raw)) return { error: `${where} must be an object { path, op, value }.` };
    if (typeof raw.path !== 'string' || raw.path.length > MAX_EXPECT_PATH) return { error: `${where}.path must be a path of at most ${MAX_EXPECT_PATH} characters.` };
    const problem = pathProblem(raw.path, known);
    if (problem) return { error: `${where}: ${problem}.`, _fixHint: `Step paths of this action: ${[...known].slice(0, 30).join(', ') || '(none)'}.` };
    const op = typeof raw.op === 'string' ? raw.op : '';
    if (!ops.includes(op)) return { error: `${where}.op "${String(raw.op).slice(0, 40)}" is not an op.`, _fixHint: `Ops: ${ops.join(', ')}.` };
    if (!isUnaryOp(op) && raw.value === undefined) return { error: `${where} (${op}) needs a value.` };
    if (bytes(raw.value ?? null) > MAX_EXPECT_VALUE_BYTES) return { error: `${where}.value is larger than ${MAX_EXPECT_VALUE_BYTES / 1024} KB.` };
    return { path: raw.path.trim(), op, ...(isUnaryOp(op) ? {} : { value: raw.value }) };
}

function readExpectations(raw: unknown, action: unknown): Expectation[] | SpecProblem {
    if (!Array.isArray(raw) || raw.length === 0) return { error: 'expect must be a list of 1-50 { path, op, value } items.' };
    if (raw.length > MAX_EXPECTATIONS) return { error: `expect has ${raw.length} items; at most ${MAX_EXPECTATIONS}.` };
    const known = new Set(stepPaths(action).map((p) => p.path));
    const ops = expectationOps();
    const out: Expectation[] = [];
    for (let i = 0; i < raw.length; i += 1) {
        const e = readExpectation(raw[i], i, known, ops);
        if ('error' in e) return e;
        out.push(e);
    }
    return out;
}

/**
 * The test as stored, checked against `action` (null = the action no longer exists).
 * `args` carries { scope?, mock?, expect } in the app_save_test shape.
 */
export function normaliseTestSpec(args: Obj, action: unknown, actionId: string): CheckedTest | SpecProblem {
    const named = readTestName(args.name);
    if ('error' in named) return named;
    if (!isObject(action)) return { error: `The app has no action "${actionId}".`, _fixHint: 'Remove the test (app_save_test with remove: true) or point it at an existing action.' };
    const scope = readScope(args.scope);
    if ('error' in scope) return scope;
    const mock = checkMock(args.mock, action);
    if ('error' in mock) return mock;
    const expect = readExpectations(args.expect, action);
    if ('error' in expect) return expect;
    const spec: TestSpec = { scope, mock: mock.mock, expect };
    if (bytes(spec) > MAX_SPEC_BYTES) return { error: `The test is larger than ${MAX_SPEC_BYTES / 1024} KB.` };
    const mockPaths = Object.keys(mock.mock);
    const unmocked = mockablePaths(action).filter((p) => !Object.hasOwn(mock.mock, p.path));
    const hints = unmocked.slice(0, 10).map((p) => `${p.path} (${p.kind}) is not mocked: running this test calls the model or reads a knowledge base or dataset, and counts against the rate limit.`);
    return { name: named.name, spec, mockPaths, unmockedAiPaths: unmocked.map((p) => p.path), hints };
}
