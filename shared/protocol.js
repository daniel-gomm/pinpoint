// Shapes of the data exchanged between server and browser. Types only; checked with `npm run check`.

/**
 * @typedef {'location' | 'date' | 'order'} Mode
 * @typedef {'placement' | 'points'} Scoring
 * @typedef {'minute' | 'day' | 'month' | 'year'} Precision
 */

/**
 * @typedef {object} GameSettings
 * @property {Mode} mode
 * @property {Scoring} scoring
 * @property {number} rounds
 * @property {number} roundSeconds
 * @property {number} [scale] km (location), hours (date); unused for order
 * @property {Precision} precision date mode only
 * @property {number} orderSize pictures per round in order mode
 * @property {boolean} presenter the host runs a shared screen and doesn't play
 * @property {'set' | 'players'} source an existing picture set, or pictures the players add in the lobby
 * @property {string} [setId]
 */

/**
 * @typedef {{lat: number, lng: number}} LocationGuess
 * @typedef {{time: number}} DateGuess ms since epoch, wall-clock time read as UTC
 * @typedef {{order: number[]}} OrderGuess picture slots from earliest to latest
 * @typedef {LocationGuess | DateGuess | OrderGuess} Guess
 */

/**
 * @typedef {object} MapSetup a custom map image instead of the world map; coordinates are pixels (lat = y, lng = x)
 * @property {string} url
 * @property {number} width
 * @property {number} height
 * @property {number | null} metersWide
 */

/**
 * @typedef {object} Setup per-game data every client needs to render the guessing UI
 * @property {MapSetup | null} [map] location
 * @property {Precision} [precision] date
 * @property {{start: number, end: number}} [range] date; end is exclusive
 * @property {number} [size] order
 */

/**
 * @typedef {object} ResultEntry
 * @property {string} playerId
 * @property {string} name
 * @property {boolean} sitOut true when it was this player's own picture
 * @property {Guess | null} guess
 * @property {boolean} locked false when the pick counted without being locked in
 * @property {number | null} distance km / % of map (location), hours (date), wrong pairs (order)
 * @property {number} points exponential 0–5000 score
 * @property {number | null} placement players beaten (ties count half)
 * @property {number | null} rank 1 = closest
 * @property {number} score what was added to the total, depending on the scoring setting
 */

/**
 * @typedef {object} RoundResult
 * @property {number} index
 * @property {any} answer {lat, lng, caption} | {time, caption} | {order, pictures}
 * @property {string[]} imageUrls
 * @property {ResultEntry[]} guesses best first, sitting-out players last
 */

/**
 * @typedef {object} PlayerView
 * @property {string} id
 * @property {string} name
 * @property {boolean} connected
 * @property {number} total
 * @property {number} points tie-breaker
 * @property {boolean} guessed
 * @property {boolean} sittingOut
 * @property {{count: number, ready: number} | null} photos pictures added in a players-bring-photos game
 */

/**
 * @typedef {object} Snapshot everything one person may see, sent on every change
 * @property {string} code
 * @property {string} setName
 * @property {'lobby' | 'round' | 'reveal' | 'finished'} phase
 * @property {string} you
 * @property {string | null} hostId
 * @property {{id: string, name: string, connected: boolean} | null} presenter
 * @property {Omit<GameSettings, 'scale' | 'setId'>} settings
 * @property {number} totalRounds
 * @property {number | null} scale
 * @property {Setup | null} setup
 * @property {number} serverNow
 * @property {PlayerView[]} players ranked
 * @property {{index: number, imageUrls: string[], deadline: number | null, sittingOut: boolean,
 *   myGuess: Guess | null, myDraft: Guess | null} | null} round
 * @property {RoundResult | null} reveal
 * @property {RoundResult[] | null} history
 */

export {};
