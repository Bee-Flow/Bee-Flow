// Whether this person can use Projects at all: the plan (the `projects`
// capability, which also answers for the module being removed) and the
// operator's switch (`featureFlags.projects`). The sidebar shows Projects on
// the same answer; settings that only act inside projects (the AI that joins
// team chats by itself, editing together) are shown on it too, so nobody is
// offered a switch for something they cannot use.

import { useLicenseContext } from '../components/licensing/LicenseContext';

export interface ProjectsUserLike {
    featureFlags?: { projects?: boolean } | null;
}

export function projectsAvailable(user: ProjectsUserLike | null | undefined, hasFeature: (name: string) => boolean): boolean {
    return user?.featureFlags?.projects !== false && hasFeature('projects');
}

export default function useProjectsAvailable(user: ProjectsUserLike | null | undefined): boolean {
    const { hasFeature } = useLicenseContext();
    return projectsAvailable(user, hasFeature);
}
