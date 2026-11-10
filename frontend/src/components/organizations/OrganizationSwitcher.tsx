import { Building2, Check, ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { OrganizationSummary } from '../../lib/api';
import { Menu } from '../ui';

interface OrganizationSwitcherProps {
  organizations: OrganizationSummary[];
  currentId: string | null;
  /** The layout workspace — organization pages live under /:workspaceId/organizations. */
  layoutWorkspaceId: string;
}

/** Menu button listing the caller's organizations (GET /api/organizations). */
export const OrganizationSwitcher = ({ organizations, currentId, layoutWorkspaceId }: OrganizationSwitcherProps) => {
  const navigate = useNavigate();
  if (organizations.length < 2) return null;
  return (
    <Menu
      label="Switch organization"
      align="right"
      triggerClassName="inline-flex items-center gap-1.5 h-10 px-3 rounded-xl border border-line bg-surface text-sm font-semibold text-fg hover:bg-surface-tertiary"
      trigger={
        <>
          <Building2 size={14} aria-hidden="true" />
          Switch organization
          <ChevronDown size={14} aria-hidden="true" />
        </>
      }
      items={organizations.map((o) => ({
        id: o.id,
        label: o.id === currentId ? `${o.name} (current)` : o.name,
        icon: o.id === currentId ? <Check size={14} aria-hidden="true" /> : <Building2 size={14} aria-hidden="true" />,
        onSelect: () => navigate(`/${layoutWorkspaceId}/organizations/${o.id}`),
      }))}
    />
  );
};
