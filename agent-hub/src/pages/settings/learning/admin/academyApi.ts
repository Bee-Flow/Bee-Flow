/**
 * Academy Custom Courses — admin API layer (pattern: ProductWebsite/cmsApi.js).
 *
 * Thin authFetch wrappers over /ai/learning/admin (server-side the routes are
 * org-admin gated AND behind the `learning_custom_content` beta capability).
 * Every call resolves to the parsed JSON body and throws an Error carrying the
 * server's error message (when present) on any non-ok response, so callers can
 * surface validation messages like "Quiz step 2 needs a correct choice" inline.
 *
 * Note on creating lessons: PUT /lessons/new mints a fresh org lesson id —
 * the saved lesson is NOT attached to any course until a follow-up
 * saveCourse() whose lessonIds includes the returned lesson.id.
 */
import { createJsonResource } from '@/api/client';
import { API_BASE } from '@/utils/helpers';

const root = `${API_BASE}/ai/learning/admin`;

const resource = createJsonResource('', { contentType: 'body', errorText: (status: number) => `HTTP ${status}` });
const request = (url: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}) => resource(url, { method, body });

export const academyApi = {
    // → { courses: [{ courseId, title, status, updatedAt }] }
    listCourses: () => request(`${root}/courses`),
    // → { course: CourseDoc, lessons: LessonDoc[] } (drafts)
    getCourse: (courseId: string) => request(`${root}/courses/${encodeURIComponent(courseId)}`),
    // → { course } — id always minted server-side
    createCourse: (course: unknown) => request(`${root}/courses`, { method: 'POST', body: course }),
    // → { course }
    saveCourse: (courseId: string, course: unknown) => request(`${root}/courses/${encodeURIComponent(courseId)}`, { method: 'PUT', body: course }),
    // → { success: true } — also deletes all the course's lessons
    deleteCourse: (courseId: string) => request(`${root}/courses/${encodeURIComponent(courseId)}`, { method: 'DELETE' }),
    // → { lesson } — pass 'new' as lessonId to create (id minted server-side)
    saveLesson: (lessonId: string, lesson: unknown) => request(`${root}/lessons/${encodeURIComponent(lessonId)}`, { method: 'PUT', body: lesson }),
    // → { success: true, course }
    publishCourse: (courseId: string) => request(`${root}/courses/${encodeURIComponent(courseId)}/publish`, { method: 'POST' }),
    // → { success: true }
    unpublishCourse: (courseId: string) => request(`${root}/courses/${encodeURIComponent(courseId)}/unpublish`, { method: 'POST' }),
};
