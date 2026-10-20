import { h } from '../util.js';
import { createDatePicker, renderTimeline, formatAt, formatDateOff } from '../time.js';

/** @type {import('./index.js').ModeUI} */
export default {
  title: 'Guess the date',
  emptyPrompt: 'Pick a date',
  showsPhotos: false,

  createPicker(el, { state, initial, onPick }) {
    el.classList.add('date-pane');
    return createDatePicker(el, {
      range: state.setup.range,
      precision: state.setup.precision,
      initial: initial?.time,
      onChange: (time) => onPick({ time }),
    });
  },

  renderAnswer(el, result, { state, colorOf }) {
    el.className = 'panel reveal-timeline';
    el.replaceChildren();
    renderTimeline(el, {
      answer: result.answer,
      guesses: result.guesses,
      colorOf,
      precision: state.setup.precision,
      formatOff: (d) => this.formatOff(d, state),
    });
    return () => {};
  },

  formatOff: (distance, state) => formatDateOff(distance, state.setup?.precision),

  answerNote: (result, state) => h('p', { class: 'taken-at' }, `Taken ${formatAt(result.answer.time, state.setup.precision)}`),
};
