import crypto from 'node:crypto';
import { GameError } from './errors.js';
import { MODES } from './modes.js';

export const MAX_PLAYERS = 30;
// A page reload briefly disconnects a player; don't end the round on them in the meantime.
export const DISCONNECT_GRACE_MS = 8000;
export const PHASES = { LOBBY: 'lobby', ROUND: 'round', REVEAL: 'reveal', FINISHED: 'finished' };

export { GameError };

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Game {
  /**
   * @param {object} opts
   * @param {string} opts.code
   * @param {{id: string, name: string}} opts.set
   * @param {'location' | 'date'} [opts.mode] what players guess
   * @param {Array<{id, lat, lng, takenAt, caption}>} opts.images the set's pictures; rounds use those ready for the mode
   * @param {number} opts.rounds
   * @param {number} opts.roundSeconds
   * @param {number} [opts.scale] overrides the field size (km for location, hours for date)
   * @param {() => void} opts.onChange called whenever clients should get a fresh snapshot
   */
  constructor({ code, set, mode = 'location', images, rounds, roundSeconds, scale, onChange, now = Date.now }) {
    this.objective = MODES[mode];
    if (!this.objective) throw new GameError('Unknown game mode.');
    const ready = images.filter(this.objective.isReady);
    if (ready.length === 0) {
      throw new GameError(`This picture set has no pictures with a ${mode === 'date' ? 'date' : 'location'} yet.`);
    }
    this.code = code;
    this.mode = mode;
    this.setId = set.id;
    this.setName = set.name;
    this.roundSeconds = roundSeconds;
    this.scale = scale || this.objective.defaultScale(ready);
    // Derived from every ready picture, not just the drawn rounds, so it says less about them.
    this.setup = this.objective.setup(ready, now());
    this.images = shuffle(ready).slice(0, Math.max(1, Math.min(rounds, ready.length)));
    this.onChange = onChange;
    this.now = now;

    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.hostId = null;
    this.roundIndex = -1;
    this.deadline = null;
    this.guesses = new Map();
    this.drafts = new Map();
    this.results = [];
    this.timer = null;
    this.graceTimers = new Map();
    this.lastActivity = now();
  }

  addPlayer(name) {
    if (this.phase !== PHASES.LOBBY) throw new GameError('This game has already started.');
    if (this.players.size >= MAX_PLAYERS) throw new GameError('This game is full.');
    const clean = String(name ?? '').trim().slice(0, 24);
    if (!clean) throw new GameError('Enter a name to join.');
    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (taken) throw new GameError(`Someone is already called “${clean}”. Pick another name.`);

    const player = { id: crypto.randomUUID(), name: clean, connected: true, total: 0 };
    this.players.set(player.id, player);
    this.hostId ??= player.id;
    this.touch();
    return player;
  }

  setConnected(playerId, connected) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = connected;
    clearTimeout(this.graceTimers.get(playerId));
    this.graceTimers.delete(playerId);
    if (!connected) {
      this.graceTimers.set(playerId, setTimeout(() => {
        this.graceTimers.delete(playerId);
        this.maybeEndRound();
      }, DISCONNECT_GRACE_MS));
    }
    this.touch();
  }

  kick(byId, playerId) {
    this.requireHost(byId);
    if (playerId === this.hostId) throw new GameError('The host cannot be removed.');
    this.players.delete(playerId);
    clearTimeout(this.graceTimers.get(playerId));
    this.graceTimers.delete(playerId);
    this.guesses.delete(playerId);
    this.drafts.delete(playerId);
    this.touch();
    this.maybeEndRound();
  }

  start(byId) {
    this.requireHost(byId);
    if (this.phase !== PHASES.LOBBY) throw new GameError('The game has already started.');
    this.startRound();
  }

  next(byId) {
    this.requireHost(byId);
    if (this.phase !== PHASES.REVEAL) throw new GameError('Wait for the round to finish.');
    if (this.roundIndex + 1 >= this.images.length) {
      this.phase = PHASES.FINISHED;
      this.touch();
    } else {
      this.startRound();
    }
  }

  endRoundEarly(byId) {
    this.requireHost(byId);
    if (this.phase === PHASES.ROUND) this.endRound();
  }

  submitGuess(playerId, payload) {
    this.guesses.set(playerId, this.checkGuess(playerId, payload));
    this.drafts.delete(playerId);
    this.touch();
    this.maybeEndRound();
  }

  /** A pin placed but not locked in yet. It counts if the round ends before the player locks in. */
  setDraft(playerId, payload) {
    this.drafts.set(playerId, this.checkGuess(playerId, payload));
    this.lastActivity = this.now();
  }

  checkGuess(playerId, payload) {
    if (this.phase !== PHASES.ROUND) throw new GameError('There is no round in progress.');
    if (!this.players.has(playerId)) throw new GameError('You are not part of this game.');
    if (this.guesses.has(playerId)) throw new GameError('You already guessed this round.');
    return this.objective.parseGuess(payload ?? {}, this.setup);
  }

  startRound() {
    this.roundIndex += 1;
    this.phase = PHASES.ROUND;
    this.guesses = new Map();
    this.drafts = new Map();
    this.deadline = this.now() + this.roundSeconds * 1000;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.endRound(), this.roundSeconds * 1000);
    this.touch();
  }

  maybeEndRound() {
    if (this.phase !== PHASES.ROUND) return;
    // Players who just dropped out may be reloading, so they still count for a few seconds.
    const active = [...this.players.values()].filter((p) => p.connected || this.graceTimers.has(p.id));
    if (active.length > 0 && active.every((p) => this.guesses.has(p.id))) this.endRound();
  }

  endRound() {
    if (this.phase !== PHASES.ROUND) return;
    clearTimeout(this.timer);
    this.timer = null;
    const answer = this.images[this.roundIndex];
    const guesses = [...this.players.values()].map((player) => {
      const locked = this.guesses.has(player.id);
      const guess = this.guesses.get(player.id) ?? this.drafts.get(player.id);
      if (!guess) return { playerId: player.id, guess: null, locked: false, distance: null, score: 0 };
      const distance = this.objective.distance(guess, answer);
      return { playerId: player.id, guess, locked, distance, score: this.objective.score(distance, this.scale) };
    });
    for (const g of guesses) this.players.get(g.playerId).total += g.score;
    this.results.push({ answer, guesses });
    this.phase = PHASES.REVEAL;
    this.deadline = null;
    this.touch();
  }

  requireHost(playerId) {
    if (playerId !== this.hostId) throw new GameError('Only the host can do that.');
  }

  touch() {
    this.lastActivity = this.now();
    this.onChange?.();
  }

  dispose() {
    clearTimeout(this.timer);
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.onChange = null;
  }

  imageForRound(index) {
    if (index < 0 || index > this.roundIndex) return null;
    return this.images[index];
  }

  /** What one player is allowed to see. Never leaks the answer of a running round. */
  snapshot(playerId) {
    const nameOf = (id) => this.players.get(id)?.name ?? 'Left the game';
    const publicAnswer = (a) => ({ ...this.objective.answer(a), caption: a.caption });
    const publicResult = (r, index) => ({
      index,
      answer: publicAnswer(r.answer),
      guesses: r.guesses
        .map((g) => ({ ...g, name: nameOf(g.playerId) }))
        .sort((a, b) => b.score - a.score),
    });

    const snap = {
      code: this.code,
      setName: this.setName,
      phase: this.phase,
      you: playerId,
      hostId: this.hostId,
      totalRounds: this.images.length,
      roundSeconds: this.roundSeconds,
      mode: this.mode,
      scale: this.scale,
      setup: this.setup,
      serverNow: this.now(),
      players: [...this.players.values()]
        .map((p) => ({
          id: p.id,
          name: p.name,
          connected: p.connected,
          total: p.total,
          guessed: this.phase === PHASES.ROUND && this.guesses.has(p.id),
        }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
      round: null,
      reveal: null,
      history: null,
    };

    if (this.roundIndex >= 0) {
      snap.round = {
        index: this.roundIndex,
        imageUrl: `/api/games/${this.code}/images/${this.roundIndex}`,
        deadline: this.deadline,
        myGuess: this.phase === PHASES.ROUND ? this.guesses.get(playerId) ?? null : null,
        myDraft: this.phase === PHASES.ROUND ? this.drafts.get(playerId) ?? null : null,
      };
    }
    if (this.phase === PHASES.REVEAL) {
      snap.reveal = publicResult(this.results[this.roundIndex], this.roundIndex);
    }
    if (this.phase === PHASES.FINISHED) {
      snap.history = this.results.map(publicResult);
    }
    return snap;
  }
}
