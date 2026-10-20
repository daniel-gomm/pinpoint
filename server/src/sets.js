import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { processImage } from './images.js';
import { parseTakenAt } from './modes.js';

const ID_RE = /^[a-z0-9]{8,32}$/;
const IMAGE_KEYS = ['lat', 'lng', 'takenAt', 'caption'];
const newId = () => crypto.randomBytes(6).toString('hex');

export class SetError extends Error {}

/**
 * Picture sets on disk: <data>/sets/<id>/set.json plus one JPEG per picture (and optionally map.jpg).
 * Pictures are already processed (rotated, resized, metadata stripped) when they get here.
 */
export class SetStore {
  constructor(dataDir) {
    this.root = path.resolve(dataDir, 'sets');
    fs.mkdirSync(this.root, { recursive: true });
  }

  dir(setId) {
    if (!ID_RE.test(setId)) return null;
    return path.join(this.root, setId);
  }

  list() {
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.get(d.name))
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(setId) {
    const dir = this.dir(setId);
    if (!dir) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'set.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  save(set) {
    const file = path.join(this.dir(set.id), 'set.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(set, null, 2));
    fs.renameSync(file + '.tmp', file);
    return set;
  }

  /** Reads, changes and saves a set. Returns null when the set doesn't exist. */
  update(setId, change) {
    const set = this.get(setId);
    if (!set) return null;
    const result = change(set);
    this.save(set);
    return result === undefined ? set : result;
  }

  create(name, extra = {}) {
    const set = { id: newId(), name, createdAt: new Date().toISOString(), map: null, images: [], ...extra };
    fs.mkdirSync(this.dir(set.id));
    return this.save(set);
  }

  rename(setId, name) {
    return this.update(setId, (set) => { set.name = name; });
  }

  delete(setId) {
    const dir = this.dir(setId);
    if (!dir || !this.get(setId)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * @param {string} setId
   * @param {{buffer: Buffer, lat?: number, lng?: number, takenAt?: string, caption?: string, contributorId?: string, contributor?: string}} fields
   */
  addImage(setId, { buffer, ...fields }) {
    const dir = this.dir(setId);
    if (!dir || !this.get(setId)) return null;
    const id = newId();
    const file = `${id}.jpg`;
    fs.writeFileSync(path.join(dir, file), buffer);
    const image = {
      id, file, lat: fields.lat ?? null, lng: fields.lng ?? null, takenAt: fields.takenAt ?? null, caption: fields.caption ?? '',
      ...(fields.contributorId ? { contributorId: fields.contributorId, contributor: fields.contributor } : {}),
    };
    return this.update(setId, (set) => { set.images.push(image); return image; });
  }

  /** Applies the same change to several pictures. Returns the changed pictures. */
  updateImages(setId, imageIds, patch) {
    return this.update(setId, (set) => {
      const changed = set.images.filter((i) => imageIds.includes(i.id));
      for (const image of changed) {
        for (const key of IMAGE_KEYS) if (key in patch) image[key] = patch[key];
      }
      return changed;
    });
  }

  deleteImages(setId, imageIds) {
    const dir = this.dir(setId);
    return this.update(setId, (set) => {
      const doomed = set.images.filter((i) => imageIds.includes(i.id));
      set.images = set.images.filter((i) => !doomed.includes(i));
      for (const image of doomed) fs.rmSync(path.join(dir, image.file), { force: true });
      return doomed.length;
    }) ?? 0;
  }

  /**
   * Switches between the world map (buffer = null) and a custom map image.
   * Pin positions mean different things on the two, so all locations are cleared.
   */
  setMap(setId, map) {
    const dir = this.dir(setId);
    return this.update(setId, (set) => {
      fs.rmSync(path.join(dir, 'map.jpg'), { force: true });
      set.map = null;
      if (map) {
        fs.writeFileSync(path.join(dir, 'map.jpg'), map.buffer);
        set.map = { file: 'map.jpg', width: map.width, height: map.height, metersWide: null };
      }
      for (const image of set.images) image.lat = image.lng = null;
    });
  }

  setMapWidth(setId, metersWide) {
    return this.update(setId, (set) => {
      if (!set.map) throw new SetError('This set uses the world map.');
      set.map.metersWide = metersWide;
    });
  }

  filePath(setId, file) {
    const dir = this.dir(setId);
    if (!dir || path.basename(file) !== file || file === 'set.json') return null;
    return path.join(dir, file);
  }

  /** A zip with set.json and all picture files, for backups or moving a set to another machine. */
  exportZip(setId) {
    const set = this.get(setId);
    if (!set) return null;
    const dir = this.dir(setId);
    const files = { 'set.json': strToU8(JSON.stringify(set, null, 2)) };
    for (const file of [...set.images.map((i) => i.file), ...(set.map ? [set.map.file] : [])]) {
      // JPEGs are already compressed; storing them is faster and barely bigger.
      files[file] = [fs.readFileSync(path.join(dir, file)), { level: 0 }];
    }
    return { name: set.name, zip: Buffer.from(zipSync(files)) };
  }

  /** Creates a new set from an exported zip. Pictures are re-processed, so a hand-made zip is safe. */
  async importZip(buffer) {
    let entries;
    try {
      entries = unzipSync(new Uint8Array(buffer));
    } catch {
      throw new SetError('That file is not a zip exported from a picture set.');
    }
    let meta;
    try {
      meta = JSON.parse(strFromU8(entries['set.json']));
    } catch {
      throw new SetError('The zip has no readable set.json.');
    }
    if (!Array.isArray(meta.images)) throw new SetError('The set.json in the zip has no pictures list.');

    const set = this.create(String(meta.name || 'Imported set').slice(0, 80));
    try {
      if (meta.map?.file && entries[meta.map.file]) {
        const map = await processImage(Buffer.from(entries[meta.map.file]), { maxEdge: 4096, quality: 90 });
        this.setMap(set.id, map);
        const metersWide = Number(meta.map.metersWide);
        if (metersWide > 0) this.setMapWidth(set.id, metersWide);
      }
      for (const image of meta.images) {
        const data = entries[image.file];
        if (!data) continue;
        const { buffer: jpeg } = await processImage(Buffer.from(data));
        this.addImage(set.id, {
          buffer: jpeg,
          lat: Number.isFinite(image.lat) ? image.lat : null,
          lng: Number.isFinite(image.lng) ? image.lng : null,
          takenAt: parseTakenAt(image.takenAt) === null ? null : image.takenAt,
          caption: String(image.caption ?? '').slice(0, 200),
        });
      }
    } catch (err) {
      this.delete(set.id);
      throw err;
    }
    return this.get(set.id);
  }
}
