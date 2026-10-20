import './style.css';
import { homeView } from './home.js';
import { setListView, setEditorView } from './sets.js';
import { gameView } from './game.js';

/** @type {Array<[RegExp, (root: HTMLElement, ...params: string[]) => void | (() => void)]>} */
const routes = [
  [/^#\/?$/, homeView],
  [/^#\/sets\/?$/, setListView],
  [/^#\/sets\/([a-z0-9]+)$/, setEditorView],
  [/^#\/game\/([A-Za-z]{4})$/, gameView],
];

const app = document.getElementById('app');
let cleanup = null;

function route() {
  cleanup?.();
  cleanup = null;
  app.replaceChildren();
  const hash = location.hash || '#/';
  for (const [pattern, view] of routes) {
    const match = hash.match(pattern);
    if (match) {
      app.dataset.view = view.name;
      cleanup = view(app, ...match.slice(1)) ?? null;
      return;
    }
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);
route();
