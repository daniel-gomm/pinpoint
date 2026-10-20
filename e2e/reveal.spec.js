import { test, expect } from '@playwright/test';
import { createSet, hostGame, joinGame, newPlayer, clickMap, fixture, PHOTOS } from './helpers.js';

test('reveal picture: guess on a crop, see the full picture after the round', async ({ page, browser, request }) => {
  page.on('pageerror', (err) => { throw err; });
  const set = await createSet(request, 'Party', [PHOTOS[0]]);

  await page.goto(`/#/sets/${set.id}`);
  await expect(page.locator('.versions')).toContainText('Gives too much away?');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Add a version to guess on' }).click(),
  ]);
  await chooser.setFiles(fixture('paris.jpg'));
  await expect(page.locator('.detail-versions figcaption')).toHaveText(['Players guess on', 'Shown after the round']);
  await expect(page.locator('.thumb .badge-reveal')).toBeVisible();
  // the picture kept its own location (Amsterdam), not the new file's (Paris)
  await expect(page.locator('.detail-fields')).toContainText('Placed at 52.37');

  const code = await hostGame(page, { setName: 'Party', rounds: 1 });
  const guest = await newPlayer(browser);
  await joinGame(guest, code, 'Robin');
  await page.getByRole('button', { name: /Start game/ }).click();

  await expect(guest.locator('.photo img')).toHaveAttribute('src', `/api/games/${code}/images/0/0`);
  expect((await request.get(`/api/games/${code}/reveal/0/0`)).status()).toBe(404);
  await clickMap(guest, 0.5, 0.4);
  await guest.getByRole('button', { name: 'Lock in guess' }).click();
  await page.getByRole('button', { name: 'End round now' }).click();

  const revealed = guest.locator('.reveal-photo img');
  await expect(revealed).toHaveAttribute('src', `/api/games/${code}/reveal/0/0`);
  await expect.poll(() => revealed.evaluate((img) => /** @type {HTMLImageElement} */ (img).naturalWidth)).toBeGreaterThan(0);

  // two different files: the original upload at the reveal, the added version during the round
  const bytes = async (url) => (await request.get(url)).body();
  expect((await bytes(`/api/games/${code}/reveal/0/0`)).equals(await bytes(`/api/games/${code}/images/0/0`))).toBe(false);
});
