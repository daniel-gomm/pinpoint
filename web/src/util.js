import qrcode from 'qrcode-generator';

/**
 * Tiny DOM builder: h('div', { class: 'x', onClick }, child, ...).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...any} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/**
 * JSON API call. Throws an Error with the server's message on failure.
 * @param {string} path
 * @param {{method?: string, body?: any, form?: FormData, headers?: Record<string, string>}} [opts]
 */
export async function api(path, { method = 'GET', body, form, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

let toastTimer;
export function toast(message, kind = 'info') {
  const el = /** @type {HTMLElement} */ (document.getElementById('toast'));
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

export function formatDistance(km) {
  if (km === null || km === undefined) return 'No guess';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export const formatPoints = (n) => Math.round(n).toLocaleString();
/** Placement totals can be halves (ties). */
export const formatScore = (n, scoring) =>
  scoring === 'placement' ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : formatPoints(n);
export const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

// Distinct, colour-blind-friendly-ish hues for players on the reveal map.
const PLAYER_COLORS = ['#2E6F95', '#E08E0B', '#6A4C93', '#1B998B', '#C2185B', '#5D7A1F', '#8D5A3B', '#0F4C81'];
export const playerColor = (index) => PLAYER_COLORS[index % PLAYER_COLORS.length];

export const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  },
};

/** Full-screen view of a picture; click or Escape closes it. */
export function lightbox(src, alt = '') {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const overlay = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Enlarged picture', onClick: close },
    h('img', { src, alt }));
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

/** QR code as an inline SVG element. */
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const holder = h('div', { class: 'qr', role: 'img', 'aria-label': `QR code for ${text}` });
  holder.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return holder;
}

/** Image types the browser picker should offer, including iPhone HEIC photos. */
export const IMAGE_ACCEPT = 'image/*,.heic,.heif';
export const isImageFile = (file) => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name);
