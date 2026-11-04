import { t } from './i18n';

/** Plain-language labels shared across the UI (the audience includes non-developers), translated at load. */
const tr = <T extends Record<string, string>>(m: T) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, t(v)])) as T;
export const PHASES = [
  { id: 'understanding', label: t('Understanding') },
  { id: 'planning', label: t('Planning') },
  { id: 'implementing', label: t('Building') },
  { id: 'testing', label: t('Testing') },
  { id: 'deploying', label: t('Preview') },
  { id: 'reviewing', label: t('Review') },
  { id: 'done', label: t('Done') },
] as const;

export const phaseLabel = (id?: string | null) => PHASES.find((p) => p.id === id)?.label ?? (id === 'blocked' ? t('Waiting for you') : (id ?? ''));

export const STATUS_LABEL: Record<string, string> = tr({
  provisioning: 'Setting up',
  ready: 'Ready',
  queued: 'Waiting for a free agent',
  running: 'Working',
  idle: 'Ready for feedback',
  error: 'Needs attention',
  archived: 'Archived',
});

export const ENV_STATUS_LABEL: Record<string, string> = tr({
  building: 'Preparing',
  deploying: 'Starting',
  ready: 'Live',
  failed: 'Failed',
  deleted: 'Removed',
});

export const PR_STATUS_LABEL: Record<string, string> = tr({
  active: 'Waiting for approval',
  completed: 'Approved & merged',
  abandoned: 'Closed',
});
