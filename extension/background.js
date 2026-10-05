// 拡張機能のボタンを押したら録画窓を開く（開いていれば前に出す）。録画そのものは録画窓で行う。

const RECORDER_URL = chrome.runtime.getURL('recorder.html');

chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [RECORDER_URL] });
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.windows.create({ url: RECORDER_URL, type: 'popup', width: 440, height: 560 });
});

chrome.runtime.onInstalled.addListener(() => chrome.action.setBadgeText({ text: '' }));
