/** The categories migration 007 created; admins can add more. The development fixtures use these. */
export const DEFAULT_CATEGORIES = [
  'food',
  'coffee',
  'bar',
  'club',
  'kids',
  'culture',
  'nature',
  'sport',
  'shopping',
  'hotel',
  'other',
] as const;
export type DefaultCategory = (typeof DEFAULT_CATEGORIES)[number];
/** A category id (the categories table). */
export type Category = string;

export const CRITERIA = [
  { key: 'vibe', label: 'Klimat', required: true },
  { key: 'offer', label: 'Oferta', required: true },
  { key: 'service', label: 'Obsługa', required: false },
  { key: 'value', label: 'Wartość', required: false },
] as const;
export type CriterionKey = (typeof CRITERIA)[number]['key'];

/** Weight of the prior in the ranking score: a place needs a few ratings before it beats the network average. */
export const RANKING_PRIOR_WEIGHT = 3;

/** One opening interval. day: 0 = Sunday … 6 = Saturday. close earlier than open means it closes after midnight. */
export interface OpeningPeriod {
  day: number;
  open: string;
  close: string;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    year: get('year'),
    month: get('month'),
    weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** Today's date in the given time zone, as YYYY-MM-DD (visit dates may not be later). */
export function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** The oldest visit date accepted: the same day a year ago (29 February → 28 February), as YYYY-MM-DD. */
export function oldestVisitDate(date: Date, timeZone: string): string {
  const [year, month, day] = localDate(date, timeZone).split('-');
  return `${Number(year) - 1}-${month}-${month === '02' && day === '29' ? '28' : day}`;
}

/** First day of the current month in the given time zone, as YYYY-MM-DD. Stars are counted per such month. */
export function monthStart(date: Date, timeZone: string): string {
  const { year, month } = zonedParts(date, timeZone);
  return `${year}-${month}-01`;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

export function isOpenAt(periods: OpeningPeriod[], date: Date, timeZone: string): boolean {
  const { weekday, minutes } = zonedParts(date, timeZone);
  const yesterday = (weekday + 6) % 7;
  return periods.some((p) => {
    const open = toMinutes(p.open);
    const close = toMinutes(p.close);
    const overnight = close <= open;
    if (p.day === weekday) return minutes >= open && (overnight || minutes < close);
    if (p.day === yesterday && overnight) return minutes < close;
    return false;
  });
}
