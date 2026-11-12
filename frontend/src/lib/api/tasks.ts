import axios from 'axios';
import { ApiError, http, seg, toApiError } from './http';

/** T.33 — projects & tasks (contract: backend modules/tasks). */

export const TASK_STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface UserRef {
  id: string;
  username: string;
  displayName: string | null;
}

export interface TaskRef {
  id: string;
  identifier: string;
  title: string;
  status: TaskStatus;
}

export interface TaskView {
  id: string;
  projectId: string;
  workspaceId: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: UserRef | null;
  creator: UserRef | null;
  parentId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateHours: number | null;
  actualHours: number | null;
  labels: string[];
  position: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  subtaskCount: number;
  subtasksDone: number;
  commentCount: number;
  openBlockerCount: number;
  overdue: boolean;
  project?: { id: string; name: string; key: string };
  /** T.38: a private assignment — visible only to its assignee, its creator and the workspace leads. */
  assigneeOnly?: boolean;
}

export interface CommentView {
  id: string;
  body: string;
  author: UserRef | null;
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
}

export interface ActivityView {
  id: string;
  type: string;
  actor: UserRef | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface TaskCapabilities {
  update: boolean;
  changeStatus: boolean;
  complete: boolean;
  assignOthers: boolean;
  assignSelf: boolean;
  delete: boolean;
  comment: boolean;
}

export interface TaskDetail extends TaskView {
  project: { id: string; name: string; key: string; workspaceId: string; requireReview: boolean; archived: boolean };
  parent: TaskRef | null;
  subtasks: TaskView[];
  blockedBy: TaskRef[];
  blocking: TaskRef[];
  comments: CommentView[];
  activity: ActivityView[];
  attachments: TaskAttachment[];
  capabilities: TaskCapabilities;
}

export interface TaskFilters {
  status?: TaskStatus[];
  assigneeId?: string; // id | 'me' | 'none'
  priority?: TaskPriority[];
  label?: string;
  q?: string;
  parent?: string; // 'root' (default) | 'any' | taskId
  dueFrom?: string;
  dueTo?: string;
  limit?: number;
  cursor?: string;
}

export interface TaskInput {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  parentId?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  estimateHours?: number | null;
  actualHours?: number | null;
  labels?: string[];
}

/** Drops empty values and joins lists, so only meaningful filters reach the query string. */
const toParams = (filters: TaskFilters) => {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params[key] = value.join(',');
    } else {
      params[key] = value as string | number;
    }
  }
  return params;
};

export const listTasks = (projectId: string, filters: TaskFilters = {}) => {
  const params = toParams(filters);
  return Object.keys(params).length
    ? http.get<{ tasks: TaskView[]; nextCursor: string | null }>(`/api/projects/${seg(projectId)}/tasks`, params)
    : http.get<{ tasks: TaskView[]; nextCursor: string | null }>(`/api/projects/${seg(projectId)}/tasks`);
};

export const createTask = (projectId: string, input: TaskInput & { title: string }) =>
  http.post<{ task: TaskView }>(`/api/projects/${seg(projectId)}/tasks`, input);

export const getTask = (taskId: string) => http.get<TaskDetail>(`/api/tasks/${seg(taskId)}`);

export const updateTask = (taskId: string, input: TaskInput) => http.patch<{ task: TaskView }>(`/api/tasks/${seg(taskId)}`, input);

export const deleteTask = (taskId: string) => http.delete<{ deleted: true }>(`/api/tasks/${seg(taskId)}`);

export const moveTask = (taskId: string, move: { status: TaskStatus; prevId?: string | null; nextId?: string | null }) =>
  http.post<{ task: TaskView }>(`/api/tasks/${seg(taskId)}/move`, move);

export const listComments = (taskId: string, cursor?: string) =>
  cursor
    ? http.get<{ comments: CommentView[]; nextCursor: string | null }>(`/api/tasks/${seg(taskId)}/comments`, { cursor })
    : http.get<{ comments: CommentView[]; nextCursor: string | null }>(`/api/tasks/${seg(taskId)}/comments`);

export const addComment = (taskId: string, body: string) => http.post<{ comment: CommentView }>(`/api/tasks/${seg(taskId)}/comments`, { body });

export const editComment = (commentId: string, body: string) => http.patch<{ comment: CommentView }>(`/api/task-comments/${seg(commentId)}`, { body });

export const deleteComment = (commentId: string) => http.delete<{ deleted: true }>(`/api/task-comments/${seg(commentId)}`);

export const addDependency = (taskId: string, dependsOnId: string) =>
  http.post<{ blockedBy: TaskRef[] }>(`/api/tasks/${seg(taskId)}/dependencies`, { dependsOnId });

export const removeDependency = (taskId: string, dependsOnId: string) =>
  http.delete<{ blockedBy: TaskRef[] }>(`/api/tasks/${seg(taskId)}/dependencies/${seg(dependsOnId)}`);

export const shareTask = (taskId: string, channelId: string, note?: string) =>
  http.post<{ messageId: string }>(`/api/tasks/${seg(taskId)}/share`, note ? { channelId, note } : { channelId });

export interface TaskAttachment {
  id: string;
  url: string;
  name: string;
  type: string;
  size: number;
}

/** Uploads a file through the private-attachment upload (multipart field `attachment`). */
export const uploadFile = async (file: File, { onProgress, signal }: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {}) => {
  const form = new FormData();
  form.append('attachment', file);
  try {
    const res = await axios.post<{ id: string; url: string; name: string; type: string; size: number }>('/api/upload', form, {
      signal,
      onUploadProgress: (pe) => onProgress?.(Math.round((pe.loaded * 100) / (pe.total || file.size || 1))),
    });
    return res.data;
  } catch (err) {
    // The upload route answers `{ message }` rather than `{ error }`.
    const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
    const apiError = toApiError(err);
    throw message ? new ApiError(message, apiError.status, apiError.data) : apiError;
  }
};

/** Links an uploaded file (POST /api/upload's `id`) to a task. */
export const addTaskAttachment = (taskId: string, attachmentId: string) =>
  http.post<{ attachments: TaskAttachment[] }>(`/api/tasks/${seg(taskId)}/attachments`, { attachmentId });

export const removeTaskAttachment = (taskId: string, attachmentId: string) =>
  http.delete<{ attachments: TaskAttachment[] }>(`/api/tasks/${seg(taskId)}/attachments/${seg(attachmentId)}`);

export type MyTasksView = 'assigned' | 'created' | 'overdue' | 'due-soon' | 'completed' | 'todo' | 'in-progress' | 'done';
export interface MyTasksCounts {
  assigned: number;
  created: number;
  overdue: number;
  dueSoon: number;
  completed: number;
  /** T.38: the caller's own tasks by stage. */
  todo: number;
  inProgress: number;
  done: number;
}

export const listMyTasks = (workspaceId: string, view: MyTasksView, params: { limit?: number; cursor?: string } = {}) =>
  http.get<{ tasks: TaskView[]; nextCursor: string | null; counts: MyTasksCounts }>(`/api/workspaces/${seg(workspaceId)}/my-tasks`, {
    view,
    ...toParams(params),
  });

export interface WorkloadPerson {
  user: UserRef;
  open: number;
  inProgress: number;
  overdue: number;
  dueThisWeek: number;
  estimateHours: number;
  completedLast30: number;
}

export const getWorkload = (workspaceId: string, projectId?: string) =>
  projectId
    ? http.get<{ people: WorkloadPerson[]; unassigned: { open: number; overdue: number } }>(`/api/workspaces/${seg(workspaceId)}/workload`, { projectId })
    : http.get<{ people: WorkloadPerson[]; unassigned: { open: number; overdue: number } }>(`/api/workspaces/${seg(workspaceId)}/workload`);

export interface ProjectReport {
  totals: { all: number; open: number; done: number; cancelled: number; overdue: number; unassigned: number; completionPercent: number };
  byStatus: Record<TaskStatus, number>;
  byPriority: Record<TaskPriority, number>;
  completedByWeek: { weekStart: string; count: number }[];
  byAssignee: { user: UserRef | null; open: number; done: number }[];
}

export const getProjectReport = (projectId: string) => http.get<ProjectReport>(`/api/projects/${seg(projectId)}/report`);

export interface WorkNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  taskId: string | null;
  projectId: string | null;
  actor: UserRef | null;
  readAt: string | null;
  createdAt: string;
}

export const listWorkNotifications = (workspaceId: string, params: { unread?: boolean; limit?: number } = {}) =>
  http.get<{ notifications: WorkNotification[]; unreadCount: number }>(`/api/workspaces/${seg(workspaceId)}/work-notifications`, {
    ...(params.unread ? { unread: 1 } : {}),
    ...(params.limit ? { limit: params.limit } : {}),
  });

export const markWorkNotificationsRead = (workspaceId: string, which: { ids: string[] } | { all: true }) =>
  http.post<{ updated: number }>('/api/work-notifications/read', { workspaceId, ...which });

// ---- presentation helpers (shared by board, list, drawer) --------------------

export const STATUS_LABELS: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  IN_REVIEW: 'In review',
  BLOCKED: 'Blocked',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = { URGENT: 'Urgent', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

export const isClosedStatus = (status: TaskStatus) => status === 'DONE' || status === 'CANCELLED';

/** Name to show for a person reference. */
export const personName = (user: UserRef | null | undefined) => (user ? user.displayName || user.username : 'Unassigned');

// ---- T.38: the Team Lead dashboard (lead-only endpoints) ----

export interface TeamMemberProgress {
  user: UserRef;
  workspaceRole: 'ADMIN' | 'MEMBER';
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  overdue: number;
  completionRate: number;
}

export interface TeamSummary {
  totals: { total: number; todo: number; inProgress: number; completed: number; overdue: number; cancelled: number; unassigned: number };
  members: TeamMemberProgress[];
}

export type TeamStatusFilter = '' | 'todo' | 'in_progress' | 'completed' | 'cancelled';
export type TeamDueFilter = '' | 'overdue' | 'today' | 'week' | 'none';

export interface TeamTaskFilters {
  assigneeId?: string;
  status?: TeamStatusFilter;
  priority?: TaskPriority | '';
  due?: TeamDueFilter;
  overdue?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface TeamTaskOptions {
  members: (UserRef & { workspaceRole: 'ADMIN' | 'MEMBER' })[];
  projects: { id: string; name: string; key: string }[];
}

export interface TeamTaskInput {
  title: string;
  description?: string;
  assigneeId: string;
  priority: TaskPriority;
  dueDate?: string | null;
  projectId?: string;
}

const teamPath = (workspaceId: string) => `/api/workspaces/${seg(workspaceId)}/team-tasks`;

export const getTeamSummary = (workspaceId: string) => http.get<TeamSummary>(`${teamPath(workspaceId)}/summary`);

export const getTeamTaskOptions = (workspaceId: string) => http.get<TeamTaskOptions>(`${teamPath(workspaceId)}/options`);

export const listTeamTasks = (workspaceId: string, filters: TeamTaskFilters = {}) => {
  const { overdue, ...rest } = filters;
  const params = Object.fromEntries(Object.entries({ ...rest, ...(overdue ? { overdue: '1' } : {}) }).filter(([, v]) => v !== undefined && v !== ''));
  return http.get<{ tasks: TaskView[]; nextCursor: string | null; total: number }>(teamPath(workspaceId), params);
};

export const createTeamTask = (workspaceId: string, input: TeamTaskInput) => http.post<{ task: TaskView }>(teamPath(workspaceId), input);
