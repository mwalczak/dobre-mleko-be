import { describe, expect, it } from 'vitest';
import { isOpenAt, monthStart, oldestVisitDate } from '../src/domain.js';

const TZ = 'Europe/Warsaw';

describe('monthStart', () => {
  it('uses the local month, not UTC', () => {
    // 23:30 UTC on 31 Oct is already 1 Nov in Warsaw (UTC+1 in winter).
    expect(monthStart(new Date('2026-10-31T23:30:00Z'), TZ)).toBe('2026-11-01');
    expect(monthStart(new Date('2026-10-31T22:30:00Z'), TZ)).toBe('2026-10-01');
  });
});

describe('oldestVisitDate', () => {
  it('is the same day a year ago, in the network’s time zone', () => {
    expect(oldestVisitDate(new Date('2026-10-11T12:00:00Z'), 'Europe/Warsaw')).toBe('2025-10-11');
    // 23:30 UTC on 31 December is already 1 January in Warsaw.
    expect(oldestVisitDate(new Date('2026-12-31T23:30:00Z'), 'Europe/Warsaw')).toBe('2026-01-01');
    expect(oldestVisitDate(new Date('2028-02-29T12:00:00Z'), 'Europe/Warsaw')).toBe('2027-02-28');
  });
});

describe('isOpenAt', () => {
  // Thursday jazz from 21:00, Friday techno until morning.
  const hours = [
    { day: 4, open: '18:00', close: '02:00' },
    { day: 5, open: '18:00', close: '06:00' },
  ];

  it('is open in the evening', () => {
    expect(isOpenAt(hours, new Date('2026-10-15T19:00:00+02:00'), TZ)).toBe(true); // Thu 19:00
  });

  it('stays open past midnight into the next day', () => {
    expect(isOpenAt(hours, new Date('2026-10-16T01:30:00+02:00'), TZ)).toBe(true); // Fri 01:30
    expect(isOpenAt(hours, new Date('2026-10-16T02:30:00+02:00'), TZ)).toBe(false); // Fri 02:30
  });

  it('is closed outside the hours', () => {
    expect(isOpenAt(hours, new Date('2026-10-15T12:00:00+02:00'), TZ)).toBe(false); // Thu noon
    expect(isOpenAt(hours, new Date('2026-10-13T20:00:00+02:00'), TZ)).toBe(false); // Tue
  });
});
