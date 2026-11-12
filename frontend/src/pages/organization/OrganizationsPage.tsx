import { Building2, ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { AccessProblem } from '../../components/management/AccessProblem';
import { PageFrame } from '../../components/management/PageFrame';
import { RoleBadge } from '../../components/management/RoleBadge';
import { CreateOrganizationModal } from '../../components/organizations/CreateOrganizationModal';
import { Badge, Button, EmptyState, focusRing, LoadingState } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { organizationsApi } from '../../lib/api';
import { useWorkspace } from '../workspace/WorkspaceContext';

/** /:workspaceId/organizations — the caller's organizations and "create organization". */
export const OrganizationsPage = () => {
  const { workspaceId, socket } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const organizations = useApiQuery(() => organizationsApi.listOrganizations(), []);

  useSocketEvent<{ id: string; name: string }>(socket, 'organization:updated', (payload) =>
    organizations.setData((prev) => prev?.map((o) => (o.id === payload.id ? { ...o, name: payload.name } : o)))
  );
  const reload = () => organizations.reload({ silent: true }).catch(() => undefined);
  // My role (and so my capabilities) changed, or I was removed somewhere.
  useSocketEvent<{ userId: string }>(socket, 'organization:member_updated', (payload) => {
    if (payload.userId === user?.id) reload();
  });
  useSocketEvent(socket, 'organization:removed', reload);

  return (
    <PageFrame
      eyebrow="SmartConnect"
      title="Organizations"
      actions={
        <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => setCreating(true)}>
          New organization
        </Button>
      }
    >
      {organizations.error && !organizations.data ? (
        <AccessProblem error={organizations.error} resource="organization" onRetry={() => organizations.reload()} />
      ) : !organizations.data ? (
        <LoadingState label="Loading organizations" />
      ) : organizations.data.length === 0 ? (
        <EmptyState icon={<Building2 size={28} aria-hidden="true" />} title="No organizations yet" description="Create one to group your workspaces." />
      ) : (
        <ul aria-label="Your organizations" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {organizations.data.map((o) => (
            <li key={o.id}>
              <Link
                to={`/${workspaceId}/organizations/${o.id}`}
                className={`flex items-center gap-3 rounded-2xl border border-line p-4 hover:border-brand hover:bg-brand-soft/40 transition-colors ${focusRing}`}
              >
                <div aria-hidden="true" className="w-10 h-10 rounded-xl bg-brand-soft text-brand flex items-center justify-center shrink-0">
                  <Building2 size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-fg truncate">{o.name}</div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    <RoleBadge role={o.myRole} />
                    {o.isDefault && <Badge tone="brand">Default</Badge>}
                  </div>
                </div>
                <ChevronRight size={16} aria-hidden="true" className="text-fg-subtle shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <CreateOrganizationModal
          onClose={() => setCreating(false)}
          onCreated={(org) => {
            setCreating(false);
            toast.success(`"${org.name}" created. You're its owner.`);
            navigate(`/${workspaceId}/organizations/${org.id}`);
          }}
        />
      )}
    </PageFrame>
  );
};
