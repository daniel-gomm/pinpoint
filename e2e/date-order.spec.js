import { test, expect } from '@playwright/test';
import { createSet, hostGame, joinGame, newPlayer } from './helpers.js';

test('date mode by year: year slider, reveal timeline', async ({ page, browser, request }) => {
  page.on('pageerror', (err) => { throw err; });
  await createSet(request, 'Family years');
  const code = await hostGame(page, { setName: 'Family years', mode: 'Date', precision: 'year', rounds: 1, scoring: 'Points' });
  await expect(page.locator('.lobby-info')).toContainText('dates to the year');
  const guest = await newPlayer(browser);
  await joinGame(guest, code, 'Robin');
  await page.getByRole('button', { name: /Start game/ }).click();

  await expect(page.locator('.datepicker')).toBeVisible();
  await expect(page.locator('.dp-time')).toHaveCount(0); // no time of day at year precision
  await expect(page.getByRole('button', { name: 'Pick a date' })).toBeDisabled();
  await page.locator('.dp-date').fill('2019');
  await page.locator('.dp-date').dispatchEvent('change');
  await expect(page.locator('.dp-display')).toHaveText('2019');
  await page.getByRole('button', { name: 'Lock in guess' }).click();
  await guest.getByRole('button', { name: 'Forward 1 year' }).click();
  await guest.getByRole('button', { name: 'Lock in guess' }).click();

  await expect(page.locator('.timeline')).toBeVisible();
  await expect(page.locator('.taken-at')).toContainText('Taken');
  await expect(page.locator('.results tbody tr').first()).toContainText(/year|Right year/);
});

test('order mode: drag pictures into order and see the correct order', async ({ page, browser, request }) => {
  page.on('pageerror', (err) => { throw err; });
  await createSet(request, 'Order me');
  const code = await hostGame(page, { setName: 'Order me', mode: 'Order', orderSize: 4, rounds: 1, scoring: 'Points', seconds: 90 });
  const guest = await newPlayer(browser);
  await joinGame(guest, code, 'Robin');
  await page.getByRole('button', { name: /Start game/ }).click();

  await expect(page.locator('.order-card')).toHaveCount(4);
  // the starting order is a valid answer and can be locked in straight away
  await expect(page.getByRole('button', { name: 'Lock in this order' })).toBeEnabled();
  await page.getByRole('button', { name: 'Move later' }).first().click();
  await expect(page.locator('.order-card').first().locator('.order-pos')).toHaveText('1');
  await page.getByRole('button', { name: 'Lock in this order' }).click();
  await guest.getByRole('button', { name: 'Lock in this order' }).click();

  await expect(page.locator('.order-strip li')).toHaveCount(4);
  await expect(page.locator('.order-row')).toHaveCount(2);
  await expect(page.locator('.results tbody')).toContainText(/Perfect order|swapped/);
});
