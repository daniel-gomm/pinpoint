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
      const reason = err?.name === 'TimeoutError' ? 'it did not answer in time' : 'the connection failed';
      throw new ImmichError(`Could not reach Immich at ${this.url}: ${reason}.`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const detail = Array.isArray(data.message) ? data.message.join(', ') : data.message;
      if (res.status === 401) throw new ImmichError('Immich did not accept the API key.', 400);
      if (res.status === 403) throw new ImmichError(`The Immich API key is missing a permission${detail ? ` (${detail})` : ''}.`, 400);
      if (res.status === 404 || res.status === 400) throw new ImmichError(detail || 'Immich could not find that.', 404);
      throw new ImmichError(`Immich answered with an error (${res.status}${detail ? `: ${detail}` : ''}).`);
    }
    return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
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

  /** Up to 1000 random pictures matching the filter, with their camera data. */
  random(filter) {
    return this.request('/search/random', {
      method: 'POST',
      body: { type: 'IMAGE', withExif: true, visibility: 'timeline', size: 1000, ...filter },
    });
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
