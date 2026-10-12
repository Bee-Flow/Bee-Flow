/**
 * Collaborative projects in the Compliance demo's processing register, in the
 * server's shapes:
 *
 *   GET    /ropa/projects            routes/compliance/projectRegistrations.js:
 *                                    { projects: [{ project_id, name, kinds, special,
 *                                      sources, registration|null }], complete }
 *   PUT    /ropa/projects/:projectId { purpose?, lawful_basis, retention_days? } → { registration }
 *   DELETE /ropa/projects/:projectId → { removed: true }
 *
 * A recorded project is also a processing activity in GET /ropa
 * (compliance/ropa/projectActivities.js), and the per-project verdict of
 * GDPR-Art30-project-personal-data (its `verdict`) follows the record.
 *
 * Two projects, so the section shows both states: the claims project holds
 * health data and has a record; the broker channel holds contact details and
 * has none yet, which is what the check warns about.
 */

export const LAWFUL_BASES = Object.freeze(['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests']);
/** personalDataSignals SPECIAL_KINDS: special-category and national-identifier data. */
const SPECIAL_KINDS = Object.freeze(['health', 'id_number']);
const REVIEW_EVERY_DAYS = 365;
const DAY_MS = 86_400_000;
export const PROJECT_CHECK_ID = 'GDPR-Art30-project-personal-data';

/** projectActivities KIND_LABEL: the register's words for a signal kind. */
const KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
    name: 'Names', email: 'E-mail addresses', phone: 'Phone numbers', address: 'Addresses',
    id_number: 'Identity numbers', financial: 'Bank and payment details', birth: 'Dates of birth',
    health: 'Health data', online_id: 'Online identifiers', supplier: 'Supplier contacts',
    personal: 'Personal data (kind not determined)',
});

export interface ProjectSignal { project_id: string; name: string; kinds: string[]; sources: string[] }

export interface ProjectRegistration {
    subject_kind: 'project';
    subject_id: string;
    purpose: string | null;
    lawful_basis: string | null;
    retention_days: number | null;
    confirmed_by: string | null;
    confirmed_at: string;
}

export interface RopaProjectsState { projects: ProjectSignal[]; registrations: ProjectRegistration[] }

type Body = { purpose?: unknown; lawful_basis?: unknown; retention_days?: unknown } | null;
type Ctx = { state: { ropaProjects: RopaProjectsState }; params: { projectId: string }; body: Body };

/** The seed: the projects signals show, and the one record an admin keeps. */
export function ropaProjectsSeed(now: number = Date.now()): RopaProjectsState {
    return {
        projects: [
            { project_id: 'prj_schadedossiers', name: 'Schadedossiers 2026', kinds: ['address', 'health', 'name'], sources: ['files', 'threads'] },
            { project_id: 'prj_makelaars', name: 'Makelaarsoverleg', kinds: ['email', 'name', 'phone'], sources: ['comments', 'threads'] },
        ],
        registrations: [{
            subject_kind: 'project', subject_id: 'prj_schadedossiers',
            purpose: 'Handling claim files with the insurers we work for, including medical reports for disability claims.',
            lawful_basis: 'contract', retention_days: 730,
            confirmed_by: 'u_marieke', confirmed_at: new Date(now - 40 * DAY_MS).toISOString(),
        }],
    };
}

const special = (kinds: readonly string[]) => kinds.some(k => SPECIAL_KINDS.includes(k));
const shortRef = (id: string) => `project:${id.slice(0, 8)}`;
const registrationOf = (s: RopaProjectsState, id: string) => s.registrations.find(r => r.subject_id === id) || null;

/** GET /ropa/projects: special first, then the ones without a record, then by name. */
export function ropaProjectsBody(s: RopaProjectsState) {
    const projects = s.projects.map(p => ({
        project_id: p.project_id, name: p.name, kinds: [...p.kinds], special: special(p.kinds), sources: [...p.sources],
        registration: registrationOf(s, p.project_id),
    })).sort((a, b) => (Number(b.special) - Number(a.special))
        || (Number(!!a.registration) - Number(!!b.registration))
        || a.name.localeCompare(b.name));
    return { projects, complete: true };
}

/** compliance/ropa/projectActivities: one activity per project with a basis or a retention. */
export function projectActivities(s: RopaProjectsState) {
    return s.registrations.filter(r => r.lawful_basis || Number(r.retention_days) > 0).flatMap((r) => {
        const p = s.projects.find(x => x.project_id === r.subject_id);
        if (!p) return [];
        const days = Number(r.retention_days);
        return [{
            activity_id: `project:${p.project_id}`,
            name: p.name,
            purpose: r.purpose || 'Collaboration in a project workspace: chats, documents, notebooks and files shared by its members.',
            data_categories: p.kinds.length ? p.kinds.map(k => KIND_LABEL[k] || k) : ['Whatever members keep in the project'],
            data_subjects: ['People named in the project’s chats, documents, notebooks and files', 'The project’s members'],
            recipients: 'The project’s members (owner, editors, viewers)',
            transfers: [],
            retention: Number.isFinite(days) && days > 0
                ? `${days} days of inactivity, checked by GDPR-Art5-1-e-project-retention.`
                : 'No retention recorded for this project.',
            security_measures: [
                'Access by project membership (owner, editor, viewer)',
                'Team chats encrypted with the project key',
                'Privacy Shield on every AI call made in the project',
            ],
            ai_act: null,
            legal_basis: r.lawful_basis || null,
            source: { kind: 'project', id: p.project_id },
            confirmed_at: r.confirmed_at,
        }];
    });
}

/** The check's subjects: one per project with a signal (`project:<id>`, labelled by its short ref). */
export function projectSubjects(s: RopaProjectsState) {
    return s.projects.map(p => ({ id: `project:${p.project_id}`, label: shortRef(p.project_id), project: p }));
}

/** checks/gdpr/art30-project-personal-data verdict for one project. */
export function projectVerdict(s: RopaProjectsState, project: ProjectSignal, now: number = Date.now()) {
    const registration = registrationOf(s, project.project_id);
    const isSpecial = special(project.kinds);
    const confirmed = registration ? Date.parse(registration.confirmed_at) : NaN;
    const ageDays = Number.isFinite(confirmed) ? Math.floor((now - confirmed) / DAY_MS) : null;
    const evidence = {
        project_id: project.project_id, kinds: [...project.kinds], sources: [...project.sources],
        special_categories: isSpecial, registered: !!registration, lawful_basis: registration?.lawful_basis || null,
        confirmed_days_ago: ageDays, review_every_days: REVIEW_EVERY_DAYS,
    };
    const ref = shortRef(project.project_id);
    const what = isSpecial ? 'special-category or identification data' : 'personal data';
    if (!registration) {
        return {
            status: isSpecial ? 'fail' : 'warn', evidence,
            details: `${ref} holds ${what} (${project.kinds.join(', ')}) and has no processing record. Record its purpose and lawful basis in the processing register.`,
        };
    }
    if (!registration.lawful_basis) return { status: 'warn', evidence, details: `${ref} has a processing record without a lawful basis.` };
    if (ageDays != null && ageDays > REVIEW_EVERY_DAYS) {
        return { status: 'warn', evidence, details: `${ref}'s processing record was last confirmed ${ageDays} days ago; your interval is ${REVIEW_EVERY_DAYS}. Re-confirm it.` };
    }
    return { status: 'pass', evidence, details: `${ref} holds ${what} under a current processing record (${registration.lawful_basis}).` };
}

/** A demo 4xx with the body the server's HttpError sends. */
const refuse = (status: number, code: string, message: string) => new Response(
    JSON.stringify({ error: message, code }),
    { status, headers: { 'Content-Type': 'application/json' } },
);

/**
 * The three routes. `onChange(state, projectId)` runs after a write, so the
 * caller can re-judge the project's check row and re-seal the evidence chain
 * (the server re-runs the check and appends an evidence row).
 */
export function ropaProjectRoutes(onChange: (state: Ctx['state'], projectId: string) => void) {
    return {
        'GET /api/compliance/ropa/projects': ({ state }: Ctx) => ropaProjectsBody(state.ropaProjects),
        'PUT /api/compliance/ropa/projects/:projectId': ({ state, params, body }: Ctx) => {
            const s = state.ropaProjects;
            if (!s.projects.some(p => p.project_id === params.projectId)) return refuse(404, 'not_found', 'There is no such project in your organisation.');
            const basis = body?.lawful_basis;
            if (typeof basis !== 'string' || !LAWFUL_BASES.includes(basis)) {
                return refuse(400, 'validation_failed', `lawful_basis must be one of ${LAWFUL_BASES.join(', ')}.`);
            }
            const days = body?.retention_days;
            if (days != null && (!Number.isInteger(days) || (days as number) < 30 || (days as number) > 3650)) {
                return refuse(400, 'validation_failed', 'retention_days is a whole number of days, 30 to 3650.');
            }
            const purpose = typeof body?.purpose === 'string' && body.purpose.trim() ? body.purpose.trim().slice(0, 1000) : null;
            const registration: ProjectRegistration = {
                subject_kind: 'project', subject_id: params.projectId, purpose, lawful_basis: basis,
                retention_days: (days as number | null | undefined) ?? null, confirmed_by: 'u_marieke', confirmed_at: new Date().toISOString(),
            };
            state.ropaProjects = { ...s, registrations: [registration, ...s.registrations.filter(r => r.subject_id !== params.projectId)] };
            onChange(state, params.projectId);
            return { registration };
        },
        'DELETE /api/compliance/ropa/projects/:projectId': ({ state, params }: Ctx) => {
            const s = state.ropaProjects;
            if (!registrationOf(s, params.projectId)) return refuse(404, 'not_found', 'This project has no processing record.');
            state.ropaProjects = { ...s, registrations: s.registrations.filter(r => r.subject_id !== params.projectId) };
            onChange(state, params.projectId);
            return { removed: true };
        },
    };
}
