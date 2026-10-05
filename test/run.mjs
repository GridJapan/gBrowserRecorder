// 拡張機能を Chromium に読み込み、録画窓からテストページのタブを録画して、保存されたファイルを確認する
// 使い方: PW_CORE=<playwright-core のパス> CHROME=<Chromium のパス> node test/run.mjs [秒数] [fps] [maxHeight]
import { createRequire } from 'module';
import crypto from 'crypto'; import fs from 'fs'; import path from 'path'; import os from 'os';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');

const here = path.dirname(new URL(import.meta.url).pathname);
const ext = path.resolve(here, '../extension');
const extId = [...crypto.createHash('sha256').update(ext).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const [seconds = 6, fps = 30, maxHeight = 720] = process.argv.slice(2).map(Number);
const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'gbr-dl-'));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'gbr-')), {
  executablePath: process.env.CHROME, headless: false, viewport: { width: 1280, height: 720 },
  downloadsPath: dl, acceptDownloads: true,
  args: [
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
    '--auto-select-tab-capture-source-by-title=gbr-test-page',
    '--use-fake-device-for-media-stream', ...(process.env.MIC === '1' ? ['--use-fake-ui-for-media-stream'] : []),
    '--autoplay-policy=no-user-gesture-required', '--window-size=900,700',
  ],
});
const page = await ctx.newPage();
await page.goto('file://' + path.join(here, 'page.html'));
const recPage = await ctx.newPage();
recPage.on('console', (m) => console.log('[recorder]', m.text()));
await recPage.goto(`chrome-extension://${extId}/recorder.html`);
await recPage.evaluate((p) => chrome.storage.local.set({ prefs: p }), { fps, maxHeight, mic: process.env.MIC === '1', advanced: false });
await recPage.reload();
if (process.env.MIC === '1') {
  // マイク試験: 偽UIは呼び出し元タブ（録画窓）を選ぶので、録画窓の目印を差し替えて自分検出を回避する
  await recPage.evaluate(() => navigator.mediaDevices.setCaptureHandleConfig({ handle: 'test', permittedOrigins: ['*'] }));
}
await recPage.click('#pick');
await recPage.waitForSelector('#recording:not(.hidden)', { timeout: 10000 }).catch(async () => {
  console.log('開始失敗:', await recPage.textContent('#msg'));
  await ctx.close(); process.exit(1);
});
await page.bringToFront();
const log = [];
for (let i = 0; i < seconds; i++) {
  await recPage.waitForTimeout(1000);
  log.push(await recPage.textContent('#fps'));
}
console.log('表示:', log.join(' | '));
console.log('メッセージ:', await recPage.textContent('#msg'));
await recPage.click('#stop');
await recPage.waitForSelector('#idle:not(.hidden)', { timeout: 20000 });
console.log('結果:', await recPage.textContent('#msg'));
const file = await recPage.evaluate(async () => {
  const [d] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
  return d && d.filename;
});
const out = path.join(here, 'out.mp4');
fs.copyFileSync(file, out);
console.log('FILE:', out);
await ctx.close();
