import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const fixture = await readFile(new URL('./fixtures/native-client.js', import.meta.url), 'utf8');
async function inject(page: Page) {
  await page.route(/\/src\/bridge\.ts(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fixture }),
  );
}
async function connect(page: Page) {
  await page
    .getByRole('button', { name: /^Connect/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Connection name', exact: true }).fill('Web server');
  await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('ftp.example.test');
  await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('deploy');
  await dialog.locator('input[name=password]').fill('not-persisted');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function side(page: Page, which: 'Local' | 'Remote', mobile: boolean) {
  if (mobile) await page.getByRole('button', { name: which, exact: true }).click();
  return page.getByRole('region', { name: `${which} files`, exact: true });
}
test('native-only production shell has no promotional or sample content', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByText('Desktop runtime unavailable', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      /Your files|Explore demo|Demo workspace|Sample files|good hands|better workflow/,
    ),
  ).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
test('connect, navigate, transfer both directions, and report a conflict', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await inject(page);
  await page.goto('/');
  await connect(page);
  const mobile = info.project.name === 'mobile';
  let local = await side(page, 'Local', mobile);
  await local.getByRole('button', { name: 'assets', exact: true }).dblclick();
  await expect(local.getByRole('button', { name: 'logo.svg', exact: true })).toBeVisible();
  await local.getByRole('button', { name: 'Back in local' }).click();
  await expect(local.getByRole('button', { name: 'app.tsx', exact: true })).toBeVisible();
  await local.getByRole('button', { name: 'app.tsx', exact: true }).click();
  await local.getByRole('button', { name: 'Upload 1', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Completed 1', exact: true })).toBeVisible();
  let remote = await side(page, 'Remote', mobile);
  await expect(remote.getByRole('button', { name: 'app.tsx', exact: true })).toBeVisible();
  await remote.getByRole('button', { name: 'robots.txt', exact: true }).click();
  await remote.getByRole('button', { name: 'Download 1', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Completed 2', exact: true })).toBeVisible();
  local = await side(page, 'Local', mobile);
  await expect(local.getByRole('button', { name: 'robots.txt', exact: true })).toBeVisible();
  await local.getByRole('button', { name: 'app.tsx', exact: true }).click();
  await local.getByRole('button', { name: 'Upload 1', exact: true }).click();
  await page.getByRole('tab', { name: 'Failed 1', exact: true }).click();
  await expect(page.locator('.transfer-state.failed')).toHaveCount(1);
  await expect(
    page.getByText('A destination entry already exists.', { exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(() => localStorage.getItem('better-ftp.profiles'));
  expect(saved).toContain('Web server');
  expect(saved).not.toContain('not-persisted');
  expect(JSON.parse(saved!)[0]).not.toHaveProperty('password');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/better-ftp-tool-${info.project.name}.png`, fullPage: true });
});
test('queue pauses between files and cancellation closes the connection', async ({
  page,
}, info) => {
  await inject(page);
  await page.goto('/');
  await connect(page);
  const local = await side(page, 'Local', info.project.name === 'mobile');
  await local.getByRole('checkbox', { name: 'Select app.tsx', exact: true }).check();
  await local.getByRole('checkbox', { name: 'Select README.md', exact: true }).check();
  await local.getByRole('button', { name: 'Upload 2', exact: true }).click();
  await page.getByRole('button', { name: 'Pause queue', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Completed 1', exact: true })).toBeVisible();
  await expect(page.locator('.transfer-state.queued')).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel README.md', exact: true }).click();
  await expect(page.locator('.transfer-state.cancelled')).toHaveCount(1);
  await local.getByRole('button', { name: 'package.json', exact: true }).click();
  await local.getByRole('button', { name: 'Upload 1', exact: true }).click();
  // If the queue remains paused, resume it before cancelling the active item.
  const resume = page.getByRole('button', { name: 'Resume queue', exact: true });
  if (await resume.isEnabled()) await resume.click();
  await expect(page.locator('.transfer-state.running')).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel package.json', exact: true }).click();
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Connect/ }).first()).toBeEnabled();
});
test('workspace controls and keyboard navigation are functional', async ({ page }, info) => {
  await inject(page);
  await page.goto('/');
  await connect(page);
  const local = await side(page, 'Local', info.project.name === 'mobile');
  await local.getByRole('textbox', { name: 'Filter local files' }).fill('app');
  await expect(local.getByRole('button', { name: 'app.tsx', exact: true })).toBeVisible();
  await expect(local.getByRole('button', { name: 'README.md', exact: true })).toHaveCount(0);
  await local.getByRole('button', { name: 'Clear local filter' }).click();
  await page.getByRole('button', { name: 'Workspace options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show hidden files', exact: true }).click();
  await expect(local.getByRole('button', { name: '.gitignore', exact: true })).toBeVisible();
  await local.getByRole('button', { name: 'assets', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(local.getByRole('button', { name: 'logo.svg', exact: true })).toBeVisible();
  await local.getByRole('button', { name: 'logo.svg', exact: true }).focus();
  await page.keyboard.press('Backspace');
  await expect(local.getByRole('button', { name: 'app.tsx', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide transfer panel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Transfers', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show transfer panel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Transfers', exact: true })).toBeVisible();
});

test('dark theme, resizable panes, and transfer tabs support keyboard controls', async ({
  page,
}, info) => {
  await inject(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await connect(page);
  if (info.project.name === 'desktop') {
    const pane = page.getByRole('region', { name: 'Local files', exact: true });
    const before = (await pane.boundingBox())!.width;
    const splitter = page.getByRole('separator', { name: 'Resize file panes', exact: true });
    await splitter.focus();
    await page.keyboard.press('ArrowLeft');
    await expect
      .poll(async () => Math.round((await pane.boundingBox())!.width))
      .toBeLessThan(Math.round(before));
  }
  const queue = page.getByRole('tab', { name: 'Queue', exact: true });
  await queue.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Completed', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Completed', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.screenshot({
    path: `/tmp/better-ftp-tool-dark-${info.project.name}.png`,
    fullPage: true,
  });
});

test('connection dismissal distinguishes clean, dirty, and reverted forms', async ({ page }) => {
  await inject(page);
  await page.goto('/');
  const open = () =>
    page
      .getByRole('button', { name: /^Connect/ })
      .first()
      .click();
  const outside = () =>
    page
      .locator('.dialog-overlay')
      .first()
      .click({ position: { x: 5, y: 5 } });
  await open();
  await outside();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await open();
  let dialog = page.getByRole('dialog', { name: 'New connection', exact: true });
  await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('ftp.example.test');
  await dialog.locator('input[name=password]').fill('keep-this-in-memory');
  await outside();
  const warning = page.getByRole('alertdialog', {
    name: 'Discard connection changes?',
    exact: true,
  });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.locator('.discard-overlay').click({ position: { x: 5, y: 5 } });
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(warning).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'Host', exact: true })).toHaveValue(
    'ftp.example.test',
  );
  await expect(dialog.locator('input[name=password]')).toHaveValue('keep-this-in-memory');
  await page.keyboard.press('Escape');
  await expect(warning).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(warning).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close connection dialog', exact: true }).click();
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('better-ftp.profiles'))).toBeNull();
  await open();
  dialog = page.getByRole('dialog', { name: 'New connection', exact: true });
  await dialog.getByRole('textbox', { name: 'Connection name', exact: true }).fill('temporary');
  await dialog.getByRole('textbox', { name: 'Connection name', exact: true }).fill('');
  await dialog.getByRole('combobox', { name: 'Protocol', exact: true }).selectOption('ftp');
  await dialog.getByRole('combobox', { name: 'Protocol', exact: true }).selectOption('sftp');
  await outside();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('active rows and status bar show measured live transfer speed', async ({ page }, info) => {
  await inject(page);
  await page.goto('/');
  await connect(page);
  const local = await side(page, 'Local', info.project.name === 'mobile');
  await local.getByRole('button', { name: 'app.tsx', exact: true }).click();
  await local.getByRole('button', { name: 'Upload 1', exact: true }).click();
  const speed = page.getByLabel('app.tsx transfer speed', { exact: true });
  await expect(speed).toHaveText(/(?:[1-9]\d*(?:\.\d+)?|0\.[1-9]\d*)\s(?:B|KB|MB)\/s/);
  await expect(page.getByLabel('Total transfer speed', { exact: true })).toHaveText(
    /[\d.]+\s(?:B|KB|MB)\/s/,
  );
  await expect(page.getByRole('tab', { name: 'Completed 1', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Completed 1', exact: true }).click();
  await expect(page.locator('[title="Average transfer speed"]')).toHaveCount(1);
});

test('unchanged saved connections dismiss without a discard warning', async ({ page }, info) => {
  await inject(page);
  await page.goto('/');
  await connect(page);
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: 'Toggle connections sidebar', exact: true }).click();
  await page
    .getByRole('button', { name: 'Web server deploy@ftp.example.test', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Edit connection', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Host', exact: true })).toHaveValue(
    'ftp.example.test',
  );
  await page
    .locator('.dialog-overlay')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('a pending connection cannot be accidentally dismissed', async ({ page }) => {
  await page.route(/\/src\/bridge\.ts(?:\?.*)?$/, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: fixture.replace(
        'async connect(profile, password) {',
        'async connect(profile, password) { await new Promise(resolve=>setTimeout(resolve,1500));',
      ),
    }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Connect/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'New connection', exact: true });
  await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('ftp.example.test');
  await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('test');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Connecting…', exact: true })).toBeDisabled();
  await page
    .locator('.dialog-overlay')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
});

test('SFTP settings support private keys, directories, timeouts and custom ports', async ({
  page,
}) => {
  await inject(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Connect/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'New connection', exact: true });
  const protocol = dialog.getByRole('combobox', { name: 'Protocol', exact: true });
  const port = dialog.getByRole('spinbutton', { name: 'Port', exact: true });
  await expect(protocol).toHaveValue('sftp');
  await expect(port).toHaveValue('22');
  await protocol.selectOption('ftp');
  await expect(port).toHaveValue('21');
  await port.fill('2222');
  await protocol.selectOption('sftp');
  await expect(port).toHaveValue('2222');
  await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('key.example.test');
  await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('deploy');
  await dialog
    .getByRole('combobox', { name: 'Authentication', exact: true })
    .selectOption('privateKey');
  await dialog.getByRole('button', { name: 'Browse SSH private key', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Private key file', exact: true })).toHaveValue(
    '/keys/id_ed25519',
  );
  await dialog.locator('input[name=password]').fill('key-passphrase-never-saved');
  await dialog.getByRole('tab', { name: 'Directories', exact: true }).click();
  await dialog.getByRole('button', { name: 'Browse default local directory', exact: true }).click();
  await expect(
    dialog.getByRole('textbox', { name: 'Default local directory', exact: true }),
  ).toHaveValue('/workspace');
  await dialog
    .getByRole('textbox', { name: 'Default remote directory', exact: true })
    .fill('/srv/www/assets');
  await dialog.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await dialog.getByRole('spinbutton', { name: 'Timeout in seconds', exact: true }).fill('60');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('better-ftp.profiles') || '[]'),
  );
  expect(saved[0]).toMatchObject({
    protocol: 'sftp',
    authMethod: 'privateKey',
    port: 2222,
    privateKeyPath: '/keys/id_ed25519',
    localPath: '/workspace',
    remotePath: '/srv/www/assets',
    timeoutSeconds: 60,
  });
  expect(JSON.stringify(saved)).not.toContain('key-passphrase-never-saved');
});

test('unknown SSH hosts need explicit fingerprint trust before authentication', async ({
  page,
}) => {
  await inject(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Connect/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'New connection', exact: true });
  await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('unknown.example.test');
  await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('deploy');
  await dialog.locator('input[name=password]').fill('not-persisted');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  const trust = page.getByRole('alertdialog', { name: 'Trust this SSH host key?', exact: true });
  await expect(trust).toBeVisible();
  await expect(trust.getByText('SHA256:verified-test-host-key', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const m = await import('/src/bridge.ts');
      return m.client.getSession();
    }),
  ).toBeNull();
  await trust.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[name=password]')).toHaveValue('not-persisted');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await trust.getByRole('button', { name: 'Trust & connect', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.connection-security')).toHaveText('SFTP');
});

test('changed SSH host keys are blocked without a trust bypass', async ({ page }) => {
  await inject(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Connect/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'New connection', exact: true });
  await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('changed.example.test');
  await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('deploy');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  const changed = page.getByRole('alertdialog', { name: 'SSH host key changed', exact: true });
  await expect(changed).toBeVisible();
  await expect(changed.getByRole('button', { name: 'Trust & connect', exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(async () => {
      const m = await import('/src/bridge.ts');
      return m.client.getSession();
    }),
  ).toBeNull();
  await changed.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeVisible();
});
