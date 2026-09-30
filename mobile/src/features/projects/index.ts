/**
 * The projects feature's public surface: the list, one project, and the list
 * query (and its invalidation) the chat details screen uses to file a
 * conversation. Import from '@/features/projects'.
 */

export { ProjectDetailScreen } from './screens/ProjectDetailScreen';
export { ProjectsScreen } from './screens/ProjectsScreen';

export { invalidateProjectList, useProjects } from './hooks/queries';
export type { Project } from './model/types';
