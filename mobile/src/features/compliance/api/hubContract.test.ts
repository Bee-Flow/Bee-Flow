/**
 * The server fields hubReaders.ts and members.ts rely on, pinned in the
 * server's own source (read as TEXT — the route files import the database
 * pool). A red line means the server moved: follow it in the reader.
 */

import fs from 'node:fs';
import path from 'node:path';

const SERVER = path.resolve(__dirname, '../../../../../server');
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

const PINS: readonly [string, readonly string[]][] = [
    ['routes/compliance/counts.js', ['interval_hours', 'due_soon', 'next_stage', 'next_deadline_at', 'todo:', "key: 'evidence'", 'chain_ok', "key: 'setup_step'"]],
    ['compliance/attention.js', ['subject_count', 'detail']],
    ['compliance/deadlines.js', ['started_at', 'pct', 'empty_kinds', 'complianceSectionPath']],
    ['routes/compliance/checks.js', ['finding_state', 'remediationLink', 'project_names']],
    ['routes/compliance/frameworks.js', ['phases', 'sources', 'legal_review', 'catalogue', 'checks_count', 'in_force_from']],
    ['routes/compliance/orgUsers.js', ['email', 'phone']],
];

describe('the hub server contract', () => {
    it.each(PINS)('%s still serves the fields the readers read', (file, needles) => {
        const src = read(file);
        for (const needle of needles) expect([file, src.includes(needle)]).toEqual([file, true]);
    });
});
