import exifr from 'exifr';
import { api } from './util.js';

/**
 * Reads GPS position and capture time from a photo's EXIF data, if it has any.
 * Works for JPEG and iPhone HEIC files.
 * @returns {Promise<{lat?: number, lng?: number, takenAt?: string}>}
 */
export async function readPhotoInfo(file) {
  const info = {};
  try {
    const gps = await exifr.gps(file);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      info.lat = gps.latitude;
      info.lng = gps.longitude;
    }
  } catch { /* no GPS */ }
  try {
    // Raw EXIF strings ("2023:07:14 15:30:12") are the camera's wall-clock time, which is what we store.
    const exif = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
    const raw = exif?.DateTimeOriginal ?? exif?.CreateDate;
    const m = typeof raw === 'string' && raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
    if (m && m[1] !== '0000') info.takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  } catch { /* no date */ }
  return info;
}

/**
 * Uploads the original file; the server rotates, shrinks, converts (HEIC) and strips metadata.
 * @param {string} url
 * @param {File} file
 * @param {{withLocation?: boolean, headers?: Record<string, string>, fields?: Record<string, string>}} [opts]
 */
export async function uploadPhoto(url, file, { withLocation = true, headers, fields = {} } = {}) {
  const info = await readPhotoInfo(file);
  const form = new FormData();
  form.append('image', file, file.name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (withLocation && info.lat !== undefined) {
    form.append('lat', String(info.lat));
    form.append('lng', String(info.lng));
  }
  if (info.takenAt) form.append('takenAt', info.takenAt);
  return api(url, { method: 'POST', form, headers });
}
