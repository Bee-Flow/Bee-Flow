/** Shapes shared by the Learning Center catalog, progress and player modules. */
import type { PermissionUser } from '../../hooks/usePermissionCheck';

/** The slice of the signed-in user the Learning Center reads. */
export interface LessonUser extends PermissionUser {
    id?: string;
    orgRole?: string | null;
    organizationId?: string | number | null;
    orgId?: string | number | null;
}

/** License feature probe; undefined where no license provider exists (feature gates then pass). */
export type HasFeature = (feature: string) => boolean;

/** Who may see a lesson or criterion: `permission` is any-of, `permissionsAll` all-of, `feature` all-of. */
export interface LessonGate {
    permission?: string | string[];
    permissionsAll?: string[];
    feature?: string | string[];
}

export interface StepAdvanceOn {
    input?: { minLength: number };
    targetGone?: boolean;
    event?: string;
    predicate?: (event: Event) => boolean;
    timeoutMs?: number;
}

export interface StepChoice {
    id: string;
    labelKey?: string;
    labelFallback?: string;
    correct?: boolean;
    feedbackKey?: string;
    feedbackFallback?: string;
}

export interface SimPair {
    id: string;
    left: string;
    right: string;
    leftKey?: string;
    rightKey?: string;
    noteKey?: string;
    noteFallback?: string;
}

export interface SimItem {
    id: string;
    label: string;
    labelKey?: string;
    desc?: string;
    descKey?: string;
    hint?: string;
    hintKey?: string;
}

export interface SimScenario {
    id: string;
    briefKey?: string;
    briefFallback?: string;
    trigger: {
        options: SimItem[];
        correct: string;
        feedback?: Partial<Record<string, string>>;
    };
    steps: {
        palette: SimItem[];
        solution: string[];
        feedback?: Partial<Record<string, string>>;
    };
}

export interface SimConfig {
    kind?: string;
    pairs?: SimPair[];
    items?: SimItem[];
    solution?: string[];
    scenarios?: SimScenario[];
    feedbackKey?: string;
    feedbackFallback?: string;
}

/** Where a review-session step was cloned from. */
export interface StepOrigin {
    lessonId: string | null;
    stepId: string | null;
}

/** One step of a lesson: a tour step (the default) or a slide / quiz / exercise / sim / action / video step. */
export interface LessonStep {
    id: string;
    type?: string;
    icon?: string;
    titleKey?: string;
    titleFallback?: string;
    bodyKey?: string;
    bodyFallback?: string;
    bodyMdKey?: string;
    bodyMdFallback?: string;
    target?: string;
    placement?: string;
    navigateTo?: string;
    optional?: boolean;
    requiresStudio?: boolean;
    requiresAgentCreated?: boolean;
    ensureSidebarOpen?: boolean;
    timeoutMs?: number;
    interactive?: boolean;
    advanceOn?: StepAdvanceOn;
    actionHintKey?: string;
    actionHintFallback?: string;
    questionKey?: string;
    questionFallback?: string;
    explanationKey?: string;
    explanationFallback?: string;
    choices?: StepChoice[];
    multi?: boolean;
    serverGraded?: boolean;
    instructionKey?: string;
    instructionFallback?: string;
    placeholderKey?: string;
    placeholderFallback?: string;
    starter?: string;
    exerciseId?: string;
    passScore?: number;
    maxAttempts?: number;
    checkId?: string;
    launch?: { navigateTo?: string; labelKey?: string; labelFallback?: string };
    videoId?: string;
    sim?: SimConfig;
    practice?: { practiceId: string | null };
    generated?: boolean;
    origin?: StepOrigin;
}

export interface LessonDoc {
    id: string;
    group: string;
    icon: string;
    estMinutes: number;
    titleKey?: string;
    titleFallback: string;
    descKey?: string;
    descFallback?: string;
    gate: LessonGate;
    steps: LessonStep[];
    source?: string;
    kind?: string;
    ephemeral?: boolean;
}

/** Per-step saved state in the learning progress blob. */
export interface StepState {
    status?: string;
    attempts?: number;
    wrongChoiceIds?: string[];
    choiceIds?: string[];
    correctChoiceIds?: string[];
    answeredAt?: string;
    reviewedAt?: string;
    score?: number | null;
    submission?: string;
    feedback?: string;
    strengths?: string[];
    improvements?: string[];
    passes?: Record<string, boolean>;
    watchedAt?: string;
}

export interface LessonProgressEntry {
    completedAt?: string;
    masteredAt?: string;
    steps?: Record<string, StepState>;
}

/** { [lessonId]: entry } — the shape of the learningProgress blob. */
export type ProgressMap = Record<string, LessonProgressEntry>;

export interface CourseBadge {
    id: string;
    icon: string;
    titleKey?: string;
    titleFallback?: string;
    descFallback?: string;
}

export interface Course {
    id: string;
    pathId?: string;
    titleKey?: string;
    titleFallback: string;
    descKey?: string;
    descFallback?: string;
    icon: string;
    level: string;
    track: string | null;
    lessonIds: string[];
    prereqCourseIds: string[];
    badge: CourseBadge | null;
    source?: string;
}

export interface CertificateRule {
    type: string;
    n: number;
}

export interface Certificate {
    id: string;
    titleKey?: string;
    titleFallback: string;
    level: string | null;
    icon: string;
    track?: string | null;
    rule?: CertificateRule | null;
}

export interface Track {
    id: string;
    titleKey: string;
    titleFallback: string;
}

/** Structure the server owns, from GET /ai/learning/catalog (courses overlay the bundled presentation). */
export interface ServerCourse {
    id: string;
    title?: string;
    desc?: string;
    icon?: string;
    level?: string;
    track?: string | null;
    lessonIds?: string[];
    lessons?: ServerLessonDoc[];
    prereqCourseIds?: string[];
    badge?: { id?: string; icon?: string; title?: string; desc?: string } | null;
    source?: string;
}

export interface ServerCertificate {
    id: string;
    title?: string;
    level?: string | null;
    track?: string | null;
    rule?: CertificateRule | null;
}

export interface ServerLessonDoc {
    id: string;
    icon?: string;
    estMinutes?: number;
    title?: string;
    desc?: string;
    steps?: LessonStep[];
}

export interface ServerCatalog {
    courses: ServerCourse[];
    certificates?: ServerCertificate[];
    lessons?: ServerLessonDoc[];
    practiceLessonIds?: string[];
}

export interface LearningPath {
    id: string;
    icon: string;
    titleKey: string;
    titleFallback: string;
    descKey: string;
    descFallback: string;
    courseOrder: string[];
}

/** The slice of a step that stepTypes helpers read. */
export interface StepLike {
    type?: string;
    optional?: boolean;
}

export interface PracticeItem {
    id: string;
    lessonId?: string;
    question: string;
    choices?: { id: string; label: string }[];
}

export interface SurfaceGate {
    feat: string[];
    permView: string[];
    permWrite: string[];
}

export interface TourAnchor {
    selector: string;
    owner: string;
    reveal: { sidebar?: boolean; designerSection?: string };
    ephemeral?: boolean;
}

export interface FlowAttempt {
    triggerId?: string | null;
    stepIds?: string[];
}
