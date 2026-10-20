// Generates test photos with real EXIF data (GPS + capture time) using the server's sharp.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, '.fixtures');

const dms = (deg) => {
  const d = Math.floor(Math.abs(deg));
  const m = Math.floor((Math.abs(deg) - d) * 60);
  const s = Math.round(((Math.abs(deg) - d) * 60 - m) * 60 * 100);
  return `${d}/1 ${m}/1 ${s}/100`;
};

export const PHOTOS = [
  { name: 'amsterdam', color: '#c0392b', lat: 52.3731, lng: 4.8922, takenAt: '2019:04:27 14:05:00' },
  { name: 'paris', color: '#2980b9', lat: 48.8584, lng: 2.2945, takenAt: '2021:12:24 19:40:00' },
  { name: 'brussels', color: '#27ae60', lat: 50.8467, lng: 4.3525, takenAt: '2016:08:01 09:15:00' },
  { name: 'london', color: '#8e44ad', lat: 51.5007, lng: -0.1246, takenAt: '2023:07:14 08:15:00' },
];

export default async function globalSetup() {
  const sharp = createRequire(path.join(here, '../server/package.json'))('sharp');
  fs.mkdirSync(FIXTURES, { recursive: true });
  for (const p of PHOTOS) {
    await sharp({ create: { width: 800, height: 600, channels: 3, background: p.color } })
      .withExif({
        IFD2: { DateTimeOriginal: p.takenAt },
        IFD3: {
          GPSLatitudeRef: p.lat >= 0 ? 'N' : 'S', GPSLatitude: dms(p.lat),
          GPSLongitudeRef: p.lng >= 0 ? 'E' : 'W', GPSLongitude: dms(p.lng),
        },
      })
      .jpeg()
      .toFile(path.join(FIXTURES, `${p.name}.jpg`));
  }
  await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#f4f4f4' } }).png().toFile(path.join(FIXTURES, 'floorplan.png'));
}
