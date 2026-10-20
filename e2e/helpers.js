import path from 'node:path';
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { FIXTURES, PHOTOS } from './global-setup.js';

export { PHOTOS };
export const fixture = (name) => path.join(FIXTURES, name);

/** Creates a picture set through the API, with locations and dates from the fixtures. */
export async function createSet(request, name, photos = PHOTOS) {
  const set = await (await request.post('/api/sets', { data: { name } })).json();
  for (const p of photos) {
    const res = await request.post(`/api/sets/${set.id}/images`, {
      multipart: {
        image: { name: `${p.name}.jpg`, mimeType: 'image/jpeg', buffer: fs.readFileSync(fixture(`${p.name}.jpg`)) },
        lat: String(p.lat), lng: String(p.lng), takenAt: p.takenAt.replace(/^(\d+):(\d+):(\d+) (\d+:\d+):\d+$/, '$1-$2-$3T$4'), caption: p.name,
      },
    });
    expect(res.ok()).toBeTruthy();
  }
  return set;
}

/** Fills in the host form on the start page and creates a game. Returns the game code. */
export async function hostGame(page, { setName, mode = 'Place', source = 'set', scoring = 'Placement', rounds = 2, seconds = 60, presenter = false, name = 'Host', precision, orderSize }) {
  await page.goto('/#/');
  const form = page.locator('form.host');
  await form.locator('.choice', { hasText: mode }).first().click();
  if (source === 'players') await form.locator('.choice', { hasText: 'Players bring them' }).click();
  if (setName) {
    const value = await form.locator('select[name=setId] option', { hasText: setName }).first().getAttribute('value');
    await form.locator('select[name=setId]').selectOption(value);
  }
  if (precision) await form.locator('select[name=precision]').selectOption(precision);
  if (orderSize) await form.locator('select[name=orderSize]').selectOption(String(orderSize));
  await form.locator('input[name=rounds]').fill(String(rounds));
  await form.locator('input[name=roundSeconds]').fill(String(seconds));
  if (scoring !== 'Placement') {
    await form.locator('summary', { hasText: 'Scoring' }).click();
    await form.locator('.choice', { hasText: scoring }).click();
  }
  if (presenter) await form.locator('input[name=presenter]').check();
  await form.locator('input[name=name]').fill(name);
  await form.getByRole('button', { name: 'Create game' }).click();
  await expect(page.locator('.stamp-code')).toBeVisible();
  return (await page.locator('.stamp-code').textContent()).trim();
}

export async function joinGame(page, code, name) {
  await page.goto(`/#/game/${code}`);
  await page.locator('input[name=name]').fill(name);
  await page.getByRole('button', { name: 'Join game' }).click();
  await expect(page.locator('.lobby, .round')).toBeVisible();
}

export async function newPlayer(browser, viewport = { width: 1280, height: 860 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('pageerror', (err) => { throw err; });
  return page;
}

/** Clicks a point of the guess map, as a fraction of its size. */
export async function clickMap(page, fx, fy, selector = '.guess-map') {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}
