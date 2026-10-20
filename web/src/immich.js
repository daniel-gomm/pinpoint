import { h, api, toast } from './util.js';

/**
 * @typedef {object} ImmichStatus
 * @property {boolean} connected
 * @property {boolean} fromEnv set up through environment variables on the server
 * @property {string} [url]
 * @property {string} [version]
 * @property {string | null} [user]
 * @property {string[]} [missing] permissions the API key lacks
 * @property {string} [error] why Immich can't be reached right now
 */

/** @returns {Promise<ImmichStatus>} */
export const immichStatus = () => api('/api/immich');

/** Connect, check or disconnect the server's Immich library. Shown on the Picture sets page. */
export function immichPanel() {
  const body = h('div');
  const el = h('section', { class: 'immich-panel' },
    h('h2', {}, 'Immich'),
    h('p', { class: 'muted' }, 'Play with pictures from your Immich library without uploading them. Games pick random pictures from an album or the whole library.'),
    body);

  async function load() {
    body.replaceChildren(h('p', { class: 'muted' }, 'Checking the connection…'));
    try {
      render(await immichStatus());
    } catch (err) {
      body.replaceChildren(h('p', { class: 'warn' }, err.message));
    }
  }

  /** @param {ImmichStatus} status */
  function render(status) {
    if (!status.connected) return body.replaceChildren(connectForm());
    const who = status.user ? ` as ${status.user}` : '';
    body.replaceChildren(...[
      status.error
        ? h('p', { class: 'warn' }, status.error)
        : h('p', {}, h('strong', {}, 'Connected'), ` to ${status.url}${who} (Immich ${status.version}).`),
      status.missing?.length
        ? h('p', { class: 'warn' }, `The API key is missing these permissions: ${status.missing.join(', ')}.`)
        : null,
      status.fromEnv
        ? h('p', { class: 'hint' }, 'Set up on the server through IMMICH_URL and IMMICH_API_KEY.')
        : h('div', { class: 'row-actions' },
            h('button', { class: 'btn', type: 'button', onClick: () => body.replaceChildren(connectForm(status.url)) }, 'Change'),
            h('button', { class: 'btn danger', type: 'button', onClick: disconnect }, 'Disconnect')),
    ].filter(Boolean));
  }

  function connectForm(url = '') {
    const form = h('form', { class: 'immich-form', onSubmit: connect },
      h('label', {}, 'Immich address', h('input', { name: 'url', required: true, value: url, placeholder: 'http://192.168.1.10:2283', autocomplete: 'off' })),
      h('label', {}, 'API key', h('input', { name: 'apiKey', required: true, type: 'password', autocomplete: 'off' })),
      h('button', { class: 'btn primary', type: 'submit' }, 'Connect'),
      h('p', { class: 'hint' }, 'Create a key in Immich under Account Settings → API Keys with the permissions asset.read, asset.view and album.read. It is stored on this server only; players never see it or your Immich address.'));
    return form;

    async function connect(event) {
      event.preventDefault();
      const button = /** @type {HTMLButtonElement} */ (form.querySelector('button[type=submit]'));
      button.disabled = true;
      try {
        render(await api('/api/immich', { method: 'PUT', body: Object.fromEntries(new FormData(form)) }));
        toast('Immich connected');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        button.disabled = false;
      }
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect Immich? Games can no longer use pictures from it.')) return;
    try {
      await api('/api/immich', { method: 'DELETE' });
      render({ connected: false, fromEnv: false });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  load();
  return el;
}
