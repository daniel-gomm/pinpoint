import { h, api, toast, store } from './util.js';
import { connect, request, rememberPlayer } from './socket.js';

export function homeView(root) {
  const savedName = store.get('gg:name') ?? '';

  const joinForm = h('form', { class: 'panel join', onSubmit: join },
    h('h2', {}, 'Join a game'),
    h('p', { class: 'muted' }, 'Ask the host for the four-letter code.'),
    h('label', {}, 'Game code',
      h('input', { name: 'code', required: true, maxlength: 4, autocomplete: 'off', class: 'code-input', placeholder: 'ABCD' })),
    h('label', {}, 'Your name', h('input', { name: 'name', required: true, maxlength: 24, value: savedName })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Join game'),
  );

  let sets = [];
  const setSelect = h('select', { name: 'setId', required: true }, h('option', { value: '' }, 'Loading sets…'));
  const modeChoice = (value, title, text) => h('label', { class: 'mode-option' },
    h('input', { type: 'radio', name: 'mode', value, checked: value === 'location', onChange: updateMode }),
    h('strong', {}, title), h('span', {}, text));
  const scaleInput = h('input', { name: 'scale', type: 'number', min: 1, placeholder: 'Automatic' });
  const scaleLabel = h('span');
  const scaleHint = h('p', { class: 'hint' });
  const hostForm = h('form', { class: 'panel host', onSubmit: host },
    h('h2', {}, 'Host a game'),
    h('fieldset', { class: 'modes' },
      h('legend', {}, 'What do players guess?'),
      modeChoice('location', 'Place', 'Drop a pin where the picture was taken.'),
      modeChoice('date', 'Date', 'Pick the day and time it was taken.')),
    h('label', {}, 'Picture set', setSelect),
    h('div', { class: 'row' },
      h('label', {}, 'Rounds', h('input', { name: 'rounds', type: 'number', min: 1, max: 100, value: 5 })),
      h('label', {}, 'Seconds per round', h('input', { name: 'roundSeconds', type: 'number', min: 10, max: 600, step: 5, value: 60 })),
    ),
    h('details', {},
      h('summary', {}, 'Scoring'),
      h('label', {}, scaleLabel, scaleInput),
      scaleHint,
    ),
    h('label', {}, 'Your name', h('input', { name: 'name', required: true, maxlength: 24, value: savedName })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Create game'),
  );

  root.append(
    h('section', { class: 'home' },
      h('div', { class: 'home-intro' },
        h('h1', {}, 'Where was this picture taken? When?'),
        h('p', {}, 'Upload your own photos, mark where and when each was taken, and let friends guess the place on a map or the moment on a timeline. Closest guess wins the round.'),
      ),
      h('div', { class: 'home-panels' }, joinForm, hostForm),
    ),
  );

  function updateMode() {
    const date = new FormData(hostForm).get('mode') === 'date';
    scaleLabel.textContent = date ? 'Time span in days' : 'Map size in km';
    scaleInput.max = date ? 36500 : 20000;
    scaleHint.textContent = date
      ? 'A guess one tenth of the time span off earns about a third of the 5,000 points. ' +
        'Automatic uses the time between the oldest and newest picture in the set.'
      : 'A guess one tenth of the map size away earns about a third of the 5,000 points. ' +
        'Automatic uses the distance between the two farthest pictures in the set.';
    const count = (s) => (date ? s.datedCount : s.locatedCount);
    const playable = sets.filter((s) => count(s) > 0);
    const selected = setSelect.value;
    setSelect.replaceChildren(...(playable.length
      ? playable.map((s) => h('option', { value: s.id, selected: s.id === selected },
          `${s.name} (${count(s)} pictures with a ${date ? 'date' : 'location'})`))
      : [h('option', { value: '' }, `No sets with ${date ? 'dates' : 'locations'} yet`)]));
    const submit = hostForm.querySelector('button[type=submit]');
    if (submit) submit.disabled = !playable.length;
  }

  api('/api/sets').then((result) => {
    sets = result;
    if (!sets.length) {
      hostForm.querySelector('button[type=submit]').replaceWith(
        h('a', { class: 'btn primary', href: '#/sets' }, 'Create a picture set'));
    }
    updateMode();
  }).catch((err) => toast(err.message, 'error'));

  async function join(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    store.set('gg:name', data.name.trim());
    connect();
    const res = await request('game:join', { code: data.code.trim().toUpperCase(), name: data.name });
    if (res.error) return toast(res.error, 'error');
    rememberPlayer(res.code, res.playerId);
    location.hash = `#/game/${res.code}`;
  }

  async function host(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    store.set('gg:name', data.name.trim());
    connect();
    const res = await request('game:create', {
      ...data,
      rounds: Number(data.rounds),
      roundSeconds: Number(data.roundSeconds),
      // the server takes km for location and hours for date
      scale: data.scale ? Number(data.scale) * (data.mode === 'date' ? 24 : 1) : undefined,
    });
    if (res.error) return toast(res.error, 'error');
    rememberPlayer(res.code, res.playerId);
    location.hash = `#/game/${res.code}`;
  }
}
