import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, PHASES, DISCONNECT_GRACE_MS } from '../src/game.js';

const images = [
  { id: 'a', file: 'a.jpg', lat: 52.37, lng: 4.9, takenAt: '2019-04-27T14:00', caption: 'Amsterdam' },
  { id: 'b', file: 'b.jpg', lat: 48.86, lng: 2.35, takenAt: '2023-07-14T21:30', caption: 'Paris' },
  { id: 'c', file: 'c.jpg', lat: null, lng: null, takenAt: null, caption: 'Unplaced' },
];

function makeGame(opts = {}) {
  let changes = 0;
  const game = new Game({
    code: 'ABCD',
    set: { id: 'set1', name: 'Trip' },
    images,
    rounds: 2,
    roundSeconds: 30,
    onChange: () => changes++,
    ...opts,
  });
  return { game, changes: () => changes };
}

test('full game: early end when all guess, timer expiry, cumulative totals', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { game } = makeGame();
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');

  assert.throws(() => game.start(guest.id), GameError);
  game.start(host.id);
  assert.equal(game.phase, PHASES.ROUND);

  // Answer is hidden during the round.
  const snap = game.snapshot(guest.id);
  assert.equal(snap.reveal, null);
  assert.ok(!JSON.stringify(snap).includes(game.images[0].caption));

  const first = game.images[0];
  game.submitGuess(host.id, { lat: first.lat, lng: first.lng });
  assert.equal(game.phase, PHASES.ROUND);
  assert.throws(() => game.submitGuess(host.id, { lat: 0, lng: 0 }), /already guessed/);
  game.submitGuess(guest.id, { lat: first.lat + 1, lng: first.lng });
  assert.equal(game.phase, PHASES.REVEAL, 'round ends once everyone guessed');

  const reveal = game.snapshot(host.id).reveal;
  assert.equal(reveal.guesses[0].name, 'Host');
  assert.equal(reveal.guesses[0].score, 5000);
  const guestRound1 = reveal.guesses[1].score;
  assert.ok(guestRound1 > 0 && guestRound1 < 5000);

  game.next(host.id);
  assert.equal(game.roundIndex, 1);
  game.submitGuess(guest.id, { lat: game.images[1].lat, lng: game.images[1].lng });
  t.mock.timers.tick(30_000);
  assert.equal(game.phase, PHASES.REVEAL, 'round ends at the deadline');

  game.next(host.id);
  assert.equal(game.phase, PHASES.FINISHED);
  const final = game.snapshot(host.id);
  assert.equal(final.history.length, 2);
  assert.equal(game.players.get(host.id).total, 5000);
  assert.equal(game.players.get(guest.id).total, guestRound1 + 5000);
  assert.equal(final.players[0].name, 'Guest');
});

test('disconnected players do not hold up a round', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { game } = makeGame();
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');
  game.start(host.id);
  game.setConnected(guest.id, false);
  game.setConnected(guest.id, true);
  game.setConnected(guest.id, false);
  game.submitGuess(host.id, { lat: 0, lng: 0 });
  assert.equal(game.phase, PHASES.ROUND, 'a reload does not end the round straight away');
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.equal(game.phase, PHASES.REVEAL);
  assert.equal(game.results[0].guesses.find((g) => g.playerId === guest.id).score, 0);
});

test('joining rules', () => {
  const { game } = makeGame();
  const host = game.addPlayer('Host');
  assert.throws(() => game.addPlayer('host'), /already called/);
  assert.throws(() => game.addPlayer('  '), /Enter a name/);
  game.start(host.id);
  assert.throws(() => game.addPlayer('Late'), /already started/);
  game.dispose();
});

test('rounds are capped by available pictures and images only served once started', () => {
  const { game } = makeGame({ rounds: 10 });
  assert.equal(game.images.length, 2);
  assert.equal(game.imageForRound(0), null);
  game.start(game.addPlayer('Host').id);
  assert.ok(game.imageForRound(0));
  assert.equal(game.imageForRound(1), null);
  game.dispose();
});

test('an unlocked pin counts when the round ends, a locked guess wins over a later draft', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { game } = makeGame();
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');
  const idle = game.addPlayer('Idle');
  game.start(host.id);
  const answer = game.images[0];

  game.setDraft(guest.id, { lat: 0, lng: 0 });
  game.setDraft(guest.id, { lat: answer.lat, lng: answer.lng });
  assert.equal(game.snapshot(guest.id).round.myDraft.lat, answer.lat, 'draft survives a reload');
  assert.equal(game.snapshot(guest.id).players.find((p) => p.id === guest.id).guessed, false);

  game.submitGuess(host.id, { lat: answer.lat, lng: answer.lng });
  assert.throws(() => game.setDraft(host.id, { lat: 0, lng: 0 }), /already guessed/);
  t.mock.timers.tick(30_000);

  const byId = Object.fromEntries(game.results[0].guesses.map((g) => [g.playerId, g]));
  assert.deepEqual([byId[host.id].locked, byId[host.id].score], [true, 5000]);
  assert.deepEqual([byId[guest.id].locked, byId[guest.id].score], [false, 5000]);
  assert.deepEqual([byId[idle.id].guess, byId[idle.id].score], [null, 0]);
});

test('date mode: hidden padded range, scoring in hours, answers revealed only afterwards', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = Date.parse('2024-01-01T12:00:00Z');
  const { game } = makeGame({ mode: 'date', now: () => now });
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');
  const first = Date.parse('2019-04-27T14:00:00Z');
  const last = Date.parse('2023-07-14T21:30:00Z');

  assert.equal(game.images.length, 2, 'pictures without a date are skipped');
  assert.ok(Math.abs(game.scale - (last - first) / 3_600_000) < 1e-6);
  const { start, end } = game.setup.range;
  assert.ok(start < first && end > last, 'range covers every picture');
  assert.ok(end <= Date.parse('2024-01-02T00:00:00Z'), 'range stops at today');
  assert.equal(start % 86_400_000, 0, 'range starts at midnight');

  game.start(host.id);
  const snap = game.snapshot(guest.id);
  assert.deepEqual(snap.setup.range, { start, end });
  assert.ok(!JSON.stringify(snap).includes('takenAt'));

  const answer = Date.parse(`${game.images[0].takenAt}:00Z`);
  assert.throws(() => game.submitGuess(host.id, { time: start - 1 }), /within the timeline/);
  assert.throws(() => game.submitGuess(host.id, { time: 'soon' }), /within the timeline/);
  game.submitGuess(host.id, { time: answer + 10 * 60_000 });
  game.setDraft(guest.id, { time: answer + 48 * 3_600_000 });
  t.mock.timers.tick(30_000);

  const reveal = game.snapshot(host.id).reveal;
  assert.equal(reveal.answer.time, answer);
  const [best, second] = reveal.guesses;
  assert.deepEqual([best.name, best.score], ['Host', 5000], 'within 15 minutes is perfect');
  assert.equal(second.distance, 48);
  assert.equal(second.score, Math.round(5000 * Math.exp((-10 * 48) / game.scale)));
});

test('a set with no dated pictures cannot start a date game', () => {
  assert.throws(() => makeGame({ mode: 'date', images: [images[2]] }), /no pictures with a date/);
});

test('a player who reloads within the grace period keeps the round open', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { game } = makeGame();
  const host = game.addPlayer('Host');
  const guest = game.addPlayer('Guest');
  game.start(host.id);
  game.submitGuess(host.id, { lat: 0, lng: 0 });
  game.setConnected(guest.id, false);
  t.mock.timers.tick(DISCONNECT_GRACE_MS / 2);
  game.setConnected(guest.id, true);
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.equal(game.phase, PHASES.ROUND);
  game.submitGuess(guest.id, { lat: 1, lng: 1 });
  assert.equal(game.phase, PHASES.REVEAL);
});
