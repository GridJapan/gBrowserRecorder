// 録画窓。タブを選ばせ、タブの映像＋タブの音＋マイクを mp4 に録画して保存する。

const $ = (id) => document.getElementById(id);
const DEFAULTS = { fps: 30, maxHeight: 1080, mic: true, advanced: false };
const MIME_CANDIDATES = [
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
  ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
];

const SELF_HANDLE = 'gBrowserRecorder-recorder';

let prefs = { ...DEFAULTS };
let rec = null;
let lastDownloadId = null;

// ---------- 画面 ----------

function show(mode) {
  $('idle').classList.toggle('hidden', mode !== 'idle');
  $('recording').classList.toggle('hidden', mode !== 'recording');
  $('advRow').classList.toggle('hidden', mode !== 'idle');
  $('settings').classList.toggle('hidden', !prefs.advanced);
  $('done').classList.toggle('hidden', mode !== 'idle' || !lastDownloadId);
}

function message(text) { $('msg').textContent = text || ''; }

function fmt(sec) {
  const s = Math.floor(sec);
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function bindSeg(id, key) {
  const seg = $(id);
  const paint = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === prefs[key]));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs[key] = Number(b.dataset.v);
    savePrefs();
    paint();
  });
  paint();
}

function savePrefs() { chrome.storage.local.set({ prefs }); }

// ---------- 録画 ----------

async function pickAndRecord() {
  if (rec) return;
  message('');
  const { fps, maxHeight, mic } = prefs;
  let tabStream;
  try {
    tabStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'browser',
        frameRate: { ideal: fps, max: fps },
        ...(maxHeight ? { height: { max: maxHeight }, width: { max: Math.round((maxHeight * 16) / 9) } } : {}),
      },
      // タブの音は手元でも鳴らしたまま（Meet の相手の声が聞こえなくならないように）
      audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'exclude', // 画面全体は選ばせない
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
      windowAudio: 'exclude',
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') message(`開始できません: ${e.name} ${e.message}`);
    return; // キャンセル
  }

  const videoTrack = tabStream.getVideoTracks()[0];
  const refuse = (text) => { tabStream.getTracks().forEach((t) => t.stop()); message(text); };
  if (videoTrack.getSettings().displaySurface !== 'browser') {
    return refuse('ウィンドウや画面は録画しません。一覧の「Chrome タブ」からタブを選んでください。');
  }
  if (videoTrack.getCaptureHandle?.()?.handle === SELF_HANDLE) {
    return refuse('この録画窓は録画できません。録画したいタブを選んでください。');
  }

  const notes = [];
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  if (tabStream.getAudioTracks().length > 0) {
    ctx.createMediaStreamSource(tabStream).connect(dest);
  } else {
    notes.push('タブの音声は入っていません（選択画面で「タブの音声も共有する」がオフでした）');
  }

  // マイクは録音にだけ入れる（スピーカーには流さない）
  let micStream = null;
  if (mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ctx.createMediaStreamSource(micStream).connect(dest);
    } catch (e) {
      notes.push(`マイクは入っていません（${e.name}）`);
    }
  }

  const mixed = new MediaStream([fixedSizeTrack(videoTrack), ...dest.stream.getAudioTracks()]);
  const [mimeType, ext] = MIME_CANDIDATES.find(([m]) => MediaRecorder.isTypeSupported(m)) || ['', 'webm'];
  const h = videoTrack.getSettings().height || 1080;
  const recorder = new MediaRecorder(mixed, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: h <= 720 ? 4_000_000 : h <= 1080 ? 8_000_000 : 14_000_000,
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => save();

  rec = {
    recorder, chunks, ctx, ext, fps,
    streams: [tabStream, micStream].filter(Boolean),
    videoTrack, startedAt: performance.now(), baseName: `録画_${stamp()}`,
    lastFrames: videoTrack.stats ? videoTrack.stats.deliveredFrames : 0,
  };
  // 共有元のタブが閉じられた・Chrome の「共有を停止」が押された
  videoTrack.addEventListener('ended', () => stop());

  $('preview').srcObject = new MediaStream([videoTrack]);
  recorder.start(1000);
  rec.timer = setInterval(tick, 1000);
  tick();
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setBadgeText({ text: 'REC' });
  message(notes.join(' / '));
  show('recording');
}

// mp4(avc1) は録画の途中で映像サイズが変わると壊れる。タブの大きさが変わっても
// 最初のフレームのサイズのまま記録し、違うサイズのフレームだけ黒帯つきで描き直す。
function fixedSizeTrack(track) {
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  let W = 0, H = 0, canvas = null, g = null;
  new MediaStreamTrackProcessor({ track }).readable.pipeThrough(new TransformStream({
    transform(frame, out) {
      const fw = frame.displayWidth, fh = frame.displayHeight;
      if (!W) { W = fw; H = fh; }
      if (fw === W && fh === H) { out.enqueue(frame); return; }
      if (!canvas) { canvas = new OffscreenCanvas(W, H); g = canvas.getContext('2d'); }
      const k = Math.min(W / fw, H / fh);
      const w = Math.round(fw * k), h = Math.round(fh * k);
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      g.drawImage(frame, (W - w) >> 1, (H - h) >> 1, w, h);
      const fixed = new VideoFrame(canvas, { timestamp: frame.timestamp });
      frame.close();
      out.enqueue(fixed);
    },
  })).pipeTo(generator.writable).catch(() => {});
  return generator;
}

function tick() {
  if (!rec) return;
  const t = rec.videoTrack;
  let fpsNow = 0;
  if (t.stats) {
    const n = t.stats.deliveredFrames;
    fpsNow = n - rec.lastFrames;
    rec.lastFrames = n;
  }
  const s = t.getSettings();
  $('elapsed').textContent = fmt((performance.now() - rec.startedAt) / 1000);
  $('fps').textContent = `${fpsNow} / ${rec.fps} fps　${s.width}×${s.height}`;
}

function stop() {
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  clearInterval(rec.timer);
  $('stop').disabled = true;
  $('stop').textContent = '保存しています…';
  if (rec.recorder.state !== 'inactive') rec.recorder.stop(); // → onstop → save()
  else save();
}

async function save() {
  const r = rec;
  r.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  r.ctx.close();
  $('preview').srcObject = null;
  const blob = new Blob(r.chunks, { type: r.recorder.mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({
      url, filename: `gBrowserRecorder/${r.baseName}.${r.ext}`, saveAs: false, conflictAction: 'uniquify',
    });
    await waitDownload(id);
    lastDownloadId = id;
    message(`保存しました: ${r.baseName}.${r.ext}（${(blob.size / 1024 / 1024).toFixed(1)} MB）`);
  } catch (e) {
    message(`保存に失敗しました: ${e.message}`);
  } finally {
    URL.revokeObjectURL(url);
    rec = null;
    chrome.action.setBadgeText({ text: '' });
    $('stop').disabled = false;
    $('stop').textContent = '録画停止';
    show('idle');
  }
}

function waitDownload(id) {
  return new Promise((resolve, reject) => {
    const listener = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') { chrome.downloads.onChanged.removeListener(listener); resolve(); }
      if (d.state.current === 'interrupted') { chrome.downloads.onChanged.removeListener(listener); reject(new Error('保存が中断されました')); }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

// ---------- 初期化 ----------

(async () => {
  // 自分自身（この録画窓）が選ばれたことを見分けるための目印
  navigator.mediaDevices.setCaptureHandleConfig?.({ handle: SELF_HANDLE, permittedOrigins: ['*'] });
  const stored = await chrome.storage.local.get('prefs');
  prefs = { ...DEFAULTS, ...(stored.prefs || {}) };
  bindSeg('fpsSeg', 'fps');
  bindSeg('resSeg', 'maxHeight');
  $('mic').checked = prefs.mic;
  $('mic').addEventListener('change', () => { prefs.mic = $('mic').checked; savePrefs(); });
  $('adv').checked = prefs.advanced;
  $('adv').addEventListener('change', () => {
    prefs.advanced = $('adv').checked;
    if (!prefs.advanced) Object.assign(prefs, { fps: DEFAULTS.fps, maxHeight: DEFAULTS.maxHeight, mic: DEFAULTS.mic });
    savePrefs();
    location.reload();
  });
  $('pick').addEventListener('click', pickAndRecord);
  $('stop').addEventListener('click', stop);
  $('show').addEventListener('click', () => lastDownloadId && chrome.downloads.show(lastDownloadId));
  window.addEventListener('beforeunload', (e) => { if (rec) e.preventDefault(); });
  show('idle');
})();
