import { test, expect } from '@playwright/test';
import { fixture } from './helpers.js';

test('set editor: EXIF import, bulk date, custom map, export and import', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  page.on('dialog', (d) => d.accept());
  await page.goto('/#/sets');
  await page.locator('input[name=name]').fill('Editor test');
  await page.getByRole('button', { name: 'Create set' }).click();

  await page.locator('.editor-side input[type=file]').setInputFiles([fixture('amsterdam.jpg'), fixture('paris.jpg'), fixture('london.jpg')]);
  await expect(page.locator('.thumb')).toHaveCount(3);
  await expect(page.locator('.set-status')).toHaveText('3 pictures, all with location and date');
  await expect(page.locator('.detail input[type=datetime-local]')).toHaveValue('2019-04-27T14:05');

  // bulk: select all three and give them the same date
  await page.locator('.thumb').nth(0).click();
  await page.locator('.thumb').nth(2).click({ modifiers: ['Shift'] });
  await expect(page.locator('.detail h2')).toHaveText('3 pictures selected');
  await page.locator('.detail input[type=datetime-local]').fill('2020-02-02T12:00');
  await page.getByRole('button', { name: 'Set date for all' }).click();
  await expect(page.locator('#toast')).toHaveText('Date set for 3 pictures');

  // custom map: clears locations; place one picture on the floor plan
  await page.locator('.editor-main input[type=file]').setInputFiles(fixture('floorplan.png'));
  await expect(page.locator('.map-bar')).toContainText('Your map image');
  await expect(page.locator('.set-status')).toHaveText('3 pictures, 3 without a location');
  await page.locator('.thumb').first().click();
  await page.locator('.editor-map').click({ position: { x: 200, y: 150 } });
  await expect(page.locator('.set-status')).toHaveText('3 pictures, 2 without a location');

  // export, then import the zip as a new set
  const setId = page.url().split('/').pop();
  const zip = await (await page.request.get(`/api/sets/${setId}/export`)).body();
  await page.goto('/#/sets');
  await page.locator('input[type=file][accept*=zip]').setInputFiles({ name: 'editor-test.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.locator('#toast')).toHaveText('Imported “Editor test” with 3 pictures');
  await expect(page.locator('.map-bar')).toContainText('Your map image');
  await expect(page.locator('.set-status')).toHaveText('3 pictures, 2 without a location');
});
