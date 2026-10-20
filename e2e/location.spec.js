import { test, expect } from '@playwright/test';
import { createSet, hostGame, joinGame, newPlayer, clickMap } from './helpers.js';

test('place mode with placement scoring, reload mid-round, rematch', async ({ page, browser, request }) => {
  page.on('pageerror', (err) => { throw err; });
  await createSet(request, 'Benelux trip');
  const code = await hostGame(page, { setName: 'Benelux trip', rounds: 2 });
  await expect(page.locator('.lobby-mode')).toHaveText('Guess the place');
  await expect(page.locator('.qr svg')).toBeVisible();

  const guest = await newPlayer(browser, { width: 390, height: 844 });
  await joinGame(guest, code, 'Robin');
  await expect(page.locator('.players li')).toHaveCount(2);
  await page.getByRole('button', { name: /Start game/ }).click();

  // round 1: host locks in, guest places a pin but only reloads
  await expect(page.locator('.guess-map')).toBeVisible();
  await clickMap(page, 0.5, 0.35);
  await page.getByRole('button', { name: 'Lock in guess' }).click();
  await guest.locator('.guess-map').scrollIntoViewIfNeeded();
  await clickMap(guest, 0.3, 0.6);
  await guest.waitForTimeout(300);
  await guest.reload();
  await expect(guest.locator('.guess-map .pin')).toHaveCount(1); // restored draft
  await page.getByRole('button', { name: 'End round now' }).click();

  await expect(page.locator('.results tbody tr')).toHaveCount(2);
  await expect(page.locator('.results')).toContainText('unlocked');
  await expect(page.locator('.results tbody')).toContainText(/\+1|\+0\.5|\+0/);

  await page.getByRole('button', { name: 'Next round' }).click();
  await page.getByRole('button', { name: 'End round now' }).click();
  await page.getByRole('button', { name: 'Show final scores' }).click();
  await expect(page.locator('.podium')).toBeVisible();
  await expect(page.locator('.breakdown th', { hasText: 'Points' })).toBeVisible(); // tie-breaker column
  await expect(guest.locator('.podium')).toBeVisible();

  await page.getByRole('button', { name: 'Play again with everyone' }).click();
  await expect(page.locator('.lobby')).toBeVisible();
  await expect(guest.locator('.lobby')).toBeVisible();
  await expect(page.locator('.players li')).toHaveCount(2);
});
