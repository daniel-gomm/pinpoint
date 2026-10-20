import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_RE = /^[a-z0-9]{8,32}$/;
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export const isImageType = (mime) => Object.hasOwn(EXTENSIONS, mime);
const newId = () => crypto.randomBytes(6).toString('hex');

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

  create(name) {
    const set = { id: newId(), name, createdAt: new Date().toISOString(), images: [] };
    fs.mkdirSync(this.dir(set.id));
    return this.save(set);
  }

  rename(setId, name) {
    const set = this.get(setId);
    if (!set) return null;
    set.name = name;
    return this.save(set);
  }

  delete(setId) {
    const dir = this.dir(setId);
    if (!dir || !this.get(setId)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  addImage(setId, { buffer, mimetype, lat, lng, takenAt, caption }) {
    const set = this.get(setId);
    if (!set) return null;
    const id = newId();
    const file = `${id}.${EXTENSIONS[mimetype]}`;
    fs.writeFileSync(path.join(this.dir(setId), file), buffer);
    const image = { id, file, lat: lat ?? null, lng: lng ?? null, takenAt: takenAt ?? null, caption: caption ?? '' };
    set.images.push(image);
    this.save(set);
    return image;
  }

  updateImage(setId, imageId, patch) {
    const set = this.get(setId);
    const image = set?.images.find((i) => i.id === imageId);
    if (!image) return null;
    for (const key of ['lat', 'lng', 'takenAt', 'caption']) {
      if (key in patch) image[key] = patch[key];
    }
    this.save(set);
    return image;
  }

  deleteImage(setId, imageId) {
    const set = this.get(setId);
    const image = set?.images.find((i) => i.id === imageId);
    if (!image) return false;
    set.images = set.images.filter((i) => i !== image);
    fs.rmSync(path.join(this.dir(setId), image.file), { force: true });
    this.save(set);
    return true;
  }

  imagePath(setId, file) {
    const dir = this.dir(setId);
    if (!dir || path.basename(file) !== file || file === 'set.json') return null;
    return path.join(dir, file);
  }
}
