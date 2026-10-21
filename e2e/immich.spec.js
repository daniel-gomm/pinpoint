import { test, expect } from '@playwright/test';
import { fakeImmich, asset } from '../server/test/fake-immich.js';
import { joinGame, newPlayer, clickMap } from './helpers.js';

test('Immich: connect, host from an album, links only for the host', async ({ page, browser }) => {
  page.on('pageerror', (err) => { throw err; });
  const immich = await fakeImmich({
    assets: Array.from({ length: 6 }, (_, i) => asset(i)),
    partnerAssets: [asset(50)],
    permissions: ['asset.read', 'asset.view', 'album.read', 'partner.read'],
  });

  // connect on the Picture sets page; a wrong key is refused with a clear message
  await page.goto('/#/sets');
  const panel = page.locator('.immich-panel');
  await panel.locator('input[name=url]').fill(`${immich.url}/`);
  await panel.locator('input[name=apiKey]').fill('wrong');
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('#toast')).toHaveText('Immich did not accept the API key.');
  await panel.locator('input[name=apiKey]').fill('secret');
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel).toContainText(`Connected to ${immich.url} as Daniel (Immich 3.2.2).`);

  // host a place game from the album
  await page.goto('/#/');
  const form = page.locator('form.host');
  await form.locator('.choice', { hasText: 'Immich' }).click();
  await expect(form.locator('select[name=albumId] option')).toHaveCount(2);
  const warning = form.getByText('including private ones');
  await expect(warning).toBeVisible();
  // partner photos only for the whole library: an album already holds what is shared in it
  const partners = form.getByText('Include photos Aymara shares with you');
  await expect(partners).toBeVisible();
  await form.locator('select[name=albumId]').selectOption({ label: 'Trip (6)' });
  await expect(warning).toBeHidden();
  await expect(partners).toBeHidden();
  await form.locator('input[name=rounds]').fill('2');
  await form.locator('input[name=name]').fill('Host');
  await form.getByRole('button', { name: 'Create game' }).click();
  await expect(page.locator('.lobby h1')).toHaveText('Trip');
  await expect(page.locator('.lobby')).toContainText('random pictures from Immich');
  const code = (await page.locator('.stamp-code').textContent()).trim();

  const guest = await newPlayer(browser);
  await joinGame(guest, code, 'Robin');
  await page.getByRole('button', { name: /Start game/ }).click();

  // the picture is served by the game server, not by Immich
  const photo = guest.locator('.photo img');
  await expect(photo).toHaveAttribute('src', new RegExp(`^/api/games/${code}/images/0/0$`));
  await expect.poll(() => photo.evaluate((img) => /** @type {HTMLImageElement} */ (img).naturalWidth)).toBeGreaterThan(0);

  await clickMap(guest, 0.5, 0.4);
  await guest.getByRole('button', { name: 'Lock in guess' }).click();
  await page.getByRole('button', { name: 'End round now' }).click();
  await expect(page.locator('.original-links a')).toHaveAttribute('href', new RegExp(`^${immich.url}/photos/`));
  await expect(guest.locator('.results tbody tr')).toHaveCount(2);
  await expect(guest.locator('.original-links')).toHaveCount(0);
  expect(await guest.content()).not.toContain(immich.url);

  // disconnect again so other tests start without Immich
  await page.goto('/#/sets');
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: 'Disconnect' }).click();
  await expect(panel.locator('input[name=url]')).toBeVisible();
  immich.close();
});
