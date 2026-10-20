import crypto from 'node:crypto';
import { haversineKm, scaleForLocations, score } from './scoring.js';

export const MAX_PLAYERS = 30;
export const PHASES = { LOBBY: 'lobby', ROUND: 'round', REVEAL: 'reveal', FINISHED: 'finished' };

export class GameError extends Error {}

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
   * @param {Array<{id, lat, lng, caption}>} opts.images located images to draw rounds from
   * @param {number} opts.rounds
   * @param {number} opts.roundSeconds
   * @param {number} [opts.scaleKm] overrides the field size derived from the images
   * @param {() => void} opts.onChange called whenever clients should get a fresh snapshot
   */
  constructor({ code, set, images, rounds, roundSeconds, scaleKm, onChange, now = Date.now }) {
    if (images.length === 0) throw new GameError('This picture set has no pictures with a location yet.');
    this.code = code;
    this.setId = set.id;
    this.setName = set.name;
    this.roundSeconds = roundSeconds;
    this.scaleKm = scaleKm || scaleForLocations(images);
    this.images = shuffle(images).slice(0, Math.max(1, Math.min(rounds, images.length)));
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
    this.touch();
    if (!connected) this.maybeEndRound();
  }

  kick(byId, playerId) {
    this.requireHost(byId);
    if (playerId === this.hostId) throw new GameError('The host cannot be removed.');
    this.players.delete(playerId);
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

  submitGuess(playerId, lat, lng) {
    this.guesses.set(playerId, this.checkGuess(playerId, lat, lng));
    this.drafts.delete(playerId);
    this.touch();
    this.maybeEndRound();
  }

  /** A pin placed but not locked in yet. It counts if the round ends before the player locks in. */
  setDraft(playerId, lat, lng) {
    this.drafts.set(playerId, this.checkGuess(playerId, lat, lng));
    this.lastActivity = this.now();
  }

  checkGuess(playerId, lat, lng) {
    if (this.phase !== PHASES.ROUND) throw new GameError('There is no round in progress.');
    if (!this.players.has(playerId)) throw new GameError('You are not part of this game.');
    if (this.guesses.has(playerId)) throw new GameError('You already guessed this round.');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) {
      throw new GameError('That is not a valid map position.');
    }
    // Leaflet allows panning across the antimeridian; normalise to [-180, 180).
    return { lat, lng: ((((lng + 180) % 360) + 360) % 360) - 180 };
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
    const active = [...this.players.values()].filter((p) => p.connected);
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
      if (!guess) return { playerId: player.id, guess: null, locked: false, distanceKm: null, score: 0 };
      const distanceKm = haversineKm(guess, answer);
      return { playerId: player.id, guess, locked, distanceKm, score: score(distanceKm, this.scaleKm) };
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
    this.onChange = null;
  }

  imageForRound(index) {
    if (index < 0 || index > this.roundIndex) return null;
    return this.images[index];
  }

  /** What one player is allowed to see. Never leaks the answer of a running round. */
  snapshot(playerId) {
    const nameOf = (id) => this.players.get(id)?.name ?? 'Left the game';
    const publicAnswer = (a) => ({ lat: a.lat, lng: a.lng, caption: a.caption });
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
      scaleKm: this.scaleKm,
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
