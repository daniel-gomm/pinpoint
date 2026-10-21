import fs from 'node:fs';
import path from 'node:path';

/** What the game needs an Immich API key to allow. */
export const REQUIRED_PERMISSIONS = ['asset.read', 'asset.view', 'album.read'];
const TIMEOUT_MS = 20_000;

export class ImmichError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** "https://photos.example.org/", ".../api" and similar all become "https://photos.example.org". */
export function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new ImmichError('Enter the address of your Immich server, e.g. http://192.168.1.10:2283.', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ImmichError('The Immich address must start with http:// or https://.', 400);
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}`;
}

/** A small client for the parts of the Immich API the game uses. The key never leaves the server. */
export class ImmichClient {
  constructor({ url, apiKey }) {
    this.url = normalizeUrl(url);
    this.apiKey = apiKey;
  }

  /**
   * @param {string} apiPath
   * @param {{method?: string, body?: any, binary?: boolean}} [opts]
   */
  async request(apiPath, { method = 'GET', body = undefined, binary = false } = {}) {
    let res;
    const failed = (err) => {
      const reason = err?.name === 'TimeoutError' ? 'it did not answer in time' : 'the connection failed';
      return new ImmichError(`Could not reach Immich at ${this.url}: ${reason}.`);
    };
    try {
      res = await fetch(`${this.url}/api${apiPath}`, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          accept: binary ? '*/*' : 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw failed(err);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const detail = Array.isArray(data.message) ? data.message.join(', ') : data.message;
      if (res.status === 401) throw new ImmichError('Immich did not accept the API key.', 400);
      if (res.status === 403) throw new ImmichError(`The Immich API key is missing a permission${detail ? ` (${detail})` : ''}.`, 400);
      if (res.status === 404 || res.status === 400) throw new ImmichError(detail || 'Immich could not find that.', 404);
      throw new ImmichError(`Immich answered with an error (${res.status}${detail ? `: ${detail}` : ''}).`);
    }
    try {
      // The timeout also covers reading the body.
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.json();
    } catch (err) {
      throw failed(err);
    }
  }

  /** Version, account and whether the key has every permission the game needs. */
  async status() {
    const version = await this.request('/server/version');
    const [user, key] = await Promise.all([
      this.request('/users/me').catch(() => null),
      this.request('/api-keys/me').catch(() => null),
    ]);
    const permissions = key?.permissions ?? [];
    const missing = permissions.includes('all') ? [] : REQUIRED_PERMISSIONS.filter((p) => !permissions.includes(p));
    return {
      url: this.url,
      version: `${version.major}.${version.minor}.${version.patch}`,
      user: user ? user.name || user.email : null,
      missing: key ? missing : [],
    };
  }

  /** Own albums and albums shared with the user. */
  async albums() {
    const [own, shared] = await Promise.all([this.request('/albums'), this.request('/albums?shared=true')]);
    const byId = new Map([...own, ...shared].map((a) => [a.id, a]));
    return [...byId.values()]
      .map((a) => ({
        id: a.id,
        name: a.albumName || 'Untitled album',
        count: a.assetCount ?? 0,
        start: a.startDate ?? null,
        end: a.endDate ?? null,
      }))
      .filter((a) => a.count > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  album(id) {
    return this.request(`/albums/${encodeURIComponent(id)}`);
  }

  /** Up to 1000 random pictures matching the filter, with their camera data. Only the user's own pictures. */
  random(filter) {
    return this.request('/search/random', {
      method: 'POST',
      body: { type: 'IMAGE', withExif: true, visibility: 'timeline', size: 1000, ...filter },
    });
  }

  /**
   * One page of up to 1000 pictures matching the filter, newest first. Unlike `random`, this also
   * finds other people's pictures in an album shared with the user.
   * @returns {Promise<{items: any[], next: number | null}>}
   */
  async search(filter, page = 1) {
    const { assets } = await this.request('/search/metadata', {
      method: 'POST',
      body: { type: 'IMAGE', withExif: true, visibility: 'timeline', size: 1000, page, ...filter },
    });
    return { items: assets.items, next: assets.nextPage ? Number(assets.nextPage) : null };
  }

  /**
   * People who share their library with the user (Immich partner sharing), or null when the key
   * may not list them.
   * @returns {Promise<{id: string, name: string}[] | null>}
   */
  async partners() {
    try {
      const partners = await this.request('/partners?direction=shared-with');
      return partners.map((p) => ({ id: p.id, name: p.name || p.email }));
    } catch (err) {
      if (err instanceof ImmichError && err.status === 400 && /permission/.test(err.message)) return null;
      throw err;
    }
  }

  /**
   * A timeline's months ("YYYY-MM-01") and how many pictures each holds: the user's own, or a
   * partner's with `userId`. Search ignores partners, so their pictures are only found this way.
   * @returns {Promise<{timeBucket: string, count: number}[]>}
   */
  timelineMonths({ userId, favorites }) {
    return this.request(`/timeline/buckets?${timelineQuery({ userId, favorites })}`);
  }

  /**
   * One month of a timeline, one record per picture. It has no camera data; see `asset`.
   * @returns {Promise<{id: string, isImage: boolean, isTrashed: boolean, city: string | null, takenAt: string}[]>}
   */
  async timelineMonth(month, { userId, favorites }) {
    const columns = await this.request(`/timeline/bucket?${timelineQuery({ userId, favorites, timeBucket: month })}`);
    return columns.id.map((id, i) => ({
      id,
      isImage: columns.isImage[i],
      isTrashed: columns.isTrashed[i],
      city: columns.city[i],
      // fileCreatedAt is UTC; adding the offset gives the wall-clock time where it was taken
      takenAt: new Date(Date.parse(`${columns.fileCreatedAt[i]}Z`) + (columns.localOffsetHours[i] ?? 0) * 3600_000).toISOString(),
    }));
  }

  /** One picture with its camera data, in the same shape as search results. */
  asset(id) {
    return this.request(`/assets/${encodeURIComponent(id)}`);
  }

  /** The large preview Immich generates (about 1440 px, JPEG). */
  preview(assetId) {
    return this.request(`/assets/${encodeURIComponent(assetId)}/thumbnail?size=preview`, { binary: true });
  }

  /** The asset's page in the Immich web app. */
  link(assetId) {
    return `${this.url}/photos/${assetId}`;
  }
}

/** @param {{userId?: string | null, favorites?: boolean, timeBucket?: string}} params */
function timelineQuery({ userId, favorites, timeBucket }) {
  return new URLSearchParams({
    visibility: 'timeline',
    ...(userId ? { userId } : {}),
    ...(favorites ? { isFavorite: 'true' } : {}),
    ...(timeBucket ? { timeBucket } : {}),
  }).toString();
}

/**
 * The server's Immich connection: IMMICH_URL / IMMICH_API_KEY from the environment, or what was
 * entered on the Picture sets page (stored in <data>/immich.json, readable only by the server).
 */
export class ImmichConfig {
  constructor(dataDir, env = process.env) {
    this.file = path.resolve(dataDir, 'immich.json');
    this.env = env.IMMICH_URL && env.IMMICH_API_KEY ? { url: env.IMMICH_URL, apiKey: env.IMMICH_API_KEY } : null;
    this.cached = undefined;
  }

  get fromEnv() {
    return Boolean(this.env);
  }

  read() {
    if (this.env) return this.env;
    if (this.cached === undefined) {
      try {
        this.cached = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        this.cached = null;
      }
    }
    return this.cached;
  }

  /** @returns {ImmichClient | null} */
  client() {
    const config = this.read();
    return config ? new ImmichClient(config) : null;
  }

  save({ url, apiKey }) {
    const config = { url: normalizeUrl(url), apiKey };
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(config), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    this.cached = config;
  }

  clear() {
    fs.rmSync(this.file, { force: true });
    this.cached = null;
  }
}
