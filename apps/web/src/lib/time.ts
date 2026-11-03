const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** SQLite `datetime('now')` values are UTC without a zone marker. */
export function parseDate(s: string) {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

export function timeAgo(s?: string | null) {
  if (!s) return '';
  const secs = (parseDate(s).getTime() - Date.now()) / 1000;
  const abs = Math.abs(secs);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(secs / 86400), 'day');
  return parseDate(s).toLocaleDateString();
}
