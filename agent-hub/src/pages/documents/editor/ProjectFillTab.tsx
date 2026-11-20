/**
 * "Fill in & preview" for a document in a project: the shared form
 * (components/documents/fill/ProjectFillPanel), told who is reading.
 */
import ProjectFillPanel from '@/components/documents/fill/ProjectFillPanel';
import { useSessionUser } from '../documentQueries';

export default function ProjectFillTab({ documentId, projectId }: { documentId: string; projectId: string }) {
    const me = useSessionUser(true).data?.id || null;
    return <ProjectFillPanel documentId={documentId} projectId={projectId} meId={me} />;
}
