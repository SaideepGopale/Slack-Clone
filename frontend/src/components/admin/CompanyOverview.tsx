import { Building2, ChevronLeft, ChevronRight, Eye, Search, ShieldCheck, Users, X } from 'lucide-react';
import { ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { companyOverviewApi, errorMessage } from '../../lib/api';
import type { CompanySummary, CompanyTeamLead, CompanyWorkspace, CompanyWorkspaceDetail, Paged, WorkspaceQuery } from '../../lib/api/companyOverview';
import { Badge, Button, EmptyState, ErrorState, LoadingState, Modal, TextInput } from '../ui';
import type { BadgeTone } from '../ui';

/**
 * Stage 4 (T.23) — Admin → Company → Workspace Overview. A read-only console
 * for the Company Admin: company metrics, every workspace (search, filter,
 * sort, paginate), workspace metadata and Team Leads. It shows metadata only
 * — never messages, files, threads, DMs or calls — and grants nothing: the
 * server endpoints are admin-only and read-only.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const nameOf = (p: { displayName: string | null; username: string }) => p.displayName || p.username;
const STATUS_TONE: Record<string, BadgeTone> = { ACTIVE: 'success', SUSPENDED: 'warning', BANNED: 'danger' };
const STATUS_LABEL: Record<string, string> = { ACTIVE: 'Active', SUSPENDED: 'Suspended', BANNED: 'Banned' };
const LEVEL_LABEL: Record<string, string> = { COMPANY_ADMIN: 'Company Admin', TEAM_LEAD: 'Team Lead', MEMBER: 'Member' };
const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };
const SORTS = [
  { value: 'createdAt:desc', label: 'Newest first' },
  { value: 'createdAt:asc', label: 'Oldest first' },
  { value: 'name:asc', label: 'Name A–Z' },
  { value: 'name:desc', label: 'Name Z–A' },
  { value: 'members:desc', label: 'Most members' },
  { value: 'members:asc', label: 'Fewest members' },
];
const selectClass = 'h-10 rounded-xl border border-line bg-surface text-fg text-sm px-3';

const Metric = ({ label, value, hint }: { label: string; value: number; hint?: string }) => (
  <div className="bg-surface border border-line rounded-2xl p-4 shadow-sm">
    <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wider">{label}</p>
    <p className="text-2xl font-bold text-fg mt-1">{value}</p>
    {hint && <p className="text-xs text-fg-muted mt-1">{hint}</p>}
  </div>
);

const LabeledSelect = ({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) => {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${selectClass} w-full`}>
        {children}
      </select>
    </div>
  );
};

const Pagination = ({ data, onPage }: { data: Paged; onPage: (page: number) => void }) => (
  <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-line text-sm text-fg-muted">
    <span>{plural(data.total, 'result')}</span>
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="sm" aria-label="Previous page" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)} icon={<ChevronLeft size={14} aria-hidden="true" />} />
      <span>{`Page ${data.page} of ${data.totalPages}`}</span>
      <Button variant="secondary" size="sm" aria-label="Next page" disabled={data.page >= data.totalPages} onClick={() => onPage(data.page + 1)} icon={<ChevronRight size={14} aria-hidden="true" />} />
    </div>
  </div>
);

const WorkspaceDetailModal = ({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) => {
  const [detail, setDetail] = useState<CompanyWorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    companyOverviewApi
      .getWorkspace(workspaceId)
      .then((d) => alive && setDetail(d))
      .catch((err) => alive && setError(errorMessage(err, 'Could not load this workspace.')));
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  return (
    <Modal title={detail?.name ?? 'Workspace'} subtitle={detail?.description ?? undefined} onClose={onClose} size="lg" footer={<Button onClick={onClose}>Done</Button>}>
      {error ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : !detail ? (
        <LoadingState label="Loading workspace" />
      ) : (
        <div className="space-y-5 text-sm">
          <p className="rounded-xl bg-surface-secondary border border-line px-3 py-2 text-xs text-fg-muted flex items-center gap-2">
            <ShieldCheck size={14} aria-hidden="true" /> Read-only administrative overview. Message and file contents are not shown here, and viewing grants no access.
          </p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><dt className="text-xs text-fg-subtle">Type</dt><dd className="text-fg">{detail.isDefault ? 'Shared default workspace' : 'Team workspace'}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Owner</dt><dd className="text-fg">{nameOf(detail.owner)} · {LEVEL_LABEL[detail.owner.level]}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Team Lead</dt><dd className="text-fg">{detail.teamLead ? nameOf(detail.teamLead) : '—'}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Created</dt><dd className="text-fg">{date(detail.createdAt)}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Channels</dt><dd className="text-fg">{`${detail.activity.publicChannels} public · ${detail.activity.privateChannels} private`}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Last activity</dt><dd className="text-fg">{date(detail.activity.lastMessageAt)}</dd></div>
          </dl>
          <section>
            <h3 className="text-xs font-bold text-fg-subtle uppercase tracking-wider mb-2">{`Members (${detail.memberCount})`}</h3>
            <ul aria-label="Members" className="divide-y divide-line border border-line rounded-xl">
              {detail.members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-semibold text-fg">{nameOf(m)}</span>
                  <span className="text-xs text-fg-subtle">{m.email}</span>
                  <span className="ml-auto flex gap-1.5">
                    <Badge tone="brand">{ROLE_LABEL[m.workspaceRole]}</Badge>
                    <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                    <Badge>{LEVEL_LABEL[m.level]}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="text-xs font-bold text-fg-subtle uppercase tracking-wider mb-2">{`Pending invitations (${detail.pendingInvitations.length})`}</h3>
            {detail.pendingInvitations.length === 0 ? (
              <p className="text-fg-muted">No pending invitations.</p>
            ) : (
              <ul aria-label="Pending invitations" className="divide-y divide-line border border-line rounded-xl">
                {detail.pendingInvitations.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="font-semibold text-fg">{nameOf(i.account)}</span>
                    <span className="text-xs text-fg-subtle">{i.account.email}</span>
                    <span className="ml-auto text-xs text-fg-muted">{`Expires ${date(i.expiresAt)}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
};

export const CompanyOverview = () => {
  const [summary, setSummary] = useState<CompanySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [tab, setTab] = useState<'workspaces' | 'leads'>('workspaces');
  const [filters, setFilters] = useState<{ q: string; type: string; status: string; minMembers: string; sort: string; teamLead: { id: string; name: string } | null }>({
    q: '', type: 'all', status: 'all', minMembers: '', sort: 'createdAt:desc', teamLead: null,
  });
  const [page, setPage] = useState(1);
  const [workspaces, setWorkspaces] = useState<(Paged & { workspaces: CompanyWorkspace[] }) | null>(null);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const [leadQuery, setLeadQuery] = useState('');
  const [leadPage, setLeadPage] = useState(1);
  const [leads, setLeads] = useState<(Paged & { teamLeads: CompanyTeamLead[] }) | null>(null);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    setSummaryError(null);
    try {
      setSummary(await companyOverviewApi.getSummary());
    } catch (err) {
      setSummaryError(errorMessage(err, 'Could not load the company overview.'));
    }
  }, []);
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const loadWorkspaces = useCallback(async () => {
    const [sort, order] = filters.sort.split(':') as [WorkspaceQuery['sort'], WorkspaceQuery['order']];
    const min = Number(filters.minMembers);
    setWorkspacesError(null);
    try {
      setWorkspaces(
        await companyOverviewApi.listWorkspaces({
          q: filters.q.trim() || undefined,
          type: filters.type as WorkspaceQuery['type'],
          status: filters.status as WorkspaceQuery['status'],
          minMembers: filters.minMembers !== '' && Number.isInteger(min) && min >= 0 ? min : undefined,
          teamLeadId: filters.teamLead?.id,
          sort,
          order,
          page,
        })
      );
    } catch (err) {
      setWorkspacesError(errorMessage(err, 'Could not load workspaces.'));
    }
  }, [filters, page]);
  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const loadLeads = useCallback(async () => {
    setLeadsError(null);
    try {
      setLeads(await companyOverviewApi.listTeamLeads({ q: leadQuery.trim() || undefined, page: leadPage }));
    } catch (err) {
      setLeadsError(errorMessage(err, 'Could not load Team Leads.'));
    }
  }, [leadQuery, leadPage]);
  useEffect(() => {
    if (tab === 'leads') void loadLeads();
  }, [tab, loadLeads]);

  const setFilter = <K extends keyof typeof filters>(key: K, value: (typeof filters)[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  if (summaryError) return <div className="p-8"><ErrorState message={summaryError} onRetry={() => void loadSummary()} /></div>;
  if (!summary) return <LoadingState label="Loading company overview" />;

  return (
    <div className="h-full flex flex-col bg-surface-secondary p-4 sm:p-8 gap-6 overflow-y-auto">
      <header>
        <h1 className="text-2xl font-bold text-fg tracking-tight flex items-center gap-2"><Building2 size={22} aria-hidden="true" /> Workspace Overview</h1>
        <p className="text-sm text-fg-muted mt-1">Every company workspace, Team Lead and invitation at a glance. Read-only metadata — conversations and files stay private.</p>
      </header>

      <section aria-label="Company metrics" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        <Metric label="Total workspaces" value={summary.totalWorkspaces} />
        <Metric label="Active workspaces" value={summary.activeWorkspaces} />
        <Metric label="Active users" value={summary.totalActiveUsers} />
        <Metric label="Team Leads" value={summary.totalTeamLeads} />
        <Metric label="Team Members" value={summary.totalTeamMembers} hint={`${summary.activeMembers} active · ${summary.suspendedMembers} suspended`} />
        <Metric label="Pending invitations" value={summary.invitations.pending} hint={`${summary.invitations.accepted} accepted · ${summary.invitations.expired} expired · ${summary.invitations.revoked} revoked`} />
        <Metric label="Suspended users" value={summary.suspendedUsers} />
      </section>

      <div role="tablist" aria-label="Overview sections" className="flex gap-2">
        {([['workspaces', 'Workspaces'], ['leads', 'Team Leads']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold border ${tab === id ? 'bg-brand text-white border-brand' : 'bg-surface text-fg border-line hover:bg-surface-secondary'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'workspaces' ? (
        <section className="bg-surface border border-line rounded-2xl shadow-sm overflow-hidden" aria-label="All workspaces">
          <div className="p-4 border-b border-line grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <label className="relative lg:col-span-2">
              <span className="sr-only">Search workspaces</span>
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
              <TextInput type="search" aria-label="Search workspaces" placeholder="Search by name or description" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} className="pl-9" />
            </label>
            <LabeledSelect label="Type" value={filters.type} onChange={(v) => setFilter('type', v)}>
              <option value="all">All types</option>
              <option value="default">Shared default</option>
              <option value="team">Team workspaces</option>
            </LabeledSelect>
            <LabeledSelect label="Status" value={filters.status} onChange={(v) => setFilter('status', v)}>
              <option value="all">Any status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </LabeledSelect>
            <TextInput type="number" min={0} aria-label="Minimum members" placeholder="Min. members" value={filters.minMembers} onChange={(e) => setFilter('minMembers', e.target.value)} />
            <LabeledSelect label="Sort by" value={filters.sort} onChange={(v) => setFilter('sort', v)}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </LabeledSelect>
            {filters.teamLead && (
              <div className="sm:col-span-2 lg:col-span-6">
                <span className="inline-flex items-center gap-2 rounded-full bg-brand-muted text-brand text-xs font-semibold px-3 py-1">
                  {`Team Lead: ${filters.teamLead.name}`}
                  <button type="button" aria-label="Clear Team Lead filter" onClick={() => setFilter('teamLead', null)}><X size={12} aria-hidden="true" /></button>
                </span>
              </div>
            )}
          </div>
          {workspacesError ? (
            <ErrorState message={workspacesError} onRetry={() => void loadWorkspaces()} />
          ) : !workspaces ? (
            <LoadingState label="Loading workspaces" />
          ) : workspaces.workspaces.length === 0 ? (
            <EmptyState icon={<Building2 size={24} />} title="No matching workspaces" description="Try a different search or filter." />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table aria-label="Workspaces" className="w-full text-sm min-w-[760px]">
                  <thead className="text-left text-xs text-fg-subtle uppercase tracking-wider">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-semibold">Workspace</th>
                      <th className="px-4 py-2 font-semibold">Owner / Team Lead</th>
                      <th className="px-4 py-2 font-semibold">Members</th>
                      <th className="px-4 py-2 font-semibold">Pending</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 font-semibold">Created</th>
                      <th className="px-4 py-2"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {workspaces.workspaces.map((w) => (
                      <tr key={w.id} className="align-top">
                        <td className="px-4 py-3 max-w-xs">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-fg">{w.name}</span>
                            {w.isDefault && <Badge tone="brand">Shared default</Badge>}
                          </div>
                          {w.description && <p className="text-xs text-fg-muted truncate">{w.description}</p>}
                        </td>
                        <td className="px-4 py-3">
                          {w.teamLead ? <span className="text-fg">{nameOf(w.teamLead)}</span> : <span className="text-fg-muted">{w.isDefault ? 'Company-wide' : nameOf(w.owner)}</span>}
                          <p className="text-xs text-fg-subtle">{w.teamLead ? 'Team Lead' : LEVEL_LABEL[w.owner.level]}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-semibold text-fg">{w.memberCount}</span>
                          <p className="text-xs text-fg-subtle">{`${w.activeMemberCount} active`}</p>
                        </td>
                        <td className="px-4 py-3 text-fg">{w.pendingInvitations}</td>
                        <td className="px-4 py-3"><Badge tone={w.status === 'active' ? 'success' : 'neutral'}>{w.status === 'active' ? 'Active' : 'Inactive'}</Badge></td>
                        <td className="px-4 py-3 text-fg-muted whitespace-nowrap">{date(w.createdAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <Button variant="secondary" size="sm" aria-label={`View details for ${w.name}`} icon={<Eye size={14} aria-hidden="true" />} onClick={() => setViewing(w.id)}>
                            Details
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination data={workspaces} onPage={setPage} />
            </>
          )}
        </section>
      ) : (
        <section className="bg-surface border border-line rounded-2xl shadow-sm overflow-hidden" aria-label="Team Leads overview">
          <div className="p-4 border-b border-line">
            <label className="relative block max-w-md">
              <span className="sr-only">Search Team Leads</span>
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
              <TextInput type="search" aria-label="Search Team Leads" placeholder="Search by name or e-mail" value={leadQuery} onChange={(e) => { setLeadQuery(e.target.value); setLeadPage(1); }} className="pl-9" />
            </label>
          </div>
          {leadsError ? (
            <ErrorState message={leadsError} onRetry={() => void loadLeads()} />
          ) : !leads ? (
            <LoadingState label="Loading Team Leads" />
          ) : leads.teamLeads.length === 0 ? (
            <EmptyState icon={<Users size={24} />} title="No Team Leads found" description="Team Leads are added in Team Management." />
          ) : (
            <>
              <ul className="divide-y divide-line">
                {leads.teamLeads.map((lead) => (
                  <li key={lead.id} className="flex flex-col md:flex-row md:items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-fg">{nameOf(lead)}</span>
                        <Badge tone={STATUS_TONE[lead.status]}>{STATUS_LABEL[lead.status]}</Badge>
                      </div>
                      <p className="text-xs text-fg-muted truncate">{lead.email}</p>
                      <p className="text-xs text-fg-subtle">{`Since ${date(lead.createdAt)}`}</p>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
                      <span>{plural(lead.managedWorkspaces, 'workspace')}</span>
                      <span>{plural(lead.teamMembers, 'team member')}</span>
                      <span>{plural(lead.pendingInvitations, 'pending invitation')}</span>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`View workspaces of ${nameOf(lead)}`}
                      onClick={() => {
                        setFilters((f) => ({ ...f, teamLead: { id: lead.id, name: nameOf(lead) } }));
                        setPage(1);
                        setTab('workspaces');
                      }}
                    >
                      View workspaces
                    </Button>
                  </li>
                ))}
              </ul>
              <Pagination data={leads} onPage={setLeadPage} />
            </>
          )}
        </section>
      )}

      {viewing && <WorkspaceDetailModal workspaceId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
};
