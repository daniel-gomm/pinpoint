import { test, expect } from '@playwright/test';
import { hostGame, joinGame, newPlayer, fixture, clickMap } from './helpers.js';

test('presenter screen + players bring their own photos, owners sit out', async ({ page, browser }) => {
  page.on('pageerror', (err) => { throw err; });
  const code = await hostGame(page, { mode: 'Place', source: 'players', presenter: true, rounds: 2, scoring: 'Points', name: 'Living room TV' });
  await expect(page.locator('.lobby-presenter')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Waiting for players' })).toBeDisabled();

  const ana = await newPlayer(browser);
  const ben = await newPlayer(browser);
  await joinGame(ana, code, 'Ana');
  await joinGame(ben, code, 'Ben');

  // Ana adds a photo with GPS in its EXIF: the place is filled in automatically
  await ana.locator('.contribute input[type=file]').setInputFiles(fixture('amsterdam.jpg'));
  await expect(ana.locator('.contribute .muted').nth(1)).toHaveText(/1 added, all ready/);
  // Ben's photo: set the place by hand on the map
  await ben.locator('.contribute input[type=file]').setInputFiles(fixture('paris.jpg'));
  await expect(ben.locator('.my-photos .thumb')).toHaveCount(1);
  await expect(page.locator('.players')).toContainText('1 picture ready');

  await page.getByRole('button', { name: 'Start game with 2 players' }).click();
  await expect(page.locator('.role-presenter .photo')).toBeVisible(); // presenter shows the picture, no map
  await expect(page.locator('.guess-map')).toHaveCount(0);

  // exactly one of the two sits out the first round
  const anaSits = await ana.locator('.role-sitting-out').count();
  const [owner, guesser] = anaSits ? [ana, ben] : [ben, ana];
  await expect(owner.locator('.presenter-note h2')).toHaveText('This is your picture');
  await clickMap(guesser, 0.5, 0.4);
  await guesser.getByRole('button', { name: 'Lock in guess' }).click();
  // the owner isn't waited for
  await expect(page.locator('.results')).toBeVisible();
  await expect(page.locator('.results')).toContainText('Own picture');
  await expect(page.getByRole('button', { name: 'Next round' })).toBeVisible();
});
