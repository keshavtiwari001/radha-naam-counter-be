const IST_OFFSET_MS = 330 * 60 * 1000;

// India has no daylight saving. Shift once, then use UTC methods so the host
// timezone cannot change the result. The week key is its Monday's ISO date.
export function istPeriods(at = new Date()) {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new TypeError('A valid date is required');
  }
  const local = new Date(at.getTime() + IST_OFFSET_MS);
  const day = local.toISOString().slice(0, 10);
  const monday = new Date(local);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return { day, week: monday.toISOString().slice(0, 10), month: day.slice(0, 7) };
}
