import { CheckCircle2, Send } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../lib/api/http';
import { createTeamTask, personName, PRIORITY_LABELS, TaskPriority, TaskView, TeamTaskOptions } from '../../../lib/api/tasks';
import { Button, Field, Modal, TextArea, TextInput } from '../../ui';
import { selectClass } from '../TaskBits';

/**
 * T.38 — "Create task" on the Team Lead dashboard. One task per submit, fast:
 * after "Assign task" the dialog stays open with a confirmation, clears the
 * title and description, and keeps the member, priority, due date and project
 * so the next task can be typed straight away. The server decides everything
 * that matters (workspace, creator, status, visibility); this form only sends
 * the title, description, assignee, priority, due date and optional project.
 */
const PRIORITIES: TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export const CreateTeamTaskModal = ({
  workspaceId,
  options,
  initialAssigneeId,
  onCreated,
  onClose,
}: {
  workspaceId: string;
  options: TeamTaskOptions;
  initialAssigneeId?: string;
  onCreated: (task: TaskView) => void;
  onClose: () => void;
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState(initialAssigneeId ?? '');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [dueDate, setDueDate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<{ title: string; to: string; count: number } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const ready = title.trim().length > 0 && assigneeId !== '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { task } = await createTeamTask(workspaceId, {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        assigneeId,
        priority,
        // End of the chosen day, local time.
        ...(dueDate ? { dueDate: new Date(`${dueDate}T23:59:59`).toISOString() } : {}),
        ...(projectId ? { projectId } : {}),
      });
      onCreated(task);
      setAssigned((prev) => ({ title: task.title, to: personName(task.assignee), count: (prev?.count ?? 0) + 1 }));
      setTitle('');
      setDescription('');
      titleRef.current?.focus();
    } catch (err) {
      setError(errorMessage(err, 'The task could not be assigned.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Create task"
      subtitle="Assign work to a member of this workspace. Only they and the workspace leads can see it."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {assigned ? 'Done' : 'Cancel'}
          </Button>
          <Button type="submit" form="create-team-task" loading={saving} disabled={!ready} icon={<Send size={14} aria-hidden="true" />}>
            Assign task
          </Button>
        </>
      }
    >
      <form id="create-team-task" onSubmit={submit} className="space-y-4" noValidate>
        {assigned && (
          <p role="status" className="flex items-start gap-2 rounded-lg border border-success/25 bg-success-soft px-3 py-2 text-sm text-success">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              Assigned “{assigned.title}” to {assigned.to}.{assigned.count > 1 ? ` ${assigned.count} tasks assigned so far.` : ''} Add another or press Done.
            </span>
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Field label="Task title">
          <TextInput ref={titleRef} value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Draft the onboarding checklist" />
        </Field>
        <Field label="Description (optional)">
          <TextArea rows={3} value={description} maxLength={10000} onChange={(e) => setDescription(e.target.value)} placeholder="What needs to be done, and what does done look like?" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assign to" hint={options.members.length === 0 ? 'This workspace has no active members yet.' : undefined}>
            <select className={selectClass} value={assigneeId} required onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Choose a member…</option>
              {options.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {personName(m)}
                  {m.displayName ? ` (@${m.username})` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select className={selectClass} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due date (optional)">
            <TextInput type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Project (optional)" hint="Left empty, it goes to the workspace's private “Team tasks” list.">
            <select className={selectClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Team tasks</option>
              {options.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </form>
    </Modal>
  );
};
