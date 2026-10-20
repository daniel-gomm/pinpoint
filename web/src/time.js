// Photo times are wall-clock times without a timezone. They travel as ms since epoch and are
// always formatted in UTC so every viewer sees the same clock time.
import { h } from './util.js';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const SLOT = 15 * MINUTE;

const fmt = (opts) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts });
const longDate = fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const clock = fmt({ hour: '2-digit', minute: '2-digit' });

export const formatDay = (ms) => longDate.format(ms);
export const formatClock = (ms) => clock.format(ms);
export const formatTakenAt = (ms) => `${formatDay(ms)}, ${formatClock(ms)}`;

/** "2024-07-14T15:30" <-> ms */
export const parseTakenAt = (value) => (value ? Date.parse(`${value}:00Z`) : NaN);
export const toTakenAt = (ms) => new Date(ms).toISOString().slice(0, 16);

export function formatDuration(hours) {
  if (hours === null || hours === undefined) return 'No guess';
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${mins} min`;
  if (hours < 48) {
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    return mm ? `${hh} h ${mm} min` : `${hh} h`;
  }
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${Math.round(days / 30.44)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

const STEPS = [
  ['hour', 1], ['hour', 3], ['hour', 6], ['hour', 12], ['day', 1], ['day', 2], ['day', 7],
  ['month', 1], ['month', 3], ['month', 6], ['year', 1], ['year', 2], ['year', 5],
  ['year', 10], ['year', 25], ['year', 50], ['year', 100],
];
const APPROX = { hour: HOUR, day: DAY, month: 30.44 * DAY, year: 365.25 * DAY };
const LABEL = {
  hour: fmt({ hour: '2-digit', minute: '2-digit' }),
  day: fmt({ day: 'numeric', month: 'short' }),
  month: fmt({ month: 'short', year: 'numeric' }),
};

/** Calendar-aligned axis ticks between start and end, at most roughly `max` of them. */
export function timeTicks(start, end, max = 7) {
  const [unit, n] = STEPS.find(([u, k]) => (end - start) / (APPROX[u] * k) <= max) ?? STEPS.at(-1);
  const d = new Date(start);
  d.setUTCMinutes(0, 0, 0);
  if (unit === 'hour') d.setUTCHours(Math.floor(d.getUTCHours() / n) * n);
  else d.setUTCHours(0);
  if (unit === 'month' || unit === 'year') d.setUTCDate(1);
  if (unit === 'month') d.setUTCMonth(Math.floor(d.getUTCMonth() / n) * n);
  if (unit === 'year') d.setUTCFullYear(Math.floor(d.getUTCFullYear() / n) * n, 0, 1);

  const ticks = [];
  while (d.getTime() <= end && ticks.length < 60) {
    const t = d.getTime();
    if (t >= start) {
      const label = unit === 'year' ? String(d.getUTCFullYear())
        : unit === 'hour' && d.getUTCHours() === 0 ? LABEL.day.format(t)
        : LABEL[unit].format(t);
      ticks.push({ t, label });
    }
    if (unit === 'hour') d.setUTCHours(d.getUTCHours() + n);
    else if (unit === 'day') d.setUTCDate(d.getUTCDate() + n);
    else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + n);
    else d.setUTCFullYear(d.getUTCFullYear() + n);
  }
  return ticks;
}

function axis(start, end, max) {
  const pct = (t) => ((t - start) / (end - start)) * 100;
  return h('div', { class: 'tl-axis', 'aria-hidden': 'true' },
    timeTicks(start, end, max).map(({ t, label }) => h('span', { style: { left: `${pct(t)}%` } }, label)));
}

/**
 * Day slider across the game's range, plus steppers and a time-of-day slider.
 * Stays empty until the player touches it, so an untouched picker never counts as a guess.
 */
export function createDatePicker(container, { range, initial, onChange }) {
  const days = Math.max(1, Math.round((range.end - range.start) / DAY));
  let day = null;
  let slot = 48; // 12:00
  let locked = false;

  const display = h('output', { class: 'dp-display' });
  const daySlider = h('input', { type: 'range', min: 0, max: days - 1, step: 1, value: Math.floor(days / 2), class: 'dp-day', 'aria-label': 'Date' });
  const dateInput = h('input', {
    type: 'date', class: 'dp-date', 'aria-label': 'Exact date',
    min: toTakenAt(range.start).slice(0, 10), max: toTakenAt(range.start + (days - 1) * DAY).slice(0, 10),
  });
  const timeSlider = h('input', { type: 'range', min: 0, max: 95, step: 1, value: slot, class: 'dp-time', 'aria-label': 'Time of day' });
  const timeLabel = h('output', { class: 'dp-clock' });

  const shift = (unit, n) => () => {
    const d = new Date(range.start + (day ?? Number(daySlider.value)) * DAY);
    if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() + n);
    else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + n);
    else d.setUTCDate(d.getUTCDate() + n);
    setDay(Math.round((d.getTime() - range.start) / DAY));
    emit();
  };
  const stepper = (label, unit, n) =>
    h('button', { type: 'button', class: 'btn subtle dp-step', onClick: shift(unit, n), 'aria-label': `${n > 0 ? 'Forward' : 'Back'} one ${unit}` }, label);

  container.append(h('div', { class: 'datepicker' },
    display,
    h('div', { class: 'dp-track' }, daySlider, axis(range.start, range.end, 6)),
    h('div', { class: 'dp-fine' },
      stepper('−1 year', 'year', -1), stepper('−1 month', 'month', -1), stepper('−1 day', 'day', -1),
      dateInput,
      stepper('+1 day', 'day', 1), stepper('+1 month', 'month', 1), stepper('+1 year', 'year', 1)),
    h('div', { class: 'dp-timerow' },
      h('span', { class: 'dp-timelabel' }, 'Time of day'), timeLabel,
      h('div', { class: 'dp-track' }, timeSlider,
        h('div', { class: 'tl-axis', 'aria-hidden': 'true' },
          ['00:00', '06:00', '12:00', '18:00', '24:00'].map((l, i) => h('span', { style: { left: `${i * 25}%` } }, l))))),
  ));

  function setDay(value) {
    day = Math.min(days - 1, Math.max(0, value));
    daySlider.value = day;
    dateInput.value = toTakenAt(range.start + day * DAY).slice(0, 10);
  }
  const value = () => (day === null ? null : range.start + day * DAY + slot * SLOT);

  function render() {
    const v = value();
    timeLabel.textContent = formatClock(slot * SLOT);
    display.textContent = v === null ? 'Drag the slider to pick a date' : formatDay(v);
    display.classList.toggle('empty', v === null);
    container.querySelector('.datepicker').classList.toggle('untouched', v === null);
  }
  function emit() {
    render();
    if (!locked && day !== null) onChange(value());
  }

  daySlider.addEventListener('input', () => { setDay(Number(daySlider.value)); emit(); });
  dateInput.addEventListener('change', () => {
    const t = Date.parse(`${dateInput.value}T00:00:00Z`);
    if (Number.isFinite(t)) setDay(Math.round((t - range.start) / DAY));
    emit();
  });
  timeSlider.addEventListener('input', () => {
    slot = Number(timeSlider.value);
    if (day === null) setDay(Number(daySlider.value));
    emit();
  });

  if (Number.isFinite(initial)) {
    setDay(Math.floor((initial - range.start) / DAY));
    slot = Math.round(((initial - range.start) % DAY) / SLOT);
    timeSlider.value = slot;
  }
  render();

  return {
    setLocked(value) {
      locked = value;
      for (const el of container.querySelectorAll('input, button')) el.disabled = value;
    },
    destroy() {},
  };
}

/** Lanes per player on a shared time axis, with the true time as a red line. */
export function renderTimeline(container, { answer, guesses, colorOf }) {
  const times = [answer.time, ...guesses.filter((g) => g.guess).map((g) => g.guess.time)];
  let lo = Math.min(...times);
  let hi = Math.max(...times);
  if (hi - lo < 2 * HOUR) { lo -= HOUR; hi += HOUR; }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const pct = (t) => `${((t - lo) / (hi - lo)) * 100}%`;
  // The answer line and label span all lanes, so they are offset past the name column.
  const acrossLanes = `calc(var(--tl-name) + (100% - var(--tl-name)) * ${(answer.time - lo) / (hi - lo)})`;
  const ax = pct(answer.time);

  container.append(h('div', { class: 'timeline' },
    h('div', { class: 'tl-answer-label', style: { left: acrossLanes } }, formatTakenAt(answer.time)),
    h('div', { class: 'tl-lanes' },
      h('div', { class: 'tl-answer', style: { left: acrossLanes } }),
      guesses.map((g) => h('div', { class: 'tl-lane' },
        h('span', { class: 'tl-name' }, g.name),
        h('div', { class: 'tl-track' },
          g.guess ? [
            h('span', { class: 'tl-span', style: {
              left: `min(${pct(g.guess.time)}, ${ax})`, right: `calc(100% - max(${pct(g.guess.time)}, ${ax}))`,
              borderColor: colorOf(g.playerId),
            } }),
            h('span', { class: 'tl-dot', style: { left: pct(g.guess.time), background: colorOf(g.playerId) },
              title: `${g.name}: ${formatTakenAt(g.guess.time)}` }),
          ] : h('span', { class: 'muted tl-none' }, 'No guess'))))),
    h('div', { class: 'tl-axis-row' }, h('span'), axis(lo, hi, 6)),
  ));
}
