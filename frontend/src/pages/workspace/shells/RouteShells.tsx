import { FolderKanban } from 'lucide-react';
import { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { EmptyState } from '../../../components/ui';

/**
 * F1 route shells — the URLs F3 (projects) will fill in (F2 replaced the
 * organization and workspace-settings shells with real pages). Deliberately not linked from any navigation yet,
 * so nobody lands on an unfinished page by accident; they render an honest
 * "not available yet" state instead of a fake UI.
 */
const Shell = ({ title, icon, children }: { title: string; icon: ReactNode; children?: ReactNode }) => (
  <section className="flex-1 flex flex-col bg-surface overflow-y-auto" aria-labelledby="route-shell-title">
    <header className="px-8 py-6 border-b border-line">
      <h1 id="route-shell-title" className="text-xl font-black text-fg tracking-tight">
        {title}
      </h1>
    </header>
    <EmptyState icon={icon} title={`${title} isn't available yet`} description="This area is being built and will appear in an upcoming update." />
    {children}
  </section>
);

export const ProjectsShell = () => <Shell title="Projects" icon={<FolderKanban size={24} />} />;

export const ProjectShell = () => {
  const { projectId } = useParams<{ projectId: string }>();
  return <Shell title="Project" icon={<FolderKanban size={24} />}>{projectId ? <span className="sr-only">Project {projectId}</span> : null}</Shell>;
};
