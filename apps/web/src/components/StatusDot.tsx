import { STATUS_LABEL } from '../lib/labels';

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot dot-${status}`} aria-hidden />;
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`pill pill-${status}`}>
      <StatusDot status={status} /> {STATUS_LABEL[status] ?? status}
    </span>
  );
}
