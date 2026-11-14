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
import { useMemo } from 'react';
import { createJsonResource } from '@/api/client';
import { useAdminOrgScope } from '@/api/adminOrgScope';
import { apiUrl } from '@/api/typedRequest';

const resource = createJsonResource('', { contentType: 'body', errorText: (status: number) => `HTTP ${status}` });
const request = (url: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}) => resource(url, { method, body });

/** The calls for one organisation (null: the caller's own; a platform admin's choice is sent as ?orgId=). */
function academyApiFor(orgId: string | null) {
    const query = orgId ? { orgId } : undefined;
    const course = (courseId: string) => ({ params: { courseId }, query });
    return {
        // → { courses: [{ courseId, title, status, updatedAt }] }
        listCourses: () => request(apiUrl('GET /ai/learning/admin/courses', { query })),
        // → { course: CourseDoc, lessons: LessonDoc[] } (drafts)
        getCourse: (courseId: string) => request(apiUrl('GET /ai/learning/admin/courses/{courseId}', course(courseId))),
        // → { course } — id always minted server-side
        createCourse: (body: unknown) => request(apiUrl('POST /ai/learning/admin/courses', { query }), { method: 'POST', body }),
        // → { course }
        saveCourse: (courseId: string, body: unknown) => request(apiUrl('PUT /ai/learning/admin/courses/{courseId}', course(courseId)), { method: 'PUT', body }),
        // → { success: true } — also deletes all the course's lessons
        deleteCourse: (courseId: string) => request(apiUrl('DELETE /ai/learning/admin/courses/{courseId}', course(courseId)), { method: 'DELETE' }),
        // → { lesson } — pass 'new' as lessonId to create (id minted server-side)
        saveLesson: (lessonId: string, body: unknown) => request(apiUrl('PUT /ai/learning/admin/lessons/{lessonId}', { params: { lessonId }, query }), { method: 'PUT', body }),
        // → { success: true, course }
        publishCourse: (courseId: string) => request(apiUrl('POST /ai/learning/admin/courses/{courseId}/publish', course(courseId)), { method: 'POST' }),
        // → { success: true }
        unpublishCourse: (courseId: string) => request(apiUrl('POST /ai/learning/admin/courses/{courseId}/unpublish', course(courseId)), { method: 'POST' }),
    };
}

/** The calls for the organisation an AdminOrgScopeProvider names, else the caller's own. */
export function useAcademyApi() {
    const orgId = useAdminOrgScope();
    return useMemo(() => academyApiFor(orgId), [orgId]);
}
