export type TaskStatus = 'planned' | 'in_progress' | 'blocked' | 'review' | 'done';
export type RequirementKind = 'mes' | 'human' | 'decision';
export type TaskFilter = 'all' | 'active' | 'human' | 'review' | 'done';

export interface DevelopmentRequirement {
  id: string;
  kind: RequirementKind;
  text: string;
  status: 'needed' | 'requested' | 'ready';
  evidence: string;
}

export interface DevelopmentTask {
  slug: string;
  title: string;
  title_zh: string;
  objective: string;
  phase: number;
  priority: 'P1' | 'P2' | 'P3';
  status: TaskStatus;
  owner: string;
  due_date: string | null;
  dependencies: string[];
  requirements: DevelopmentRequirement[];
  checklist: { id: string; text: string; done: boolean }[];
  locations: { kind: 'screen' | 'code' | 'doc'; url: string; label: string; note?: string }[];
  completion_note: string;
  verification_note: string;
  release_state: 'unreleased' | 'code_available' | 'deployed';
  sort_order: number;
  version: number;
  updated_at: string | null;
  completed_at: string | null;
}

export interface DevelopmentTasksResponse {
  tasks: DevelopmentTask[];
  catalog_version: string;
  needs_initialization: boolean;
  read_only: boolean;
}

export interface DevelopmentTaskHistory {
  id: number;
  actor: string;
  action: string;
  changed_fields: string[];
  change_note: string;
  created_at: string;
}

export interface DevelopmentTaskDetailResponse {
  task: DevelopmentTask;
  history: DevelopmentTaskHistory[];
  next_history_before: number | null;
}

export interface DevelopmentTaskRecovery {
  schema: 1;
  user_id: number;
  username: string;
  slug: string;
  base_version: number;
  saved_at: number;
  draft: DevelopmentTask;
  original: DevelopmentTask | null;
  is_new: boolean;
  change_note: string;
}

export function developmentTaskRecoveryKey(userId: number, username: string) {
  return `wj.development-task-draft.v1:${userId}:${encodeURIComponent(username)}`;
}

/** Session storage is untrusted. Restore only a bounded, same-user, structurally valid draft. */
export function parseDevelopmentTaskRecovery(raw: string | null, userId: number, username: string, now: number): DevelopmentTaskRecovery | null {
  if (!raw || raw.length > 1_200_000) return null;
  const isTask = (value: unknown): value is DevelopmentTask => {
    if (!value || typeof value !== 'object') return false;
    const task = value as Record<string, unknown>;
    const strings = ['slug', 'title', 'title_zh', 'objective', 'owner', 'completion_note', 'verification_note'];
    if (strings.some((field) => typeof task[field] !== 'string') || typeof task.version !== 'number' || !Number.isInteger(task.version) || task.version < 0) return false;
    if (!['planned', 'in_progress', 'blocked', 'review', 'done'].includes(String(task.status)) || !['P1', 'P2', 'P3'].includes(String(task.priority))
      || !['unreleased', 'code_available', 'deployed'].includes(String(task.release_state))) return false;
    if (typeof task.phase !== 'number' || !Number.isInteger(task.phase) || task.phase < 0 || task.phase > 5
      || typeof task.sort_order !== 'number' || !Number.isInteger(task.sort_order) || task.sort_order < 0 || task.sort_order > 10000) return false;
    if (!(task.due_date === null || typeof task.due_date === 'string') || !(task.updated_at === null || typeof task.updated_at === 'string')
      || !(task.completed_at === null || typeof task.completed_at === 'string')) return false;
    if (!Array.isArray(task.dependencies) || task.dependencies.length > 30 || !task.dependencies.every((item) => typeof item === 'string')) return false;
    if (!Array.isArray(task.requirements) || task.requirements.length > 60 || !task.requirements.every((item) => item && typeof item === 'object'
      && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.evidence === 'string'
      && ['mes', 'human', 'decision'].includes(item.kind) && ['needed', 'requested', 'ready'].includes(item.status))) return false;
    if (!Array.isArray(task.checklist) || task.checklist.length > 60 || !task.checklist.every((item) => item && typeof item === 'object'
      && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.done === 'boolean')) return false;
    return Array.isArray(task.locations) && task.locations.length <= 30 && task.locations.every((item) => item && typeof item === 'object'
      && ['screen', 'code', 'doc'].includes(item.kind) && typeof item.url === 'string' && typeof item.label === 'string');
  };
  try {
    const value = JSON.parse(raw) as DevelopmentTaskRecovery;
    if (!value || value.schema !== 1 || value.user_id !== userId || value.username !== username || typeof value.saved_at !== 'number'
      || !Number.isFinite(value.saved_at) || now - value.saved_at > 24 * 60 * 60 * 1000 || value.saved_at - now > 60_000
      || typeof value.is_new !== 'boolean' || typeof value.change_note !== 'string' || !isTask(value.draft)) return null;
    if (value.slug !== value.draft.slug || value.base_version !== value.draft.version) return null;
    if (value.is_new ? value.original !== null || value.base_version !== 0 : !isTask(value.original) || value.base_version < 1
      || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(value.slug) || value.original.slug !== value.slug || value.original.version !== value.base_version) return null;
    const sanitized = (task: DevelopmentTask): DevelopmentTask => ({
      ...editableTaskFields(task), slug: task.slug, version: task.version,
      updated_at: task.updated_at, completed_at: task.completed_at,
    });
    return { ...value, draft: sanitized(value.draft), original: value.original ? sanitized(value.original) : null };
  } catch { return null; }
}

// Explicitly copy editable fields, including nested rows. Never echo response metadata to a mutation.
export function editableTaskFields(task: DevelopmentTask) {
  return {
    title: task.title, title_zh: task.title_zh, objective: task.objective,
    phase: task.phase, priority: task.priority, status: task.status, owner: task.owner,
    due_date: task.due_date || null, dependencies: [...task.dependencies],
    requirements: task.requirements.map(({ id, kind, text, status, evidence }) => ({ id, kind, text, status, evidence })),
    checklist: task.checklist.map(({ id, text, done }) => ({ id, text, done })),
    locations: task.locations.map(({ kind, url, label }) => ({ kind, url, label })),
    completion_note: task.completion_note, verification_note: task.verification_note,
    release_state: task.release_state, sort_order: task.sort_order,
  };
}

export function developmentTaskPayload(task: DevelopmentTask, isNew: boolean, changeNote: string) {
  return isNew
    ? { ...editableTaskFields(task), slug: task.slug }
    : { ...editableTaskFields(task), version: task.version, change_note: changeNote.trim() };
}

export function newDevelopmentTask(sortOrder: number): DevelopmentTask {
  return {
    slug: '', title: '', title_zh: '', objective: '', phase: 1, priority: 'P2', status: 'planned',
    owner: '', due_date: null, dependencies: [], requirements: [], checklist: [], locations: [],
    completion_note: '', verification_note: '', release_state: 'unreleased', sort_order: Math.min(10000, sortOrder),
    version: 0, updated_at: null, completed_at: null,
  };
}

export type CompletionIssue = 'checklist' | 'requirements' | 'owner' | 'completion_note' | 'verification_note' | 'locations' | 'dependencies';

export function developmentTaskCompletionIssues(task: DevelopmentTask, tasks: DevelopmentTask[]): CompletionIssue[] {
  const issues: CompletionIssue[] = [];
  if (!task.checklist.length || task.checklist.some((item) => item.done !== true)) issues.push('checklist');
  if (task.requirements.some((item) => item.status !== 'ready' || !item.evidence.trim())) issues.push('requirements');
  for (const field of ['owner', 'completion_note', 'verification_note'] as const) {
    if (!task[field].trim()) issues.push(field);
  }
  if (!task.locations.length || task.locations.some((item) => !item.label.trim() || !safeDevelopmentTaskUrl(item.url)
    || (item.kind === 'screen' && !item.url.startsWith('/')))) issues.push('locations');
  if (task.dependencies.some((slug) => slug === task.slug || !tasks.some((item) => item.slug === slug && item.status === 'done'))) issues.push('dependencies');
  return issues;
}

export function formatDevelopmentTaskError(error: unknown, fallback: string): { conflict: boolean; message: string } {
  const response = typeof error === 'object' && error !== null && 'response' in error
    ? (error as { response?: { status?: number; data?: unknown } }).response : undefined;
  const flatten = (value: unknown, path = '', depth = 0): string[] => {
    if (depth > 6) return [];
    if (typeof value === 'string') return value.trim() && !value.trim().startsWith('<') ? [`${path ? `${path}: ` : ''}${value}`] : [];
    if (Array.isArray(value)) return value.flatMap((item, index) => flatten(item, typeof item === 'string' ? path : `${path}[${index + 1}]`, depth + 1));
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => flatten(item, key === 'detail' || key === 'non_field_errors' ? path : path ? `${path}.${key}` : key, depth + 1));
    return [];
  };
  return { conflict: response?.status === 409, message: flatten(response?.data).slice(0, 12).join('\n') || fallback };
}

export function checklistProgress(task: Pick<DevelopmentTask, 'checklist'>) {
  const total = task.checklist.length;
  const done = task.checklist.filter((item) => item.done === true).length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

export function pendingHumanRequirements(task: Pick<DevelopmentTask, 'requirements'>) {
  return task.requirements.filter((requirement) => requirement.kind !== 'mes' && requirement.status !== 'ready');
}

export function filterDevelopmentTasks(tasks: DevelopmentTask[], filter: TaskFilter, search: string) {
  const needle = search.trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    const matchesFilter = filter === 'all'
      || (filter === 'active' && ['planned', 'in_progress', 'blocked'].includes(task.status))
      || (filter === 'human' && task.status !== 'done' && pendingHumanRequirements(task).length > 0)
      || task.status === filter;
    const searchable = [task.title, task.title_zh, task.objective, task.owner,
      ...task.requirements.map((requirement) => `${requirement.text} ${requirement.evidence}`)].join(' ').toLocaleLowerCase();
    return matchesFilter && (!needle || searchable.includes(needle));
  }).sort((left, right) => left.sort_order - right.sort_order || left.slug.localeCompare(right.slug));
}

export function nextDevelopmentTask(tasks: DevelopmentTask[]) {
  const ordered = filterDevelopmentTasks(tasks, 'all', '');
  const active = ordered.find((task) => task.status === 'in_progress');
  if (active) return active;
  const completed = new Set(tasks.filter((task) => task.status === 'done').map((task) => task.slug));
  return ordered.find((task) => task.status === 'planned'
    && task.dependencies.every((dependency) => completed.has(dependency))) ?? null;
}

/** Keep reference links navigable without accepting executable or ambiguous URLs. */
export function safeDevelopmentTaskUrl(value: string): string | null {
  if (!value || /[\s\\]/u.test(value) || [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
    || /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//')) {
    try {
      const parsed = new URL(value, 'https://development-task.invalid');
      return parsed.origin === 'https://development-task.invalid' ? value : null;
    } catch { return null; }
  }
  const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (!authority || authority.includes('@')) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password ? value : null;
  } catch { return null; }
}
