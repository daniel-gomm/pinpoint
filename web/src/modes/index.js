import location from './location.js';
import date from './date.js';
import order from './order.js';

/**
 * Everything the game screens need to know about one mode.
 * @typedef {import('../../../shared/protocol.js').Snapshot} Snapshot
 * @typedef {import('../../../shared/protocol.js').RoundResult} RoundResult
 * @typedef {{setLocked: (locked: boolean) => void, destroy: () => void}} Picker
 * @typedef {object} ModeUI
 * @property {string} title shown in the lobby, e.g. "Guess the place"
 * @property {string} emptyPrompt lock button text before anything is picked
 * @property {boolean} showsPhotos the picker shows the round's pictures itself (no separate photo panel)
 * @property {(el: HTMLElement, ctx: {state: Snapshot, initial: any, color: string, onPick: (guess: any) => void}) => Picker} createPicker
 * @property {(el: HTMLElement, result: RoundResult, ctx: {state: Snapshot, colorOf: (id: string) => string}) => () => void} renderAnswer
 * @property {(distance: number | null, state: Snapshot) => string} formatOff
 * @property {(result: RoundResult, state: Snapshot) => any} [answerNote] extra line under the reveal photo
 * @property {(state: Snapshot) => any} [initialGuess] a guess that is valid before the player touches anything
 */

/** @type {Record<string, ModeUI>} */
export const MODES = { location, date, order };
