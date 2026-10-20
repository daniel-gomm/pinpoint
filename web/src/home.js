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

  const setSelect = h('select', { name: 'setId', required: true }, h('option', { value: '' }, 'Loading sets…'));
  const hostForm = h('form', { class: 'panel host', onSubmit: host },
    h('h2', {}, 'Host a game'),
    h('p', { class: 'muted' }, 'Pick one of your picture sets. Everyone guesses where each picture was taken.'),
    h('label', {}, 'Picture set', setSelect),
    h('div', { class: 'row' },
      h('label', {}, 'Rounds', h('input', { name: 'rounds', type: 'number', min: 1, max: 100, value: 5 })),
      h('label', {}, 'Seconds per round', h('input', { name: 'roundSeconds', type: 'number', min: 10, max: 600, step: 5, value: 60 })),
    ),
    h('details', {},
      h('summary', {}, 'Scoring'),
      h('label', {}, 'Map size in km',
        h('input', { name: 'scaleKm', type: 'number', min: 1, max: 20000, placeholder: 'Automatic' })),
      h('p', { class: 'hint' },
        'A guess one tenth of the map size away earns about a third of the 5,000 points. ' +
        'Automatic uses the distance between the two farthest pictures in the set.'),
    ),
    h('label', {}, 'Your name', h('input', { name: 'name', required: true, maxlength: 24, value: savedName })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Create game'),
  );

  root.append(
    h('section', { class: 'home' },
      h('div', { class: 'home-intro' },
        h('h1', {}, 'Where was this picture taken?'),
        h('p', {}, 'Upload your own photos, mark where each was taken, and let friends drop their guesses on the map. Closest pin wins the round.'),
      ),
      h('div', { class: 'home-panels' }, joinForm, hostForm),
    ),
  );

  api('/api/sets').then((sets) => {
    const playable = sets.filter((s) => s.locatedCount > 0);
    setSelect.replaceChildren(
      ...(playable.length
        ? playable.map((s) => h('option', { value: s.id }, `${s.name} (${s.locatedCount} pictures)`))
        : [h('option', { value: '' }, 'No playable sets yet')]),
    );
    if (!playable.length) {
      hostForm.querySelector('button[type=submit]').replaceWith(
        h('a', { class: 'btn primary', href: '#/sets' }, 'Create a picture set'));
    }
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
      scaleKm: data.scaleKm ? Number(data.scaleKm) : undefined,
    });
    if (res.error) return toast(res.error, 'error');
    rememberPlayer(res.code, res.playerId);
    location.hash = `#/game/${res.code}`;
  }
}
