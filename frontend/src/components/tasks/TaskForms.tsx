import { FormEvent, useState } from 'react';
import { toast } from 'react-toastify';
import { errorMessage } from '../../lib/api/http';
import { createProject, PROJECT_STATUS_LABELS, PROJECT_STATUSES, ProjectDetails, ProjectMember, ProjectStatus, ProjectVisibility } from '../../lib/api/projects';
import { createTask, PRIORITY_LABELS, STATUS_LABELS, TASK_PRIORITIES, TASK_STATUSES, TaskPriority, TaskStatus, TaskView } from '../../lib/api/tasks';
import { toDueIso, toStartIso } from '../../lib/tasks/board';
import { Button, Field, Modal, TextArea, TextInput } from '../ui';
import { selectClass } from './TaskBits';

/** T.33 — "New task" and "New project" forms (client-side checks mirror the server's). */

export interface NewTaskValues {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string;
  startDate: string;
  dueDate: string;
  estimateHours: string;
  labels: string;
}

export const validateNewTask = (v: NewTaskValues): Partial<Record<keyof NewTaskValues, string>> => {
  const errors: Partial<Record<keyof NewTaskValues, string>> = {};
  const title = v.title.trim();
  if (!title) errors.title = 'Give the task a title.';
  else if (title.length > 200) errors.title = 'Keep the title under 200 characters.';
  if (v.description.length > 20_000) errors.description = 'The description is too long.';
  if (v.estimateHours.trim()) {
    const n = Number(v.estimateHours);
    if (!Number.isFinite(n) || n < 0 || n > 10_000) errors.estimateHours = 'Enter hours between 0 and 10000.';
  }
  if (v.startDate && v.dueDate && v.dueDate < v.startDate) errors.dueDate = 'The due date is before the start date.';
  const labels = v.labels.split(',').map((l) => l.trim()).filter(Boolean);
  if (labels.length > 10) errors.labels = 'Use at most 10 labels.';
  else if (labels.some((l) => l.length > 32)) errors.labels = 'Labels are at most 32 characters each.';
  return errors;
};

interface NewTaskModalProps {
  projectId: string;
  members: ProjectMember[];
  canAssignOthers: boolean;
  myId?: string;
  initialStatus?: TaskStatus;
  onClose: () => void;
  onCreated: (task: TaskView) => void;
}

export const NewTaskModal = ({ projectId, members, canAssignOthers, myId, initialStatus = 'TODO', onClose, onCreated }: NewTaskModalProps) => {
  const [values, setValues] = useState<NewTaskValues>({
    title: '',
    description: '',
    status: initialStatus,
    priority: 'MEDIUM',
    assigneeId: '',
    startDate: '',
    dueDate: '',
    estimateHours: '',
    labels: '',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof NewTaskValues, string>>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof NewTaskValues>(key: K, value: NewTaskValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const found = validateNewTask(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const labels = Array.from(new Set(values.labels.split(',').map((l) => l.trim()).filter(Boolean)));
      const { task } = await createTask(projectId, {
        title: values.title.trim(),
        ...(values.description.trim() ? { description: values.description } : {}),
        status: values.status,
        priority: values.priority,
        ...(values.assigneeId ? { assigneeId: values.assigneeId } : {}),
        ...(values.startDate ? { startDate: toStartIso(values.startDate) } : {}),
        ...(values.dueDate ? { dueDate: toDueIso(values.dueDate) } : {}),
        ...(values.estimateHours.trim() ? { estimateHours: Number(values.estimateHours) } : {}),
        ...(labels.length ? { labels } : {}),
      });
      toast.success(`${task.identifier} created`);
      onCreated(task);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'The task could not be created.'));
    } finally {
      setBusy(false);
    }
  };

  const assignees = canAssignOthers ? members.map((m) => ({ id: m.userId, name: m.user.username })) : myId ? [{ id: myId, name: 'Me' }] : [];

  return (
    <Modal
      title="New task"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Create task
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        <Field label="Title" error={errors.title}>
          <TextInput value={values.title} maxLength={220} onChange={(e) => set('title', e.target.value)} placeholder="What needs to be done?" />
        </Field>
        <Field label="Description" error={errors.description}>
          <TextArea rows={4} value={values.description} onChange={(e) => set('description', e.target.value)} placeholder="Details, acceptance criteria, links…" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Status">
            <select value={values.status} onChange={(e) => set('status', e.target.value as TaskStatus)} className={selectClass}>
              {TASK_STATUSES.filter((s) => s !== 'DONE' && s !== 'CANCELLED').map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select value={values.priority} onChange={(e) => set('priority', e.target.value as TaskPriority)} className={selectClass}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assignee">
            <select value={values.assigneeId} onChange={(e) => set('assigneeId', e.target.value)} className={selectClass}>
              <option value="">Unassigned</option>
              {assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Start date">
            <TextInput type="date" value={values.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </Field>
          <Field label="Due date" error={errors.dueDate}>
            <TextInput type="date" value={values.dueDate} min={values.startDate || undefined} onChange={(e) => set('dueDate', e.target.value)} />
          </Field>
          <Field label="Estimate (hours)" error={errors.estimateHours}>
            <TextInput inputMode="decimal" value={values.estimateHours} onChange={(e) => set('estimateHours', e.target.value)} placeholder="e.g. 4" />
          </Field>
        </div>
        <Field label="Labels" hint="Comma separated, e.g. frontend, bug" error={errors.labels}>
          <TextInput value={values.labels} onChange={(e) => set('labels', e.target.value)} />
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
};

// ---- New project ----------------------------------------------------------------

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/;

export const suggestProjectKey = (name: string) => {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '');
  const cleaned = key.replace(/^[0-9]+/, '').slice(0, 6);
  return cleaned.length >= 2 ? cleaned : (cleaned + 'PRJ').slice(0, 3);
};

export const CreateProjectModal = ({ workspaceId, onClose, onCreated }: { workspaceId: string; onClose: () => void; onCreated: (project: ProjectDetails) => void }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<ProjectVisibility>('PUBLIC');
  const [status, setStatus] = useState<ProjectStatus>('ACTIVE');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const effectiveKey = keyTouched ? key : suggestProjectKey(name);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = 'Give the project a name.';
    else if (name.trim().length > 80) found.name = 'Keep the name under 80 characters.';
    if (effectiveKey && !PROJECT_KEY_PATTERN.test(effectiveKey)) found.key = '2–6 capital letters or digits, starting with a letter.';
    if (startDate && dueDate && dueDate < startDate) found.dueDate = 'The due date is before the start date.';
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const project = await createProject(workspaceId, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        visibility,
        status,
        ...(effectiveKey ? { key: effectiveKey } : {}),
        ...(startDate ? { startDate: toStartIso(startDate) } : {}),
        ...(dueDate ? { dueDate: toDueIso(dueDate) } : {}),
      });
      toast.success(`Project "${project.name}" created`);
      onCreated(project);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'The project could not be created.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New project"
      subtitle="You become the project owner and can add members afterwards."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Create project
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field label="Name" error={errors.name}>
            <TextInput value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. Website relaunch" />
          </Field>
          <Field label="Key" hint="Task IDs, e.g. WEB-12" error={errors.key}>
            <TextInput
              value={effectiveKey}
              maxLength={6}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
              }}
            />
          </Field>
        </div>
        <Field label="Description">
          <TextArea rows={3} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Visibility" hint={visibility === 'PUBLIC' ? 'Every workspace member can see and join it.' : 'Only members you add can see it.'}>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as ProjectVisibility)} className={selectClass}>
              <option value="PUBLIC">Public</option>
              <option value="PRIVATE">Private</option>
            </select>
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)} className={selectClass}>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start date">
            <TextInput type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="Target date" error={errors.dueDate}>
            <TextInput type="date" value={dueDate} min={startDate || undefined} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
};
