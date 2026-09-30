/**
 * Notebooks: sources you gather and a conversation with them. The Library
 * chat surface lives here too, and templates borrow it. Import from
 * '@/features/notebooks'.
 */

export { NotebookScreen } from './screens/NotebookScreen';
export { NotebooksScreen } from './screens/NotebooksScreen';

export { LibraryChat, type LibraryChatProps } from './components/LibraryChat';
export { useNotebookSearch } from './hooks/queries';
export type { NotebookCard } from './model/types';
