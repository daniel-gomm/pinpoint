import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, PHASES, DISCONNECT_GRACE_MS } from '../src/game.js';
import { cleanSettings } from '../src/socket.js';

const IMAGES = [
  { id: 'a', file: 'a.jpg', lat: 52.37, lng: 4.9, takenAt: '2019-04-27T14:00', caption: 'Amsterdam' },
  { id: 'b', file: 'b.jpg', lat: 48.86, lng: 2.35, takenAt: '2023-07-14T21:30', caption: 'Paris' },
  { id: 'c', file: 'c.jpg', lat: 50.85, lng: 4.35, takenAt: '2021-01-02T09:00', caption: 'Brussels' },
  { id: 'd', file: 'd.jpg', lat: 51.51, lng: -0.13, takenAt: '2016-08-01T12:00', caption: 'London' },
  { id: 'x', file: 'x.jpg', lat: null, lng: null, takenAt: null, caption: 'Nothing known' },
];

function makeGame({ images = IMAGES, set = { id: 's', name: 'Trip', map: null }, now, ...settings } = {}) {
  return new Game({
    code: 'ABCD',
    settings: cleanSettings({ rounds: 2, roundSeconds: 30, ...settings }),
    loadPool: () => ({ set, images }),
    ...(now ? { now } : {}),
  });
}

const entryOf = (game, round, playerId) => game.results[round].entries.find((e) => e.playerId === playerId);
const at = (image) => ({ lat: image.lat, lng: image.lng });

test('points scoring: early end, timer expiry, cumulative totals', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const game = makeGame({ scoring: 'points' });
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');

  assert.throws(() => game.start(guest.id), /Only the host/);
  game.start(host.id);
  assert.equal(game.phase, PHASES.ROUND);
  assert.equal(game.snapshot(guest.id).reveal, null, 'answer hidden during the round');

  const [first] = game.rounds[0].images;
  game.submitGuess(host.id, at(first));
  assert.throws(() => game.submitGuess(host.id, { lat: 0, lng: 0 }), /already guessed/);
  game.submitGuess(guest.id, { lat: first.lat + 0.5, lng: first.lng });
  assert.equal(game.phase, PHASES.REVEAL, 'round ends once everyone guessed');
  const g1 = entryOf(game, 0, guest.id).points;
  assert.equal(entryOf(game, 0, host.id).points, 5000);
  assert.ok(g1 > 0 && g1 < 5000);

  game.next(host.id);
  game.submitGuess(guest.id, at(game.rounds[1].images[0]));
  t.mock.timers.tick(30_000);
  assert.equal(game.phase, PHASES.REVEAL, 'round ends at the deadline');
  game.next(host.id);
  assert.equal(game.phase, PHASES.FINISHED);
  assert.equal(game.players.get(host.id).total, 5000);
  assert.equal(game.players.get(guest.id).total, g1 + 5000);
  assert.equal(game.snapshot(host.id).history.length, 2);
});

test('placement scoring caps the cost of one big miss', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const game = makeGame({ scoring: 'placement', rounds: 2 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => game.addPlayer(n));
  game.start(a.id);
  const [img] = game.rounds[0].images;
  game.submitGuess(a.id, at(img));
  game.submitGuess(b.id, at(img)); // tie with A
  game.submitGuess(c.id, { lat: -img.lat, lng: img.lng + 179 }); // other side of the world
  assert.deepEqual([a, b, c].map((p) => entryOf(game, 0, p.id).score), [1.5, 1.5, 0]);
  assert.deepEqual([a, b, c].map((p) => entryOf(game, 0, p.id).rank), [1, 1, 3]);

  game.next(a.id);
  const [img2] = game.rounds[1].images;
  game.submitGuess(c.id, at(img2));
  game.submitGuess(a.id, { lat: img2.lat + 1, lng: img2.lng });
  // B makes no guess and beats nobody
  t.mock.timers.tick(30_000);
  assert.deepEqual([a, b, c].map((p) => entryOf(game, 1, p.id).score), [1, 0, 2]);
  game.next(a.id);
  const standings = game.snapshot(a.id).players.map((p) => [p.name, p.total]);
  assert.deepEqual(standings, [['A', 2.5], ['C', 2], ['B', 1.5]]);
});

test('disconnected players hold a round only for the grace period', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const game = makeGame();
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');
  game.start(host.id);
  game.setConnected(guest.id, false);
  game.submitGuess(host.id, { lat: 0, lng: 0 });
  assert.equal(game.phase, PHASES.ROUND, 'a reload does not end the round straight away');
  t.mock.timers.tick(DISCONNECT_GRACE_MS / 2);
  game.setConnected(guest.id, true);
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.equal(game.phase, PHASES.ROUND, 'reconnected in time');
  game.setConnected(guest.id, false);
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.equal(game.phase, PHASES.REVEAL);
  assert.equal(entryOf(game, 0, guest.id).points, 0);
});

test('an unlocked pick counts when the round ends', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const game = makeGame({ scoring: 'points' });
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');
  game.start(host.id);
  const [img] = game.rounds[0].images;
  game.setDraft(guest.id, { lat: 0, lng: 0 });
  game.setDraft(guest.id, at(img));
  assert.deepEqual(game.snapshot(guest.id).round.myDraft, at(img), 'draft survives a reload');
  game.submitGuess(host.id, at(img));
  t.mock.timers.tick(30_000);
  assert.deepEqual([entryOf(game, 0, guest.id).locked, entryOf(game, 0, guest.id).points], [false, 5000]);
});

test('date mode: padded hidden range and precision-aware distances', () => {
  const now = () => Date.parse('2024-01-01T12:00:00Z');
  const minute = makeGame({ mode: 'date', now });
  const host = minute.addPlayer('Host');
  minute.start(host.id);
  const { start, end } = minute.setup.range;
  assert.ok(start < Date.parse('2016-08-01T12:00Z') && end > Date.parse('2023-07-14T21:30Z'), 'covers every picture');
  assert.ok(end <= Date.parse('2024-01-02T00:00Z'), 'stops at today');
  assert.ok(!JSON.stringify(minute.snapshot(host.id)).includes('takenAt'));
  assert.throws(() => minute.submitGuess(host.id, { time: start - 1 }), /within the timeline/);
  minute.dispose();

  const year = makeGame({ mode: 'date', precision: 'year', now });
  const p = year.addPlayer('P');
  year.start(p.id);
  assert.equal(new Date(year.setup.range.start).getUTCMonth(), 0, 'year timeline starts on 1 January');
  const answer = Date.parse(`${year.rounds[0].images[0].takenAt}:00Z`);
  const sameYear = Date.UTC(new Date(answer).getUTCFullYear(), 11, 31, 23);
  year.submitGuess(p.id, { time: sameYear });
  const e = entryOf(year, 0, p.id);
  assert.deepEqual([e.distance, e.points], [0, 5000], 'any day in the right year is perfect');
  assert.equal(e.guess.time, Date.UTC(new Date(answer).getUTCFullYear(), 0, 1), 'guess snapped to the year');
  year.dispose();
});

test('order mode: wrong pairs, scores and validation', () => {
  const game = makeGame({ mode: 'order', orderSize: 4, rounds: 5, scoring: 'points' });
  const a = game.addPlayer('A');
  const b = game.addPlayer('B');
  game.start(a.id);
  assert.equal(game.rounds.length, 1, 'four dated pictures make one round of four');
  const images = game.rounds[0].images;
  const correct = images.map((_, i) => i).sort((x, y) => images[x].takenAt.localeCompare(images[y].takenAt));
  assert.throws(() => game.submitGuess(a.id, { order: [0, 0, 1, 2] }), /every picture/);
  game.submitGuess(a.id, { order: correct });
  game.submitGuess(b.id, { order: [...correct].reverse() });
  assert.deepEqual([entryOf(game, 0, a.id).distance, entryOf(game, 0, a.id).points], [0, 5000]);
  assert.deepEqual([entryOf(game, 0, b.id).distance, entryOf(game, 0, b.id).points], [6, 0]);
  assert.deepEqual(game.snapshot(a.id).reveal.answer.order, correct);
});

test('players-bring-photos: owners sit out and get the average', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const images = [];
  const game = makeGame({ source: 'players', scoring: 'points', rounds: 1, images });
  const host = game.addPlayer('Host');
  const a = game.addPlayer('A');
  const b = game.addPlayer('B');
  images.push({ ...IMAGES[0], contributorId: host.id });
  game.start(host.id);
  assert.deepEqual(game.rounds[0].sitOut, [host.id]);
  assert.equal(game.snapshot(host.id).round.sittingOut, true);
  assert.throws(() => game.submitGuess(host.id, { lat: 0, lng: 0 }), /your picture/);
  game.submitGuess(a.id, at(IMAGES[0]));
  game.submitGuess(b.id, { lat: 0, lng: 0 });
  assert.equal(game.phase, PHASES.REVEAL, 'the owner is not waited for');
  const own = entryOf(game, 0, host.id);
  assert.deepEqual([own.sitOut, own.points], [true, Math.round((5000 + entryOf(game, 0, b.id).points) / 2)]);
  assert.equal(game.snapshot(host.id).reveal.guesses.at(-1).playerId, host.id, 'listed last');
});

test('a round with only the owner connected ends right away', () => {
  const images = [{ ...IMAGES[0] }];
  const game = makeGame({ source: 'players', rounds: 1, images });
  const host = game.addPlayer('Host');
  images[0].contributorId = host.id;
  game.start(host.id);
  assert.equal(game.phase, PHASES.REVEAL);
});

test('presenter hosts without playing', () => {
  const game = makeGame({ presenter: true });
  const presenter = game.addPresenter('Screen');
  assert.throws(() => game.start(presenter.id), /at least one player/);
  const p = game.addPlayer('Player');
  assert.equal(game.hostId, presenter.id);
  game.start(presenter.id);
  assert.throws(() => game.submitGuess(presenter.id, { lat: 0, lng: 0 }), /Only players/);
  const snap = game.snapshot(presenter.id);
  assert.deepEqual(snap.players.map((x) => x.id), [p.id]);
  assert.equal(snap.presenter.name, 'Screen');
  game.dispose();
});

test('rematch resets scores and prefers unplayed pictures', () => {
  const game = makeGame({ rounds: 2 });
  const host = game.addPlayer('Host');
  game.start(host.id);
  const firstIds = game.rounds.map((r) => r.images[0].id);
  for (let i = 0; i < 2; i++) {
    game.submitGuess(host.id, at(game.rounds[i].images[0]));
    game.next(host.id);
  }
  assert.equal(game.phase, PHASES.FINISHED);
  game.restart(host.id);
  assert.equal(game.phase, PHASES.LOBBY);
  assert.equal(game.players.get(host.id).total, 0);
  game.start(host.id);
  const secondIds = game.rounds.map((r) => r.images[0].id);
  assert.equal(secondIds.filter((id) => firstIds.includes(id)).length, 0);
  game.dispose();
});

test('a saved game resumes with its round and deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1_000_000;
  const now = () => clock;
  const game = makeGame({ now, scoring: 'points' });
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');
  game.start(host.id);
  game.submitGuess(host.id, at(game.rounds[0].images[0]));
  const saved = JSON.parse(JSON.stringify(game.toJSON()));
  game.dispose();

  clock += 10_000;
  const restored = Game.fromJSON(saved, { loadPool: () => ({ set: { id: 's', name: 'Trip' }, images: IMAGES }), now });
  assert.equal(restored.phase, PHASES.ROUND);
  assert.equal(restored.players.get(guest.id).connected, false);
  assert.ok(restored.guesses.has(host.id));
  t.mock.timers.tick(20_000);
  assert.equal(restored.phase, PHASES.REVEAL, 'the remaining 20 s of the round still run');
  assert.equal(restored.players.get(host.id).total, 5000);
});

test('custom map: pixel distances as percent of the map width', () => {
  const set = { id: 's', name: 'Office', map: { file: 'map.jpg', width: 1000, height: 500, metersWide: null } };
  const images = [{ id: 'p', file: 'p.jpg', lat: 100, lng: 100, takenAt: null, caption: '' }];
  const game = makeGame({ set, images, rounds: 1, scoring: 'points' });
  const host = game.addPlayer('Host');
  game.start(host.id);
  assert.equal(game.setup.map.width, 1000);
  assert.throws(() => game.submitGuess(host.id, { lat: 600, lng: 10 }), /on the map/);
  game.submitGuess(host.id, { lat: 100, lng: 200 });
  assert.equal(entryOf(game, 0, host.id).distance, 10, '100 px of 1000 px is 10%');
});

test('not enough pictures for the mode gives a clear error', () => {
  const game = makeGame({ mode: 'order', orderSize: 6 });
  const host = game.addPlayer('Host');
  assert.throws(() => game.start(host.id), /4 pictures with a date; this game needs at least 6/);
  assert.throws(() => makeGame({ mode: 'date', images: [IMAGES[4]] }).prepare(), /no pictures with a date/);
});
