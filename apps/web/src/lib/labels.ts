/** Plain-language labels shared across the UI (the audience includes non-developers). */
export const PHASES = [
  { id: 'understanding', label: 'Understanding' },
  { id: 'planning', label: 'Planning' },
  { id: 'implementing', label: 'Building' },
  { id: 'testing', label: 'Testing' },
  { id: 'deploying', label: 'Preview' },
  { id: 'reviewing', label: 'Review' },
  { id: 'done', label: 'Done' },
] as const;

export const phaseLabel = (id?: string | null) => PHASES.find((p) => p.id === id)?.label ?? (id === 'blocked' ? 'Waiting for you' : id ?? '');

export const STATUS_LABEL: Record<string, string> = {
  provisioning: 'Setting up',
  ready: 'Ready',
  running: 'Working',
  idle: 'Ready for feedback',
  error: 'Needs attention',
};

export const ENV_STATUS_LABEL: Record<string, string> = {
  building: 'Preparing',
  deploying: 'Starting',
  ready: 'Live',
  failed: 'Failed',
  deleted: 'Removed',
};

export const PR_STATUS_LABEL: Record<string, string> = {
  active: 'Waiting for approval',
  completed: 'Approved & merged',
  abandoned: 'Closed',
};
