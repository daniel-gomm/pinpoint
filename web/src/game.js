import { h, api, toast, store, formatDistance, formatPoints, playerColor } from './util.js';
import { connect, request, rememberPlayer, rememberedPlayer, forgetPlayer } from './socket.js';
import { createMap, pinIcon, dotIcon, nearLng, escapeHtml, L } from './map.js';

const URGENT_SECONDS = 15;
const isLocalhost = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/** Origin other players should use. Falls back to the current origin unless that is localhost. */
async function inviteOrigin() {
  try {
    const { publicUrl, lanAddresses } = await api('/api/info');
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    if (!isLocalhost()) return location.origin;
    if (lanAddresses[0]) return `${location.protocol}//${lanAddresses[0]}${location.port ? `:${location.port}` : ''}`;
  } catch { /* keep the current origin */ }
  return isLocalhost() ? null : location.origin;
}

export function gameView(root, codeParam) {
  const code = codeParam.toUpperCase();
  const socket = connect();
  let state = null;
  let layoutKey = null;
  let clockOffset = 0;
  let teardown = [];
  let ui = {};

  const me = () => state.players.find((p) => p.id === state.you);
  const isHost = () => state.hostId === state.you;
  const serverNow = () => Date.now() + clockOffset;
  const colorOf = (playerId) => {
    const order = [...state.players].sort((a, b) => a.id.localeCompare(b.id));
    return playerColor(Math.max(0, order.findIndex((p) => p.id === playerId)));
  };

  socket.on('state', onState);
  socket.on('connect', rejoin);
  if (rememberedPlayer(code)) rejoin();
  else showJoin();

  async function rejoin() {
    const playerId = rememberedPlayer(code);
    if (!playerId) return;
    const res = await request('game:rejoin', { code, playerId });
    if (res.error) {
      forgetPlayer(code);
      showJoin(res.error);
    }
  }

  function showJoin(message) {
    reset();
    const form = h('form', { class: 'panel narrow', onSubmit: async (e) => {
      e.preventDefault();
      const name = new FormData(form).get('name');
      store.set('gg:name', String(name).trim());
      const res = await request('game:join', { code, name });
      if (res.error) return toast(res.error, 'error');
      rememberPlayer(res.code, res.playerId);
    } },
      h('h2', {}, `Join game ${code}`),
      message ? h('p', { class: 'warn' }, message) : null,
      h('label', {}, 'Your name', h('input', { name: 'name', required: true, maxlength: 24, value: store.get('gg:name') ?? '', autofocus: true })),
      h('button', { class: 'btn primary', type: 'submit' }, 'Join game'),
      h('a', { href: '#/', class: 'back' }, 'Back to start'));
    root.replaceChildren(h('section', { class: 'page center' }, form));
  }

  function reset() {
    for (const fn of teardown) fn();
    teardown = [];
    ui = {};
    layoutKey = null;
  }

  function onState(snap) {
    if (snap.code !== code) return;
    state = snap;
    clockOffset = snap.serverNow - Date.now();
    if (!me()) {
      forgetPlayer(code);
      reset();
      root.replaceChildren(h('section', { class: 'page center' },
        h('h1', {}, 'You were removed from this game'),
        h('p', {}, h('a', { href: '#/' }, 'Back to start'))));
      return;
    }
    const key = `${snap.phase}:${snap.round?.index ?? -1}`;
    if (key !== layoutKey) {
      reset();
      layoutKey = key;
      ({ lobby: renderLobby, round: renderRound, reveal: renderReveal, finished: renderFinished })[snap.phase]();
    }
    ui.update?.();
  }

  async function act(event, payload) {
    const res = await request(event, payload);
    if (res.error) toast(res.error, 'error');
    return res;
  }

  function leave() {
    request('game:leave');
    forgetPlayer(code);
    location.hash = '#/';
  }

  function playerList({ showScores = false, showGuessed = false } = {}) {
    return h('ul', { class: 'players' }, state.players.map((p) => h('li', { class: p.connected ? '' : 'offline' },
      h('span', { class: 'swatch', style: { background: colorOf(p.id) } }),
      h('span', { class: 'name' }, p.name, p.id === state.you ? ' (you)' : '', p.id === state.hostId ? h('small', {}, ' host') : null),
      !p.connected ? h('small', { class: 'muted' }, 'offline') : null,
      showGuessed ? h('span', { class: `guessed ${p.guessed ? 'yes' : ''}` }, p.guessed ? 'Guessed' : 'Thinking') : null,
      showScores ? h('span', { class: 'score' }, formatPoints(p.total)) : null,
      isHost() && state.phase === 'lobby' && p.id !== state.you
        ? h('button', { class: 'link', type: 'button', onClick: () => act('game:kick', { playerId: p.id }) }, 'Remove')
        : null,
    )));
  }

  // ---------- Lobby ----------
  function renderLobby() {
    let shareUrl = `${location.origin}${location.pathname}#/game/${code}`;
    const shareInput = h('input', { value: shareUrl, readonly: true, 'aria-label': 'Invite link', onFocus: (e) => e.target.select() });
    const shareHint = h('p', { class: 'hint' });
    inviteOrigin().then((origin) => {
      if (origin) {
        shareUrl = `${origin}${location.pathname}#/game/${code}`;
        shareInput.value = shareUrl;
      } else if (isLocalhost()) {
        shareHint.textContent = 'This link only works on this computer. Share your network address instead.';
      }
    });
    const players = h('div');
    const controls = h('div', { class: 'lobby-controls' });
    root.replaceChildren(h('section', { class: 'lobby' },
      h('div', { class: 'stamp', 'aria-label': `Game code ${code}` },
        h('span', { class: 'stamp-label' }, 'Game code'),
        h('span', { class: 'stamp-code' }, code)),
      h('div', { class: 'lobby-info' },
        h('h1', {}, state.setName),
        h('p', { class: 'muted' }, `${state.totalRounds} rounds, ${state.roundSeconds} seconds each.`),
        h('div', { class: 'share' },
          shareInput,
          h('button', { class: 'btn', type: 'button', onClick: async () => {
            try { await navigator.clipboard.writeText(shareUrl); toast('Invite link copied'); }
            catch { toast('Copy the link from the box instead.'); }
          } }, 'Copy invite link')),
        shareHint,
        h('h2', {}, 'Players'),
        players,
        controls,
        h('button', { class: 'link', type: 'button', onClick: leave }, 'Leave game')),
    ));
    ui.update = () => {
      players.replaceChildren(playerList());
      controls.replaceChildren(isHost()
        ? h('button', { class: 'btn primary big', type: 'button', onClick: () => act('game:start') },
            `Start game with ${state.players.length} player${state.players.length === 1 ? '' : 's'}`)
        : h('p', { class: 'waiting' }, 'Waiting for the host to start the game.'));
    };
  }

  // ---------- Round ----------
  function renderRound() {
    const { round } = state;
    let pending = round.myGuess ?? round.myDraft;
    let locked = Boolean(round.myGuess);
    let marker = null;

    const timer = h('span', { class: 'timer' });
    const bar = h('span', { class: 'timer-bar' });
    const lockBtn = h('button', { class: 'btn primary big', type: 'button', disabled: true, onClick: lockIn }, 'Place a pin on the map');
    const players = h('div', { class: 'round-players' });
    const hostTools = h('div');
    const mapEl = h('div', { class: 'map guess-map' });
    const photo = h('figure', { class: 'photo', onClick: () => photo.classList.toggle('zoomed'), title: 'Click to enlarge' },
      h('img', { src: round.imageUrl, alt: 'Where was this taken?' }));

    const section = h('section', { class: 'round' },
      h('div', { class: 'round-bar' },
        h('strong', {}, `Round ${round.index + 1} of ${state.totalRounds}`),
        h('span', { class: 'timer-wrap' }, timer, h('span', { class: 'timer-track' }, bar)),
        h('button', { class: 'link', type: 'button', onClick: leave }, 'Leave')),
      h('div', { class: 'round-body' },
        photo,
        h('div', { class: 'guess-pane' }, mapEl, lockBtn),
        h('aside', { class: 'round-side' }, players, hostTools)),
    );
    root.replaceChildren(section);

    const map = createMap(mapEl);
    teardown.push(() => map.remove());
    map.on('click', (e) => {
      if (locked) return;
      pending = e.latlng;
      drawPending();
      // The server keeps the latest pin so it still counts if time runs out before locking in.
      request('guess:draft', { lat: pending.lat, lng: pending.lng });
    });

    function drawPending() {
      if (!pending) return;
      if (!marker) marker = L.marker(pending, { icon: pinIcon(colorOf(state.you)), keyboard: false }).addTo(map);
      marker.setLatLng(pending);
      lockBtn.disabled = locked;
      lockBtn.textContent = locked ? 'Guess locked in' : 'Lock in guess';
      mapEl.classList.toggle('locked', locked);
    }
    if (pending) {
      drawPending();
      map.setView(pending, 4);
    }

    async function lockIn() {
      if (!pending || locked) return;
      locked = true;
      drawPending();
      const { lat, lng } = pending;
      const res = await act('guess:submit', { lat, lng });
      if (res.error) {
        locked = false;
        drawPending();
      }
    }

    const tick = () => {
      const left = Math.max(0, round.deadline - serverNow());
      const secs = Math.ceil(left / 1000);
      timer.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      timer.classList.toggle('urgent', secs <= URGENT_SECONDS);
      section.classList.toggle('urgent', secs <= URGENT_SECONDS);
      bar.style.transform = `scaleX(${left / (state.roundSeconds * 1000)})`;
    };
    tick();
    const interval = setInterval(tick, 250);
    teardown.push(() => clearInterval(interval));

    ui.update = () => {
      const guessed = state.players.filter((p) => p.guessed).length;
      players.replaceChildren(
        h('h2', {}, `${guessed} of ${state.players.filter((p) => p.connected).length} guessed`),
        playerList({ showGuessed: true }));
      hostTools.replaceChildren(isHost()
        ? h('button', { class: 'btn subtle', type: 'button', onClick: () => act('round:end') }, 'End round now')
        : '');
    };
  }

  // ---------- Reveal ----------
  function revealMap(el, result) {
    const map = createMap(el);
    const { answer } = result;
    const points = [[answer.lat, answer.lng]];
    for (const g of result.guesses) {
      if (!g.guess) continue;
      const lng = nearLng(g.guess.lng, answer.lng);
      const color = colorOf(g.playerId);
      L.polyline([[answer.lat, answer.lng], [g.guess.lat, lng]], { color, weight: 2, dashArray: '6 6', opacity: 0.9 }).addTo(map);
      L.marker([g.guess.lat, lng], { icon: dotIcon(color, g.name) })
        .bindTooltip(`${escapeHtml(g.name)}: ${formatDistance(g.distanceKm)}`, { direction: 'top', offset: [0, -8] })
        .addTo(map);
      points.push([g.guess.lat, lng]);
    }
    L.marker([answer.lat, answer.lng], { icon: pinIcon('var(--pin)'), zIndexOffset: 1000 })
      .bindTooltip(answer.caption ? escapeHtml(answer.caption) : 'Here', { direction: 'top', offset: [0, -34] })
      .addTo(map);
    requestAnimationFrame(() => {
      map.invalidateSize();
      if (points.length > 1) map.fitBounds(points, { padding: [50, 50], maxZoom: 15 });
      else map.setView(points[0], 12);
    });
    return map;
  }

  function renderReveal() {
    const result = state.reveal;
    const mapEl = h('div', { class: 'map reveal-map' });
    const side = h('aside', { class: 'reveal-side' });
    root.replaceChildren(h('section', { class: 'reveal' },
      h('div', { class: 'round-bar' },
        h('strong', {}, `Round ${result.index + 1} of ${state.totalRounds} result`),
        h('button', { class: 'link', type: 'button', onClick: leave }, 'Leave')),
      h('div', { class: 'reveal-body' }, mapEl, side)));
    const map = revealMap(mapEl, result);
    teardown.push(() => map.remove());

    ui.update = () => {
      const last = result.index + 1 >= state.totalRounds;
      const host = state.players.find((p) => p.id === state.hostId);
      side.replaceChildren(
        h('figure', { class: 'reveal-photo' },
          h('img', { src: state.round.imageUrl, alt: result.answer.caption || 'This round’s picture' }),
          result.answer.caption ? h('figcaption', {}, result.answer.caption) : null),
        h('table', { class: 'results' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Distance'), h('th', {}, 'Round'), h('th', {}, 'Total'))),
          h('tbody', {}, result.guesses.map((g) => h('tr', { class: g.playerId === state.you ? 'me' : '' },
            h('td', {}, h('span', { class: 'swatch', style: { background: colorOf(g.playerId) } }), g.name),
            h('td', {}, formatDistance(g.distanceKm),
              g.guess && !g.locked ? h('small', { class: 'muted', title: 'Pin placed but not locked in before time ran out' }, ' unlocked') : null),
            h('td', { class: 'num' }, `+${formatPoints(g.score)}`),
            h('td', { class: 'num' }, formatPoints(state.players.find((p) => p.id === g.playerId)?.total ?? 0)),
          )))),
        isHost()
          ? h('button', { class: 'btn primary big', type: 'button', onClick: () => act('round:next') },
              last ? 'Show final scores' : 'Next round')
          : h('p', { class: 'waiting' }, `Waiting for ${host?.name ?? 'the host'} to continue.`),
      );
    };
  }

  // ---------- Finished ----------
  function renderFinished() {
    const ranked = state.players;
    const podium = ranked.slice(0, 3);
    const roundScore = (round, playerId) => round.guesses.find((g) => g.playerId === playerId);
    const mapEl = h('div', { class: 'map recap-map' });
    let recap = 0;
    let recapMap = null;
    const recapLabel = h('span');
    const showRecap = (i) => {
      recap = (i + state.history.length) % state.history.length;
      recapMap?.remove();
      recapMap = revealMap(mapEl, state.history[recap]);
      recapLabel.textContent = `Round ${recap + 1}${state.history[recap].answer.caption ? `: ${state.history[recap].answer.caption}` : ''}`;
    };

    root.replaceChildren(h('section', { class: 'finished' },
      h('h1', {}, ranked[0] ? `${ranked[0].name} wins` : 'Game over'),
      h('ol', { class: 'podium' }, podium.map((p, i) => h('li', { class: `place-${i + 1}` },
        h('span', { class: 'place' }, ['1st', '2nd', '3rd'][i]),
        h('strong', {}, p.name),
        h('span', { class: 'score' }, `${formatPoints(p.total)} points`)))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'results breakdown' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Player'),
          state.history.map((r) => h('th', { class: 'num' }, `R${r.index + 1}`)),
          h('th', { class: 'num' }, 'Total'))),
        h('tbody', {}, ranked.map((p) => h('tr', { class: p.id === state.you ? 'me' : '' },
          h('td', {}, h('span', { class: 'swatch', style: { background: colorOf(p.id) } }), p.name),
          state.history.map((r) => {
            const g = roundScore(r, p.id);
            return h('td', { class: 'num', title: g?.guess ? formatDistance(g.distanceKm) : 'No guess' }, g?.guess ? formatPoints(g.score) : '–');
          }),
          h('td', { class: 'num total' }, formatPoints(p.total))))))),
      h('div', { class: 'recap' },
        h('div', { class: 'recap-nav' },
          h('button', { class: 'btn', type: 'button', onClick: () => showRecap(recap - 1), 'aria-label': 'Previous round' }, 'Previous'),
          recapLabel,
          h('button', { class: 'btn', type: 'button', onClick: () => showRecap(recap + 1), 'aria-label': 'Next round' }, 'Next')),
        mapEl),
      h('p', {}, h('a', { class: 'btn primary', href: '#/', onClick: () => forgetPlayer(code) }, 'Back to start')),
    ));
    showRecap(0);
    teardown.push(() => recapMap?.remove());
  }

  return () => {
    reset();
    socket.off('state', onState);
    socket.off('connect', rejoin);
  };
}
