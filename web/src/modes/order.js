import Sortable from 'sortablejs';
import { h, lightbox } from '../util.js';
import { formatAt } from '../time.js';

const range = (n) => Array.from({ length: n }, (_, i) => i);

/** @type {import('./index.js').ModeUI} */
export default {
  title: 'Put the pictures in order',
  emptyPrompt: 'Lock in this order',
  showsPhotos: true,
  // Every arrangement is a valid answer, so the starting order can be locked in as is.
  initialGuess: (state) => ({ order: range(state.setup.size) }),

  createPicker(el, { state, initial, onPick }) {
    el.classList.add('order-pane');
    const urls = state.round.imageUrls;
    let order = initial?.order ?? range(urls.length);
    let locked = false;

    const list = h('ol', { class: 'order-list' });
    el.append(h('p', { class: 'order-hint' }, 'Drag the pictures from earliest (left) to latest (right).'), list);

    const move = (from, to) => {
      if (locked || to < 0 || to >= order.length) return;
      const next = [...order];
      const [slot] = next.splice(from, 1);
      next.splice(to, 0, slot);
      order = next;
      render();
      onPick({ order });
    };

    function render() {
      list.replaceChildren(...order.map((slot, pos) => h('li', { class: 'order-card', 'data-slot': slot },
        h('span', { class: 'order-pos' }, String(pos + 1)),
        h('img', { src: urls[slot], alt: `Picture ${slot + 1}`, draggable: 'false' }),
        h('div', { class: 'order-actions' },
          h('button', { type: 'button', class: 'btn subtle', 'aria-label': 'Move earlier', disabled: locked || pos === 0, onClick: () => move(pos, pos - 1) }, '←'),
          h('button', { type: 'button', class: 'btn subtle', 'aria-label': 'Enlarge picture', onClick: () => lightbox(urls[slot]) }, 'Enlarge'),
          h('button', { type: 'button', class: 'btn subtle', 'aria-label': 'Move later', disabled: locked || pos === order.length - 1, onClick: () => move(pos, pos + 1) }, '→')),
      )));
    }
    render();

    const sortable = Sortable.create(list, {
      animation: 150,
      filter: 'button',
      preventOnFilter: false,
      onEnd: (e) => {
        // Let Sortable's DOM move stand only long enough to read it; render() rebuilds from `order`.
        if (e.oldIndex !== e.newIndex) move(/** @type {number} */ (e.oldIndex), /** @type {number} */ (e.newIndex));
      },
    });

    return {
      setLocked(value) {
        locked = value;
        sortable.option('disabled', value);
        el.classList.toggle('locked', value);
        render();
      },
      destroy: () => sortable.destroy(),
    };
  },

  renderAnswer(el, result, { colorOf }) {
    el.className = 'panel order-answer';
    const { order, pictures } = result.answer;
    const truePos = new Map(order.map((slot, pos) => [slot, pos]));
    el.replaceChildren(
      h('h2', {}, 'Correct order'),
      h('ol', { class: 'order-strip' }, order.map((slot) => h('li', {},
        h('img', { src: result.imageUrls[slot], alt: pictures[slot].caption || `Picture ${slot + 1}`, onClick: () => lightbox(result.imageUrls[slot]) }),
        h('strong', {}, formatAt(pictures[slot].time, 'day')),
        pictures[slot].caption ? h('span', { class: 'muted' }, pictures[slot].caption) : null))),
      h('div', { class: 'order-rows' }, result.guesses.filter((g) => !g.sitOut).map((g) => h('div', { class: 'order-row' },
        h('span', { class: 'name' }, h('span', { class: 'swatch', style: { background: colorOf(g.playerId) } }), g.name),
        g.guess
          ? h('ol', { class: 'order-mini' }, /** @type {{order: number[]}} */ (g.guess).order.map((slot, pos) => h('li', {
            class: truePos.get(slot) === pos ? 'right' : '', title: `Belongs at position ${(truePos.get(slot) ?? 0) + 1}`,
          }, h('img', { src: result.imageUrls[slot], alt: '' }), h('span', {}, String((truePos.get(slot) ?? 0) + 1)))))
          : h('span', { class: 'muted' }, 'No guess')))),
    );
    return () => {};
  },

  formatOff(distance) {
    if (distance === null || distance === undefined) return 'No guess';
    if (distance === 0) return 'Perfect order';
    return `${distance} pair${distance === 1 ? '' : 's'} swapped`;
  },
};
