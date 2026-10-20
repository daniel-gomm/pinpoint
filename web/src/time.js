// Photo times are wall-clock times without a timezone. They travel as ms since epoch and are
// always formatted in UTC so every viewer sees the same clock time.
import { h } from './util.js';

/** @typedef {import('../../shared/protocol.js').Precision} Precision */

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const SLOT = 15 * MINUTE;
const PERIOD_HOURS = { day: 24, month: 730.5, year: 8766 };

const fmt = (opts) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts });
const FORMATS = {
  day: fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
  month: fmt({ month: 'long', year: 'numeric' }),
  year: fmt({ year: 'numeric' }),
};
const clock = fmt({ hour: '2-digit', minute: '2-digit' });

export const formatClock = (ms) => clock.format(ms);
/** A moment shown as precisely as the game asks for. */
export function formatAt(ms, precision = 'minute') {
  if (precision === 'minute') return `${FORMATS.day.format(ms)}, ${clock.format(ms)}`;
  return FORMATS[precision].format(ms);
}

export const toTakenAt = (ms) => new Date(ms).toISOString().slice(0, 16);

/** How far off a date guess was, in the unit of the game's precision. */
export function formatDateOff(hours, precision = 'minute') {
  if (hours === null || hours === undefined) return 'No guess';
  if (precision !== 'minute') {
    const n = Math.round(hours / PERIOD_HOURS[precision]);
    return n === 0 ? `Right ${precision}` : `${n} ${precision}${n === 1 ? '' : 's'}`;
  }
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

// ---------- calendar units ----------
// The picker moves in whole periods; 'minute' precision picks a day plus a 15-minute slot.

const unitOf = (precision) => (precision === 'minute' ? 'day' : precision);
function periodIndex(ms, unit) {
  const d = new Date(ms);
  if (unit === 'year') return d.getUTCFullYear();
  if (unit === 'month') return d.getUTCFullYear() * 12 + d.getUTCMonth();
  return Math.floor(ms / DAY);
}
function periodStart(index, unit) {
  if (unit === 'year') return Date.UTC(index, 0, 1);
  if (unit === 'month') return Date.UTC(Math.floor(index / 12), index % 12, 1);
  return index * DAY;
}

// ---------- axis ----------

/** @type {Array<['hour' | 'day' | 'month' | 'year', number]>} */
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
  const [unit, n] = STEPS.find(([u, k]) => (end - start) / (APPROX[u] * k) <= max) ?? STEPS[STEPS.length - 1];
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

// ---------- picker ----------

/** @type {Record<Precision, Array<['day' | 'month' | 'year', number]>>} */
const STEPPERS = {
  minute: [['year', 1], ['month', 1], ['day', 1]],
  day: [['year', 1], ['month', 1], ['day', 1]],
  month: [['year', 1], ['month', 1]],
  year: [['year', 10], ['year', 1]],
};

/**
 * Slider over the game's timeline in steps of the precision, plus steppers, an exact input and
 * (for 'minute' precision) a time-of-day slider. Stays empty until the player touches it, so an
 * untouched picker never counts as a guess.
 * @param {HTMLElement} container
 * @param {{range: {start: number, end: number}, precision: Precision, initial?: number, onChange: (ms: number) => void}} opts
 */
export function createDatePicker(container, { range, precision, initial, onChange }) {
  const unit = unitOf(precision);
  const first = periodIndex(range.start, unit);
  const count = Math.max(1, periodIndex(range.end - 1, unit) - first + 1);
  let index = null; // offset from `first`, null until touched
  let slot = 48; // 12:00
  let locked = false;

  const display = h('output', { class: 'dp-display' });
  const slider = h('input', { type: 'range', min: 0, max: count - 1, step: 1, value: Math.floor(count / 2), class: 'dp-day', 'aria-label': 'Date' });
  const exact = precision === 'year'
    ? h('input', { type: 'number', class: 'dp-date', 'aria-label': 'Year', min: first, max: first + count - 1 })
    : h('input', {
      type: precision === 'month' ? 'month' : 'date', class: 'dp-date', 'aria-label': 'Exact date',
      min: toInput(periodStart(first, unit)), max: toInput(periodStart(first + count - 1, unit)),
    });
  const timeSlider = h('input', { type: 'range', min: 0, max: 95, step: 1, value: slot, class: 'dp-time', 'aria-label': 'Time of day' });
  const timeLabel = h('output', { class: 'dp-clock' });

  function toInput(ms) {
    if (precision === 'year') return String(new Date(ms).getUTCFullYear());
    return toTakenAt(ms).slice(0, precision === 'month' ? 7 : 10);
  }
  function fromInput(value) {
    if (precision === 'year') return Date.UTC(Number(value), 0, 1);
    return Date.parse(precision === 'month' ? `${value}-01T00:00:00Z` : `${value}T00:00:00Z`);
  }

  const shift = (stepUnit, n) => () => {
    const d = new Date(periodStart(first + (index ?? Number(slider.value)), unit));
    if (stepUnit === 'year') d.setUTCFullYear(d.getUTCFullYear() + n);
    else if (stepUnit === 'month') d.setUTCMonth(d.getUTCMonth() + n);
    else d.setUTCDate(d.getUTCDate() + n);
    setIndex(periodIndex(d.getTime(), unit) - first);
    emit();
  };
  const stepButtons = (sign) => STEPPERS[precision].map(([u, n]) => h('button', {
    type: 'button', class: 'btn subtle dp-step', onClick: shift(u, sign * n), 'aria-label': `${sign > 0 ? 'Forward' : 'Back'} ${n} ${u}${n > 1 ? 's' : ''}`,
  }, `${sign > 0 ? '+' : '−'}${n} ${u}${n > 1 ? 's' : ''}`));

  const root = h('div', { class: 'datepicker' },
    display,
    h('div', { class: 'dp-track' }, slider, axis(range.start, range.end, 6)),
    // outermost steps on the outside: −1 year −1 month [date] +1 month +1 year
    h('div', { class: 'dp-fine' }, exact, ...stepButtons(-1), ...stepButtons(1).reverse()),
    precision === 'minute' ? h('div', { class: 'dp-timerow' },
      h('span', { class: 'dp-timelabel' }, 'Time of day'), timeLabel,
      h('div', { class: 'dp-track' }, timeSlider,
        h('div', { class: 'tl-axis', 'aria-hidden': 'true' },
          ['00:00', '06:00', '12:00', '18:00', '24:00'].map((l, i) => h('span', { style: { left: `${i * 25}%` } }, l))))) : null,
  );
  container.append(root);

  function setIndex(value) {
    index = Math.min(count - 1, Math.max(0, value));
    slider.value = String(index);
    exact.value = toInput(periodStart(first + index, unit));
  }
  const value = () => {
    if (index === null) return null;
    const startMs = periodStart(first + index, unit);
    return precision === 'minute' ? startMs + slot * SLOT : startMs;
  };

  function render() {
    const v = value();
    timeLabel.textContent = formatClock(slot * SLOT);
    display.textContent = v === null ? 'Drag the slider to pick a date' : formatAt(periodStart(first + index, unit), unit === 'day' ? 'day' : unit);
    display.classList.toggle('empty', v === null);
    root.classList.toggle('untouched', v === null);
  }
  function emit() {
    render();
    const v = value();
    if (!locked && v !== null) onChange(v);
  }

  slider.addEventListener('input', () => { setIndex(Number(slider.value)); emit(); });
  exact.addEventListener('change', () => {
    const t = fromInput(exact.value);
    if (Number.isFinite(t)) setIndex(periodIndex(t, unit) - first);
    emit();
  });
  timeSlider.addEventListener('input', () => {
    slot = Number(timeSlider.value);
    if (index === null) setIndex(Number(slider.value));
    emit();
  });

  if (Number.isFinite(initial)) {
    setIndex(periodIndex(initial, unit) - first);
    if (precision === 'minute') {
      slot = Math.round((initial - periodStart(periodIndex(initial, 'day'), 'day')) / SLOT);
      timeSlider.value = String(slot);
    }
  }
  render();

  return {
    setLocked(value) {
      locked = value;
      for (const el of root.querySelectorAll('input, button')) /** @type {HTMLInputElement} */ (el).disabled = value;
    },
    destroy() {},
  };
}

// ---------- reveal ----------

/**
 * Lanes per player on a shared time axis, with the true time as a red line.
 * @param {HTMLElement} container
 * @param {{answer: {time: number}, guesses: import('../../shared/protocol.js').ResultEntry[],
 *   colorOf: (id: string) => string, precision: Precision, formatOff: (d: number | null) => string}} opts
 */
export function renderTimeline(container, { answer, guesses, colorOf, precision, formatOff }) {
  const playing = guesses.filter((g) => !g.sitOut);
  const timeOf = (g) => /** @type {import('../../shared/protocol.js').DateGuess} */ (g.guess).time;
  const times = [answer.time, ...playing.filter((g) => g.guess).map(timeOf)];
  let lo = Math.min(...times);
  let hi = Math.max(...times);
  const minSpan = precision === 'minute' ? 2 * HOUR : 2 * PERIOD_HOURS[precision] * HOUR;
  if (hi - lo < minSpan) { lo -= minSpan / 2; hi += minSpan / 2; }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const pct = (t) => `${((t - lo) / (hi - lo)) * 100}%`;
  // The answer line and label span all lanes, so they are offset past the name column.
  const acrossLanes = `calc(var(--tl-name) + (100% - var(--tl-name)) * ${(answer.time - lo) / (hi - lo)})`;
  const ax = pct(answer.time);

  container.append(h('div', { class: 'timeline' },
    h('div', { class: 'tl-answer-label', style: { left: acrossLanes } }, formatAt(answer.time, precision)),
    h('div', { class: 'tl-lanes' },
      h('div', { class: 'tl-answer', style: { left: acrossLanes } }),
      playing.map((g) => h('div', { class: 'tl-lane' },
        h('span', { class: 'tl-name' }, g.name),
        h('div', { class: 'tl-track' },
          g.guess ? [
            h('span', { class: 'tl-span', style: {
              left: `min(${pct(timeOf(g))}, ${ax})`, right: `calc(100% - max(${pct(timeOf(g))}, ${ax}))`,
              borderColor: colorOf(g.playerId),
            } }),
            h('span', { class: 'tl-dot', style: { left: pct(timeOf(g)), background: colorOf(g.playerId) },
              title: `${g.name}: ${formatAt(timeOf(g), precision)} (${formatOff(g.distance)})` }),
          ] : h('span', { class: 'muted tl-none' }, 'No guess'))))),
    h('div', { class: 'tl-axis-row' }, h('span'), axis(lo, hi, 6)),
  ));
}
