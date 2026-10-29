/* BeatCut: 100% client-side. No network requests, no uploads. */
'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const CLASSES = ['kick', 'snare', 'hat'];
  const LABEL = { kick: 'Kick', snare: 'Snare', hat: 'Hi-hat' };
  const COLOR = { kick: '#ff4d6d', snare: '#ffd166', hat: '#4cc9f0' };
  const PRIO = { kick: 3, snare: 2, hat: 1 };
  const BASE_DUR = { kick: 0.32, snare: 0.26, hat: 0.12 };
  const LEVEL = { kick: 1.0, snare: 0.9, hat: 0.6 };
  const FRAME_FPS = 12;
  const STAGE_LONG = 640;
  const MAX_ANALYZE_SEC = 180;
  const MAX_REC_SEC = 180;
  const ua = navigator.userAgent;
  const isIOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isSafari = isIOS || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua));

  const S = {
    blob: null, url: null, name: '', buffer: null, mono: null, sr: 44100, odf: null,
    onsets: [], hits: { kick: [], snare: [], hat: [] }, frameCache: new Map(), vw: 0, vh: 0,
    pattern: null, fillPattern: null, bpm: 100, bars: 4, swing: 0, vary: true, fill: true, fx: true, eq: true, loop: true,
    sens: 0.5, perClass: 6, lenMul: 1, busy: false, extractToken: 0, sel: null, play: null, lastOut: null,
  };
  window.BeatCut = S; // handy for debugging/tests

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtT = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
  let toastTimer = 0;
  function toast(msg, isErr, ms) {
    const el = $('#toast'); el.textContent = msg; el.classList.toggle('err', !!isErr); el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), ms || (isErr ? 6000 : 3000));
  }
  function setProgress(p, label) {
    const box = $('#progress');
    if (p == null) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden'); box.querySelector('i').style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
    if (label) box.querySelector('.label').textContent = label;
  }
  function once(el, ev, timeout) {
    return new Promise((res) => {
      let t = 0; const h = (e) => { clearTimeout(t); el.removeEventListener(ev, h); res(e || true); };
      el.addEventListener(ev, h); if (timeout) t = setTimeout(() => { el.removeEventListener(ev, h); res(null); }, timeout);
    });
  }
  function pickMime(list) {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ } }
    return '';
  }
  const IN_TYPES = isSafari
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  // Prefer real H.264/AAC MP4 (plays everywhere, Safari's native format); otherwise WebM.
  const OUT_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2']
    .concat(isSafari ? ['video/mp4'] : [])
    .concat(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);

  // ---------- audio context (iOS needs a user gesture) ----------
  let ac = null, master = null, comp = null;
  function audio() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { ac = new AC({ latencyHint: 'interactive' }); } catch (e) { ac = new AC(); }
      comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.12;
      master = ac.createGain(); master.gain.value = 0.9;
      master.connect(comp); comp.connect(ac.destination);
    }
    if (ac.state !== 'running') ac.resume().catch(() => {});
    return ac;
  }
  let unlocked = false;
  function unlockAudio() {
    const c = audio();
    blessVideo();
    if (unlocked && c.state === 'running') return;
    try { const b = c.createBuffer(1, 1, 22050); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); unlocked = true; } catch (e) { /* ignore */ }
  }
  ['touchend', 'pointerdown', 'click', 'keydown'].forEach((e) => window.addEventListener(e, unlockAudio, { capture: true, passive: true }));

  function decode(ab) {
    const c = audio();
    return new Promise((res, rej) => {
      let done = false;
      const ok = (b) => { if (!done) { done = true; res(b); } };
      const no = (e) => { if (!done) { done = true; rej(e || new Error('decode failed')); } };
      try { const p = c.decodeAudioData(ab, ok, no); if (p && p.then) p.then(ok, no); } catch (e) { no(e); }
    });
  }
  function blobToArrayBuffer(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsArrayBuffer(blob); });
  }

  // Fallback: play the media through Web Audio once and capture PCM in real time.
  async function captureViaElement(url, onP) {
    const c = audio(); try { await c.resume(); } catch (e) { /* ignore */ }
    const el = document.createElement('video');
    el.playsInline = true; el.setAttribute('playsinline', ''); el.preload = 'auto'; el.src = url;
    const src = c.createMediaElementSource(el);
    const proc = c.createScriptProcessor(4096, 2, 2);
    const zero = c.createGain(); zero.gain.value = 0;
    const chunks = []; let total = 0;
    proc.onaudioprocess = (e) => {
      if (el.paused || el.ended) return;
      const ib = e.inputBuffer; const a = ib.getChannelData(0); const b = ib.numberOfChannels > 1 ? ib.getChannelData(1) : a;
      const m = new Float32Array(a.length); for (let i = 0; i < a.length; i++) m[i] = (a[i] + b[i]) * 0.5;
      chunks.push(m); total += m.length;
    };
    src.connect(proc); proc.connect(zero); zero.connect(c.destination);
    try {
      await new Promise((res, rej) => {
        const iv = setInterval(() => {
          if (el.duration && isFinite(el.duration)) onP(clamp(el.currentTime / el.duration, 0, 1));
          if (el.currentTime >= MAX_ANALYZE_SEC) { el.pause(); fin(); }
        }, 200);
        const fin = () => { clearInterval(iv); res(); };
        el.onended = fin;
        el.onerror = () => { clearInterval(iv); rej(new Error('This video cannot be played in this browser.')); };
        el.play().catch((e) => { clearInterval(iv); rej(e); });
      });
    } finally { try { src.disconnect(); proc.disconnect(); zero.disconnect(); } catch (e) { /* ignore */ } el.removeAttribute('src'); }
    const buf = c.createBuffer(1, Math.max(1, total), c.sampleRate);
    const ch = buf.getChannelData(0); let o = 0; for (const m of chunks) { ch.set(m, o); o += m.length; }
    return buf;
  }

  function mixdown(buf) {
    const len = Math.min(buf.length, Math.floor(buf.sampleRate * MAX_ANALYZE_SEC));
    const out = new Float32Array(len); const nc = buf.numberOfChannels;
    for (let c = 0; c < nc; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) out[i] += d[i] / nc; }
    return out;
  }

  // ---------- DSP ----------
  function makeFFT(N) {
    const levels = Math.round(Math.log2(N)); const rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) { let x = i, r = 0; for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = Math.sin(2 * Math.PI * i / N); }
    return function (re, im) {
      for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let i = 0; i < N; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = -re[l] * sin[k] + im[l] * cos[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim; re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }
  const N_FFT = 2048;
  const fft = makeFFT(N_FFT);
  const hann = new Float64Array(N_FFT); for (let i = 0; i < N_FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N_FFT - 1));
  const fre = new Float64Array(N_FFT), fim = new Float64Array(N_FFT);

  function spectrumAt(x, start, out) { // power spectrum of a Hann-windowed frame
    for (let i = 0; i < N_FFT; i++) { const j = start + i; fre[i] = (j >= 0 && j < x.length ? x[j] : 0) * hann[i]; fim[i] = 0; }
    fft(fre, fim);
    for (let k = 0; k < N_FFT / 2; k++) out[k] = fre[k] * fre[k] + fim[k] * fim[k];
    return out;
  }

  // Onset detection function: band-balanced spectral flux on log-compressed magnitudes.
  async function computeODF(x, sr, onP) {
    const hop = Math.round(sr * 0.01);
    const nF = Math.max(1, Math.floor((x.length - N_FFT) / hop) + 1);
    const binHz = sr / N_FFT;
    const bands = [[30, 200], [200, 4000], [4000, 16000]].map(([a, b]) => [Math.max(1, Math.round(a / binHz)), Math.min(N_FFT / 2, Math.round(b / binHz))]);
    const odf = new Float32Array(nF), rms = new Float32Array(nF);
    let prev = new Float64Array(N_FFT / 2), cur = new Float64Array(N_FFT / 2);
    const pw = new Float64Array(N_FFT / 2);
    for (let f = 0; f < nF; f++) {
      const off = f * hop;
      let e = 0; for (let i = 0; i < N_FFT; i++) { const v = x[off + i] || 0; e += v * v; }
      rms[f] = Math.sqrt(e / N_FFT);
      spectrumAt(x, off, pw);
      for (let k = 0; k < N_FFT / 2; k++) cur[k] = Math.log(1 + 10 * Math.sqrt(pw[k]));
      let v = 0;
      for (const [a, b] of bands) { if (b <= a) continue; let s = 0; for (let k = a; k < b; k++) { const d = cur[k] - prev[k]; if (d > 0) s += d; } v += s / (b - a); }
      odf[f] = f === 0 ? 0 : v;
      const t = prev; prev = cur; cur = t;
      if ((f & 511) === 511) { onP && onP(f / nF); await sleep(0); }
    }
    // light smoothing
    const sm = new Float32Array(nF);
    for (let i = 0; i < nF; i++) sm[i] = 0.25 * (odf[i - 1] || 0) + 0.5 * odf[i] + 0.25 * (odf[i + 1] || 0);
    return { odf: sm, rms, hop, sr, nF };
  }

  function percentile(arr, p) { const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] : 0; }

  function pickOnsets(O, sens) {
    const { odf, rms, nF } = O;
    const W = 30; // +-300 ms adaptive window
    const top = percentile(odf, 0.995) || 1e-9;
    const maxRms = percentile(rms, 0.999) || 1e-9;
    const mult = 2.2 - 1.0 * sens; // higher sensitivity => lower threshold
    const delta = (0.14 - 0.11 * sens) * top;
    const gate = maxRms * Math.pow(10, (-28 - 22 * sens) / 20);
    const win = [];
    const res = [];
    for (let i = 1; i < nF - 1; i++) {
      const v = odf[i];
      if (!(v > odf[i - 1] && v >= odf[i + 1])) continue;
      let isMax = true; for (let j = Math.max(0, i - 3); j <= Math.min(nF - 1, i + 3); j++) if (odf[j] > v) { isMax = false; break; }
      if (!isMax) continue;
      win.length = 0; for (let j = Math.max(0, i - W); j <= Math.min(nF - 1, i + W); j++) win.push(odf[j]);
      win.sort((a, b) => a - b); const med = win[win.length >> 1];
      if (v <= med * mult + delta) continue;
      let r = 0; for (let j = i; j < Math.min(nF, i + 6); j++) r = Math.max(r, rms[j]);
      if (r < gate || r < 1e-4) continue;
      const last = res[res.length - 1];
      if (last && i - last.f < 5) { if (v > last.v) { last.f = i; last.v = v; } continue; }
      res.push({ f: i, v });
    }
    return res.map((o) => ({ f: o.f, strength: clamp(o.v / top, 0, 1.5) / 1.5 }));
  }

  function rmsRange(x, a, b) { a = Math.max(0, a | 0); b = Math.min(x.length, b | 0); let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return b > a ? Math.sqrt(s / (b - a)) : 0; }
  function peakRange(x, a, b) { a = Math.max(0, a | 0); b = Math.min(x.length, b | 0); let m = 0; for (let i = a; i < b; i++) { const v = Math.abs(x[i]); if (v > m) m = v; } return m; }

  // Refine the onset to the sample where the attack begins.
  function refineOnset(x, sr, f, hop) {
    const off = f * hop; const blk = Math.max(1, Math.round(sr * 0.001));
    const a = Math.max(0, off + (N_FFT >> 2)), b = Math.min(x.length, off + N_FFT + Math.round(sr * 0.01));
    let best = 0, bi = a;
    for (let s = a; s < b; s += blk) { const m = peakRange(x, s, s + blk); if (m > best) { best = m; bi = s; } }
    let s = bi; const thr = best * 0.22;
    while (s - blk >= a - Math.round(sr * 0.02) && s - blk >= 0 && peakRange(x, s - blk, s) > thr) s -= blk;
    return Math.max(0, s - Math.round(sr * 0.002));
  }

  function features(x, sr, o) {
    const pw = new Float64Array(N_FFT / 2);
    spectrumAt(x, o - (N_FFT >> 3), pw);
    const binHz = sr / N_FFT;
    const band = (lo, hi) => { let s = 0; const a = Math.max(1, Math.round(lo / binHz)), b = Math.min(N_FFT / 2, Math.round(hi / binHz)); for (let k = a; k < b; k++) s += pw[k]; return s; };
    const eLow = band(40, 150), eMid = band(150, 2500), eHigh = band(5000, 12000);
    let num = 0, den = 0; const kmax = Math.min(N_FFT / 2, Math.round(16000 / binHz));
    for (let k = Math.round(30 / binHz); k < kmax; k++) { num += k * binHz * pw[k]; den += pw[k]; }
    const centroid = den > 0 ? num / den : 1000;
    let lg = 0, ar = 0, n = 0; const fa = Math.round(150 / binHz), fb = Math.min(N_FFT / 2, Math.round(12000 / binHz));
    for (let k = fa; k < fb; k++) { const p = pw[k] + 1e-12; lg += Math.log(p); ar += p; n++; }
    const flat = n ? Math.exp(lg / n) / (ar / n) : 0;
    const pre = rmsRange(x, o - sr * 0.06, o - sr * 0.004), post = rmsRange(x, o, o + sr * 0.05);
    const db = 20 * Math.log10((post + 1e-9) / (pre + 1e-9));
    return { eLow, eMid, eHigh, centroid, flat, clean: clamp((db - 3) / 24, 0, 1) };
  }

  function classify(list) {
    const L = list.map((f) => [Math.log(f.eLow + 1e-12), Math.log(f.eMid + 1e-12), Math.log(f.eHigh + 1e-12)]);
    const n = L.length; const mean = [0, 0, 0], sd = [1, 1, 1];
    if (n >= 4) {
      for (let b = 0; b < 3; b++) { let m = 0; for (const l of L) m += l[b]; m /= n; let v = 0; for (const l of L) v += (l[b] - m) ** 2; mean[b] = m; sd[b] = Math.sqrt(v / n) || 1; }
    }
    list.forEach((f, i) => {
      const rel = n >= 4 ? L[i].map((v, b) => (v - mean[b]) / sd[b]) : [0, 0, 0];
      const lc = Math.log2(Math.max(20, f.centroid) / 1000); // 0 at 1 kHz
      const sc = {
        kick: 0.6 * rel[0] - 0.3 * rel[2] + clamp(-(lc + 1.4) / 1.0, -2, 2),
        snare: 0.6 * rel[1] + clamp(1 - Math.abs(lc - 0.3) / 1.4, -2, 1.2) + 0.8 * (f.flat - 0.15),
        hat: 0.6 * rel[2] - 0.3 * rel[0] + clamp((lc - 1.9) / 1.0, -2, 2),
      };
      f.scores = sc;
      const order = CLASSES.slice().sort((a, b) => sc[b] - sc[a]);
      f.cls = order[0]; f.margin = clamp((sc[order[0]] - sc[order[1]]) / 2, 0, 1);
    });
  }

  function detect() {
    const x = S.mono, sr = S.sr, O = S.odf;
    let ons = pickOnsets(O, S.sens);
    if (!ons.length) { // nothing transient: fall back to the loudest moments
      const idx = Array.from(O.rms.keys()).sort((a, b) => O.rms[b] - O.rms[a]); const keep = [];
      for (const i of idx) { if (keep.length >= 9) break; if (O.rms[i] < 1e-4) break; if (keep.every((k) => Math.abs(k - i) > 15)) keep.push(i); }
      ons = keep.sort((a, b) => a - b).map((f) => ({ f, strength: 0.3 }));
    }
    const list = [];
    for (const o of ons) {
      const s = refineOnset(x, sr, o.f, O.hop);
      if (list.length && s - list[list.length - 1].s < sr * 0.04) continue;
      const ft = features(x, sr, s); ft.s = s; ft.t = s / sr; ft.strength = o.strength; list.push(ft);
    }
    classify(list);
    list.forEach((f, i) => { f.id = i; f.rank = 0.4 * f.strength + 0.4 * f.clean + 0.2 * f.margin; });
    S.onsets = list;
    const hits = { kick: [], snare: [], hat: [] };
    for (const c of CLASSES) {
      let pool = list.filter((f) => f.cls === c).sort((a, b) => b.rank - a.rank).slice(0, S.perClass);
      let borrowed = false;
      if (!pool.length && list.length) { // make sure every row has something to play
        pool = list.slice().sort((a, b) => b.scores[c] - a.scores[c]).slice(0, Math.min(2, list.length)); borrowed = true;
      }
      hits[c] = pool.map((f, i) => makeHit(f, c, i, borrowed));
    }
    S.hits = hits;
  }
  function makeHit(f, cls, i, borrowed) {
    const sr = S.sr; let dur = BASE_DUR[cls] * S.lenMul;
    dur = Math.min(dur, Math.max(0.05, S.buffer.duration - f.t - 0.01));
    const peak = peakRange(S.mono, f.s, f.s + dur * sr) || 1e-3;
    const prev = (S._hitState || {})[cls + ':' + f.t.toFixed(3)];
    return { cls, t: f.t, dur, rank: f.rank, strength: f.strength, clean: f.clean, gain: clamp(0.7 / peak, 0.3, 10),
      on: prev ? prev.on : true, borrowed, n: i + 1, key: cls + ':' + f.t.toFixed(3) };
  }
  function allHits() { return CLASSES.flatMap((c) => S.hits[c]); }
  function usable(c) { return S.hits[c].filter((h) => h.on); }

  // ---------- video frames ----------
  // Frames for every hit are captured up front so rendering never depends on live seeking.
  // Strategy 1 ("seek"): seek, wait for 'seeked' + a presented frame (requestVideoFrameCallback or
  // double rAF), snapshot into its own canvas, verify that it differs from the previous capture
  // (retry / nudge if not). If captures look stale (Safari often paints an old frame after a seek,
  // esp. with sparse keyframes), switch to strategy 2 ("play"): play the video muted at 1x through
  // each slice window and grab frames as they are presented.
  const params = new URLSearchParams(location.search);
  const DEBUG = params.get('debug') === '1';
  const FORCE_CAPTURE = params.get('capture'); // 'seek' | 'play' (testing)
  const srcVideo = $('#srcVideo');
  const stage = $('#stage'); const sctx = stage.getContext('2d');
  const fcan = document.createElement('canvas');
  const sigCan = document.createElement('canvas'); sigCan.width = sigCan.height = 16;
  const sigCtx = sigCan.getContext('2d', { willReadFrequently: true });
  const SAME = 1.5; // mean abs pixel diff (0..255) on a 16x16 thumbnail below which two frames are "the same"
  S.captureMode = FORCE_CAPTURE || null; S.captureStats = null;

  let blessed = false;
  function blessVideo() { // iOS: play() inside a user gesture unlocks this element for later programmatic playback
    if (blessed) return; blessed = true;
    try { srcVideo.muted = true; const p = srcVideo.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
  }
  function showCapturing(on) { $('#monitor').classList.toggle('capturing', !!on); }
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  async function prepVideo() {
    const v = srcVideo;
    if (v.readyState < 1) {
      const ok = await Promise.race([once(v, 'loadedmetadata', 10000), once(v, 'error', 10000).then(() => null)]);
      if (!ok) { S.vw = 0; S.vh = 0; sizeStage(); return false; }
    }
    if (!isFinite(v.duration)) { // MediaRecorder webm has no duration; force the browser to find it
      v.currentTime = 1e7; await once(v, 'durationchange', 3000); v.currentTime = 0; await once(v, 'seeked', 2000);
    }
    await primeVideo();
    S.vw = v.videoWidth; S.vh = v.videoHeight; sizeStage();
    return S.vw > 0;
  }
  // Play briefly (muted) so Safari actually decodes and paints frames, then rewind.
  async function primeVideo() {
    const v = srcVideo; v.muted = true;
    try {
      const p = v.play(); if (p && p.then) await Promise.race([p, sleep(2000)]);
      const t0 = v.currentTime, w0 = performance.now();
      while (v.currentTime === t0 && performance.now() - w0 < 1500) await sleep(30);
    } catch (e) { /* autoplay refused; seeking still works on most browsers */ }
    v.pause();
    if (v.readyState < 2) await once(v, 'loadeddata', 4000);
  }
  function sizeStage() {
    const vw = S.vw || 16, vh = S.vh || 9; let w, h;
    if (vw >= vh) { w = STAGE_LONG; h = Math.round(STAGE_LONG * vh / vw); } else { h = STAGE_LONG; w = Math.round(STAGE_LONG * vw / vh); }
    w -= w % 2; h -= h % 2; stage.width = w; stage.height = h; fcan.width = w; fcan.height = h;
  }
  function waitPresented(timeout) { // resolves when a new video frame is presented (or after timeout)
    const v = srcVideo;
    return new Promise((res) => {
      let done = false; const f = (now, meta) => { if (!done) { done = true; res(meta || null); } };
      if (v.requestVideoFrameCallback) { try { v.requestVideoFrameCallback(f); } catch (e) { /* ignore */ } }
      setTimeout(() => f(), timeout);
    });
  }
  async function seekPrecise(t) {
    const v = srcVideo; const D = isFinite(v.duration) ? v.duration : t + 1;
    let target = clamp(t, 0, Math.max(0, D - 0.05));
    if (Math.abs(v.currentTime - target) < 1e-3) target = Math.min(D, target + 0.002);
    const presented = waitPresented(v.requestVideoFrameCallback ? 300 : 60);
    const seeked = once(v, 'seeked', 4000);
    v.currentTime = target;
    await seeked; await presented; await raf2();
  }
  function snapshot(want) { // each frame gets its own canvas (never a shared/reused surface)
    const v = srcVideo; const W = fcan.width, H = fcan.height;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    const vw = v.videoWidth || W, vh = v.videoHeight || H; const sc = Math.max(W / vw, H / vh);
    x.drawImage(v, (W - vw * sc) / 2, (H - vh * sc) / 2, vw * sc, vh * sc);
    c._want = want; c._got = v.currentTime; c._sig = signature(c);
    return c;
  }
  function signature(c) {
    sigCtx.drawImage(c, 0, 0, 16, 16);
    try { const d = sigCtx.getImageData(0, 0, 16, 16).data; const o = new Uint8Array(768); for (let i = 0, j = 0; i < d.length; i += 4) { o[j++] = d[i]; o[j++] = d[i + 1]; o[j++] = d[i + 2]; } return o; } catch (e) { return null; }
  }
  function sigDiff(a, b) { if (!a || !b) return 255; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
  const nFrames = (hit) => clamp(Math.ceil(hit.dur * FRAME_FPS), 2, 4);
  const frameKey = (hit) => hit.t.toFixed(3) + ':' + nFrames(hit);
  const frameTimes = (hit) => Array.from({ length: nFrames(hit) }, (_, k) => hit.t + 0.01 + k / FRAME_FPS);

  async function captureSeekAll(list, token, onP) {
    const out = new Map(); let prev = null, compared = 0, stale = 0, retries = 0;
    for (let h = 0; h < list.length; h++) {
      const hit = list[h]; const fr = [];
      for (const t of frameTimes(hit)) {
        if (token !== S.extractToken) return null;
        await seekPrecise(t); let c = snapshot(t);
        const ref = fr[fr.length - 1] || prev;
        if (ref && Math.abs(ref._want - t) > 0.03 && sigDiff(c._sig, ref._sig) < SAME) {
          retries++; await sleep(120); await raf2(); c = snapshot(t); // frame may not have been painted yet
          if (sigDiff(c._sig, ref._sig) < SAME) { await seekPrecise(t + 0.034); c = snapshot(t); } // nudge
        }
        fr.push(c);
      }
      if (prev && hit.t - prev._want > 0.25) { compared++; if (sigDiff(fr[0]._sig, prev._sig) < SAME) stale++; }
      prev = fr[0]; out.set(hit, fr); onP && onP((h + 1) / list.length);
      if (compared >= 3 && stale === compared) return { stale: true, out, compared, staleN: stale, retries };
    }
    if (compared >= 2 && stale / compared > 0.5) return { stale: true, out, compared, staleN: stale, retries };
    return { out, compared, staleN: stale, retries };
  }

  async function capturePlayAll(list, token, onP) {
    const v = srcVideo; v.muted = true;
    const targets = [];
    for (const hit of list) frameTimes(hit).forEach((t, k) => targets.push({ hit, k, t }));
    targets.sort((a, b) => a.t - b.t);
    const out = new Map(list.map((h) => [h, new Array(nFrames(h))]));
    let i = 0;
    const grab = (tg) => { out.get(tg.hit)[tg.k] = snapshot(tg.t); onP && onP(i / targets.length); };
    while (i < targets.length) {
      if (token !== S.extractToken) { v.pause(); return null; }
      await seekPrecise(Math.max(0, targets[i].t - 0.15));
      try { await v.play(); } catch (e) { grab(targets[i]); i++; continue; } // cannot play: take the seeked frame
      await new Promise((res) => {
        let finished = false, last = -1, lastWall = performance.now();
        const finish = () => { if (!finished) { finished = true; clearInterval(wd); res(); } };
        const step = (now, meta) => {
          if (finished) return;
          // use the more conservative clock: some engines report mediaTime ahead of the painted frame
          const mt = meta && typeof meta.mediaTime === 'number' ? Math.min(meta.mediaTime, v.currentTime) : v.currentTime;
          while (i < targets.length && targets[i].t <= mt + 0.005) { grab(targets[i]); i++; }
          if (mt !== last) { last = mt; lastWall = performance.now(); }
          const stuck = performance.now() - lastWall > 2500;
          if (i >= targets.length || token !== S.extractToken) return finish();
          if (v.ended || stuck) { grab(targets[i]); i++; return finish(); }
          if (targets[i].t - mt > 0.7) return finish(); // big gap: seek ahead instead of playing through
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else requestAnimationFrame(() => step());
        };
        const wd = setInterval(() => step(), 400); // watchdog in case frame callbacks stop
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else requestAnimationFrame(() => step());
      });
      v.pause();
    }
    for (const [, fr] of out) for (let k = 0; k < fr.length; k++) if (!fr[k]) fr[k] = fr[k - 1] || fr.find(Boolean);
    return out;
  }

  let extractChain = Promise.resolve();
  function extractAllFrames(onP) {
    const token = ++S.extractToken;
    const run = async () => {
      if (token !== S.extractToken) return;
      const hits = allHits();
      if (!S.vw) { hits.forEach((h) => (h.frames = [])); return; }
      const seen = new Set();
      const need = hits.filter((h) => { const k = frameKey(h); if (S.frameCache.has(k) || seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.t - b.t);
      if (need.length) {
        showCapturing(true);
        try {
          let res = null;
          if ((S.captureMode || 'seek') === 'seek') {
            res = await captureSeekAll(need, token, onP);
            if (!res) return;
            S.captureStats = { mode: 'seek', compared: res.compared, stale: res.staleN, retries: res.retries };
            if (res.stale && FORCE_CAPTURE !== 'seek') {
              console.warn('BeatCut: seek capture returned stale frames; switching to playback capture', res);
              S.captureMode = 'play'; S.frameCache.clear(); res = null;
              need.splice(0, need.length, ...hits.filter((h, i, a) => a.findIndex((x) => frameKey(x) === frameKey(h)) === i).sort((a, b) => a.t - b.t));
            }
          }
          if (!res) {
            const out = await capturePlayAll(need, token, onP); if (!out) return;
            S.captureStats = Object.assign({}, S.captureStats, { mode: 'play' });
            res = { out };
          }
          if (res.out) for (const [hit, fr] of res.out) S.frameCache.set(frameKey(hit), fr);
        } finally { showCapturing(false); }
      }
      for (const h of hits) h.frames = S.frameCache.get(frameKey(h)) || [];
      if (DEBUG) renderDebug();
    };
    const p = extractChain.then(run, run); extractChain = p.catch(() => {}); return p;
  }

  function renderDebug() {
    const sec = $('#secDebug'); if (!sec) return; sec.classList.remove('hidden');
    const box = $('#debugSheet'); box.innerHTML = '';
    const st = S.captureStats || {};
    $('#debugInfo').textContent = `capture: ${st.mode || '-'} · seek comparisons ${st.compared ?? '-'} / stale ${st.stale ?? '-'} / retries ${st.retries ?? '-'} · video ${S.vw}x${S.vh} · ${isFinite(srcVideo.duration) ? srcVideo.duration.toFixed(2) : '?'} s · rVFC ${'requestVideoFrameCallback' in HTMLVideoElement.prototype ? 'yes' : 'no'} · ${navigator.userAgent}`;
    let prevSig = null;
    for (const h of allHits().slice().sort((a, b) => a.t - b.t)) {
      const row = document.createElement('div'); row.className = 'dbgrow';
      const lab = document.createElement('div'); lab.className = 'dbglab'; lab.style.color = COLOR[h.cls]; lab.textContent = `${LABEL[h.cls]} #${h.n} @ ${h.t.toFixed(3)}s`; row.appendChild(lab);
      (h.frames || []).forEach((f, k) => {
        const cell = document.createElement('figure'); const c = document.createElement('canvas'); c.width = 112; c.height = Math.round(112 * f.height / f.width);
        c.getContext('2d').drawImage(f, 0, 0, c.width, c.height);
        const d = sigDiff(f._sig, prevSig); prevSig = f._sig;
        const cap = document.createElement('figcaption'); cap.textContent = `want ${f._want != null ? f._want.toFixed(3) : '?'} got ${f._got != null ? f._got.toFixed(3) : '?'} Δ${d.toFixed(1)}`;
        if (d < SAME) cap.className = 'same';
        cell.append(c, cap); row.appendChild(cell); void k;
      });
      box.appendChild(row);
    }
  }
  $('#btnDbgPlay') && ($('#btnDbgPlay').onclick = () => { S.captureMode = 'play'; S.frameCache.clear(); extractAllFrames(); });
  $('#btnDbgSeek') && ($('#btnDbgSeek').onclick = () => { S.captureMode = FORCE_CAPTURE || null; S.frameCache.clear(); extractAllFrames(); });

  // ---------- drawing ----------
  function drawHitFrame(hit, dt, step) {
    const W = stage.width, H = stage.height; const fr = hit && hit.frames;
    sctx.save(); sctx.fillStyle = '#000'; sctx.fillRect(0, 0, W, H);
    let z = 1; if (S.fx && hit) z = 1 + (hit.cls === 'kick' ? 0.08 : hit.cls === 'snare' ? 0.04 : 0.015) * Math.exp(-Math.max(0, dt) * 10);
    if (fr && fr.length) {
      const img = fr[clamp(Math.floor(Math.max(0, dt) * FRAME_FPS), 0, fr.length - 1)];
      const dw = W * z, dh = H * z; sctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else if (hit) { // audio-only source: simple generative visual
      const r = Math.min(W, H) * 0.25 * z * (1 + 0.6 * Math.exp(-Math.max(0, dt) * 8));
      sctx.fillStyle = COLOR[hit.cls]; sctx.globalAlpha = 0.85; sctx.beginPath(); sctx.arc(W / 2, H / 2, r, 0, Math.PI * 2); sctx.fill(); sctx.globalAlpha = 1;
    }
    if (S.fx && hit && dt >= 0) {
      const a = (hit.cls === 'hat' ? 0.16 : hit.cls === 'snare' ? 0.32 : 0.4) * Math.exp(-dt * 14);
      if (a > 0.01) { sctx.globalAlpha = a; sctx.fillStyle = hit.cls === 'snare' ? '#ffffff' : COLOR[hit.cls]; sctx.fillRect(0, 0, W, H); sctx.globalAlpha = 1; }
    }
    if (S.fx && step != null) { // step dots
      const n = 16, gap = Math.max(2, W * 0.006), dw = (W * 0.6 - gap * (n - 1)) / n, y = H - Math.max(8, H * 0.035) - 4, x0 = W * 0.2;
      for (let i = 0; i < n; i++) { sctx.globalAlpha = i === step ? 0.95 : 0.3; sctx.fillStyle = i === step && hit ? COLOR[hit.cls] : '#fff'; sctx.fillRect(x0 + i * (dw + gap), y, dw, Math.max(4, H * 0.012)); }
      sctx.globalAlpha = 1;
    }
    sctx.restore();
  }

  const wave = $('#wave'); const wctx = wave.getContext('2d');
  function drawWave() {
    if (!S.mono) return;
    const dpr = window.devicePixelRatio || 1; const Wc = Math.max(100, wave.clientWidth), Hc = wave.clientHeight || 110;
    wave.width = Math.round(Wc * dpr); wave.height = Math.round(Hc * dpr);
    const W = wave.width, H = wave.height, x = S.mono, len = x.length, mid = H / 2;
    wctx.clearRect(0, 0, W, H);
    const spp = len / W; let gmax = 1e-6; for (let i = 0; i < len; i += 64) gmax = Math.max(gmax, Math.abs(x[i]));
    wctx.fillStyle = '#4a4a66';
    for (let px = 0; px < W; px++) {
      const a = Math.floor(px * spp), b = Math.min(len, Math.floor((px + 1) * spp) + 1); let mn = 0, mx = 0;
      for (let i = a; i < b; i += Math.max(1, ((b - a) / 200) | 0)) { const v = x[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      wctx.fillRect(px, mid - (mx / gmax) * mid * 0.92, 1, Math.max(1, ((mx - mn) / gmax) * mid * 0.92));
    }
    const dur = len / S.sr;
    wctx.globalAlpha = 0.35;
    for (const o of S.onsets) { wctx.fillStyle = COLOR[o.cls]; wctx.fillRect((o.t / dur) * W, H * 0.3, Math.max(1, dpr), H * 0.4); }
    wctx.globalAlpha = 1;
    for (const h of allHits()) {
      const px = (h.t / dur) * W; wctx.globalAlpha = h.on ? 1 : 0.35;
      wctx.fillStyle = COLOR[h.cls]; wctx.fillRect(px, 0, Math.max(1.5, 1.5 * dpr), H);
      const ry = h.cls === 'kick' ? H - 9 * dpr : h.cls === 'snare' ? H / 2 : 9 * dpr;
      wctx.beginPath(); wctx.arc(px, ry, (S.sel === h ? 7 : 5) * dpr, 0, Math.PI * 2); wctx.fill();
      if (S.sel === h) { wctx.strokeStyle = '#fff'; wctx.lineWidth = 2 * dpr; wctx.stroke(); }
    }
    wctx.globalAlpha = 1;
  }
  wave.addEventListener('click', (e) => {
    if (!S.mono) return; const r = wave.getBoundingClientRect(); const dur = S.mono.length / S.sr;
    const t = ((e.clientX - r.left) / r.width) * dur; let best = null, bd = 1e9;
    for (const h of allHits()) { const d = Math.abs(h.t - t); if (d < bd) { bd = d; best = h; } }
    if (best && (bd / dur) * r.width < 24) previewHit(best);
  });

  function renderChips() {
    const box = $('#hitChips'); box.innerHTML = '';
    for (const c of CLASSES) {
      const row = document.createElement('div'); row.className = 'chiprow ' + c;
      const lab = document.createElement('span'); lab.className = 'lab'; lab.textContent = LABEL[c] + ' ' + S.hits[c].length; row.appendChild(lab);
      if (!S.hits[c].length) { const m = document.createElement('span'); m.className = 'muted small'; m.textContent = 'none found'; row.appendChild(m); }
      for (const h of S.hits[c]) {
        const chip = document.createElement('span'); chip.className = 'chip ' + c + (h.on ? '' : ' off') + (S.sel === h ? ' sel' : '');
        const pv = document.createElement('button'); pv.type = 'button'; pv.className = 'pv'; pv.innerHTML = '<b>▶</b> ' + fmtT(h.t) + (h.borrowed ? '*' : '');
        pv.title = 'Preview (strength ' + Math.round(h.strength * 100) + '%, clean ' + Math.round(h.clean * 100) + '%)';
        pv.onclick = () => previewHit(h);
        const tg = document.createElement('button'); tg.type = 'button'; tg.className = 'tg'; tg.textContent = h.on ? '✓' : '✗';
        tg.title = h.on ? 'Leave out of the beat' : 'Use in the beat';
        tg.onclick = () => { h.on = !h.on; (S._hitState = S._hitState || {})[h.key] = { on: h.on }; renderChips(); drawWave(); };
        chip.append(pv, tg); row.appendChild(chip);
      }
      box.appendChild(row);
    }
    $('#sourceInfo').textContent = S.name ? `${S.name} · ${fmtT(S.buffer.duration)} · ${S.onsets.length} onsets found` : '';
  }

  // ---------- sequencer ----------
  function emptyPat() { const p = {}; CLASSES.forEach((c) => (p[c] = new Array(16).fill(false))); return p; }
  function patFrom(o) { const p = emptyPat(); for (const c of CLASSES) (o[c] || []).forEach((i) => (p[c][i] = true)); return p; }
  function defaultPattern() { return patFrom({ kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] }); }
  function randomPattern() {
    const p = emptyPat(); const r = Math.random;
    p.kick[0] = true; const kp = { 2: 0.15, 3: 0.25, 6: 0.3, 7: 0.35, 8: 0.45, 10: 0.5, 11: 0.25, 13: 0.15, 14: 0.2 };
    for (const k in kp) if (r() < kp[k]) p.kick[k] = true;
    p.snare[4] = p.snare[12] = true; const sp = { 7: 0.1, 9: 0.12, 14: 0.1, 15: 0.25 };
    for (const k in sp) if (r() < sp[k]) p.snare[k] = true;
    const mode = r();
    for (let i = 0; i < 16; i++) {
      if (mode < 0.45) p.hat[i] = i % 2 === 0;
      else if (mode < 0.7) p.hat[i] = r() > 0.2;
      else if (mode < 0.85) p.hat[i] = i % 4 === 2;
      else p.hat[i] = i % 2 === 0 || r() < 0.3;
    }
    return p;
  }
  function makeFill(p) { const f = { kick: p.kick.slice(), snare: p.snare.slice(), hat: p.hat.slice() }; [12, 13, 14, 15].forEach((i) => { f.snare[i] = i !== 12 || f.snare[12]; f.hat[i] = false; }); f.snare[13] = f.snare[14] = f.snare[15] = true; f.kick[12] = true; return f; }
  function setPattern(p) { S.pattern = p; S.fillPattern = makeFill(p); renderGrid(); }

  const gridEl = $('#grid'); const cells = { kick: [], snare: [], hat: [] };
  function buildGrid() {
    gridEl.innerHTML = '';
    for (const c of CLASSES) {
      const l = document.createElement('div'); l.className = 'rl ' + c; l.textContent = LABEL[c]; gridEl.appendChild(l);
      cells[c] = [];
      for (let i = 0; i < 16; i++) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'cell ' + c + (Math.floor(i / 4) % 2 ? ' q' : '');
        b.setAttribute('aria-label', LABEL[c] + ' step ' + (i + 1));
        b.onclick = () => { S.pattern[c][i] = !S.pattern[c][i]; S.fillPattern = makeFill(S.pattern); renderGrid(); if (!S.play && S.pattern[c][i]) { const h = usable(c)[0]; if (h) previewHit(h, true); } };
        gridEl.appendChild(b); cells[c].push(b);
      }
    }
  }
  function renderGrid() { for (const c of CLASSES) cells[c].forEach((b, i) => { b.classList.toggle('on', !!S.pattern[c][i]); b.setAttribute('aria-pressed', S.pattern[c][i] ? 'true' : 'false'); }); }
  let nowStep = -1;
  function showStep(i) { if (i === nowStep) return; for (const c of CLASSES) { if (nowStep >= 0) cells[c][nowStep].classList.remove('now'); if (i >= 0) cells[c][i].classList.add('now'); } nowStep = i; }
  const stepDur = () => 60 / S.bpm / 4;
  function updateDur() { $('#outDur').textContent = (S.bars * 16 * stepDur()).toFixed(1) + ' s'; }

  // ---------- audio trigger ----------
  const choke = {};
  function trigger(hit, when, nodes) {
    const c = audio(); const src = c.createBufferSource(); src.buffer = S.buffer;
    const g = c.createGain(); const dur = hit.dur; const pk = hit.gain * LEVEL[hit.cls];
    g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(pk, when + 0.003);
    g.gain.setValueAtTime(pk, when + dur * 0.55); g.gain.linearRampToValueAtTime(0, when + dur);
    let node = src;
    if (S.eq) {
      const f = c.createBiquadFilter();
      if (hit.cls === 'kick') { f.type = 'lowshelf'; f.frequency.value = 120; f.gain.value = 6; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3500; node.connect(lp); node = lp; }
      else if (hit.cls === 'snare') { f.type = 'peaking'; f.frequency.value = 220; f.Q.value = 1; f.gain.value = 3; }
      else { f.type = 'highpass'; f.frequency.value = 2500; f.Q.value = 0.7; }
      node.connect(f); node = f;
    }
    node.connect(g); g.connect(master);
    src.start(when, Math.max(0, hit.t - 0.002), dur + 0.01);
    const prev = choke[hit.cls];
    if (prev && prev.end > when && prev.when < when) { try { prev.g.gain.cancelScheduledValues(when); prev.g.gain.setTargetAtTime(0, when, 0.004); } catch (e) { /* ignore */ } }
    choke[hit.cls] = { g, when, end: when + dur };
    if (nodes) nodes.push(src);
    return src;
  }

  // ---------- playback engine (lookahead scheduler) ----------
  function startEngine(opts) {
    stopEngine();
    const c = audio();
    const lookahead = opts.render ? 0.6 : 0.15;
    const t0 = c.currentTime + (opts.lead || 0.12);
    const P = { id: Math.random(), t0, nextStep: 0, nextTime: t0, nodes: [], vis: [], steps: [], occ: { kick: 0, snare: 0, hat: 0 },
      loop: !opts.render && S.loop, totalSteps: S.bars * 16, endTime: null, render: !!opts.render, onEnd: opts.onEnd, onTick: opts.onTick };
    S.play = P;
    const schedule = () => {
      if (S.play !== P) return;
      const now = c.currentTime;
      while (P.nextTime < now + lookahead && P.endTime == null) {
        if (P.nextStep >= P.totalSteps) {
          if (P.loop) { P.nextStep = 0; P.occ = { kick: 0, snare: 0, hat: 0 }; } else { P.endTime = P.nextTime; break; }
        }
        const step = P.nextStep % 16, bar = Math.floor(P.nextStep / 16);
        const pat = S.fill && S.bars > 1 && bar === S.bars - 1 ? S.fillPattern : S.pattern;
        const sd = stepDur(); const when = P.nextTime + (step % 2 ? S.swing * sd : 0);
        let vis = null;
        for (const cls of CLASSES) {
          if (!pat[cls][step]) continue; const pool = usable(cls); if (!pool.length) continue;
          const hit = S.vary ? pool[P.occ[cls]++ % Math.min(pool.length, 4)] : pool[0];
          trigger(hit, Math.max(when, now), P.nodes);
          if (!vis || PRIO[cls] > PRIO[vis.hit.cls]) vis = { time: when, hit };
        }
        if (vis) P.vis.push(vis);
        P.steps.push({ time: when, step });
        P.nextStep++; P.nextTime += sd;
      }
      if (P.nodes.length > 400) P.nodes.splice(0, P.nodes.length - 200);
    };
    schedule(); P.timer = setInterval(schedule, 25);
    let vi = -1, si = -1;
    const tick = () => {
      if (S.play !== P) return;
      const now = c.currentTime;
      while (vi + 1 < P.vis.length && P.vis[vi + 1].time <= now) vi++;
      while (si + 1 < P.steps.length && P.steps[si + 1].time <= now) si++;
      if (vi > 200) { P.vis.splice(0, vi - 1); vi = 1; }
      if (si > 200) { P.steps.splice(0, si - 1); si = 1; }
      const v = vi >= 0 ? P.vis[vi] : P.vis[0];
      const st = si >= 0 ? P.steps[si].step : null;
      drawHitFrame(v ? v.hit : null, v ? now - v.time : -1, st);
      showStep(st == null ? -1 : st);
      P.onTick && P.onTick(now - P.t0);
      if (P.endTime != null && now >= P.endTime + (opts.tail || 0.35)) { const cb = P.onEnd; stopEngine(); cb && cb(); return; }
      P.raf = requestAnimationFrame(tick);
    };
    P.raf = requestAnimationFrame(tick);
    // rAF stops in background tabs; keep drawing via a timer as a backup while rendering
    if (P.render) P.bk = setInterval(() => { if (document.hidden) tick(); }, 33);
    return P;
  }
  function stopEngine() {
    const P = S.play; if (!P) return; S.play = null;
    clearInterval(P.timer); clearInterval(P.bk); cancelAnimationFrame(P.raf);
    const now = audio().currentTime;
    for (const n of P.nodes) { try { n.stop(now + 0.01); } catch (e) { /* ignore */ } }
    showStep(-1); updateTransport();
  }

  let previewRaf = 0;
  function previewHit(h, quiet) {
    if (S.play) stopEngine();
    S.sel = h; const c = audio(); const when = c.currentTime + 0.02; trigger(h, when);
    if (!quiet) { renderChips(); drawWave(); }
    cancelAnimationFrame(previewRaf);
    const loop = () => { const dt = c.currentTime - when; drawHitFrame(h, dt, null); if (dt < h.dur + 0.4) previewRaf = requestAnimationFrame(loop); };
    loop();
  }

  // ---------- transport ----------
  const btnPlay = $('#btnPlay'), btnRender = $('#btnRender');
  function updateTransport() {
    btnPlay.textContent = S.play && !S.play.render ? '■ Stop' : '▶ Play';
    btnPlay.disabled = !!(S.play && S.play.render) || S.busy || !S.buffer;
    btnRender.disabled = !!(S.play && S.play.render) || S.busy || !S.buffer;
    if (!(S.play && S.play.render)) btnRender.textContent = '⏺ Render video';
  }
  btnPlay.onclick = () => {
    unlockAudio(); cancelAnimationFrame(previewRaf);
    if (S.play) { stopEngine(); return; }
    startEngine({ onEnd: updateTransport }); updateTransport();
  };

  async function renderVideo() {
    if (!S.buffer) return null;
    cancelAnimationFrame(previewRaf); stopEngine();
    const c = audio(); try { await c.resume(); } catch (e) { /* ignore */ }
    if (!window.MediaRecorder || !(stage.captureStream || stage.mozCaptureStream)) { toast('This browser cannot record video from a canvas. Try a recent Chrome, Safari or Firefox.', true); return null; }
    await extractAllFrames();
    const mime = pickMime(OUT_TYPES);
    const dest = c.createMediaStreamDestination(); comp.connect(dest);
    const vstream = stage.captureStream ? stage.captureStream(30) : stage.mozCaptureStream(30);
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    let rec;
    try { rec = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: 5000000, audioBitsPerSecond: 192000 }, mime ? { mimeType: mime } : {})); }
    catch (e) { rec = new MediaRecorder(stream); }
    const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => (rec.onstop = r));
    const total = S.bars * 16 * stepDur();
    drawHitFrame(usable('kick')[0] || allHits()[0], 1, null);
    rec.start(250);
    btnRender.textContent = 'Rendering…';
    await new Promise((res) => {
      startEngine({ render: true, lead: 0.4, tail: 0.45, onEnd: res, onTick: (t) => { btnRender.textContent = '⏺ ' + clamp(t, 0, total).toFixed(1) + ' / ' + total.toFixed(1) + ' s'; } });
      updateTransport();
    });
    if (rec.state !== 'inactive') { try { rec.requestData(); } catch (e) { /* ignore */ } rec.stop(); }
    await stopped;
    try { comp.disconnect(dest); } catch (e) { /* ignore */ }
    vstream.getTracks().forEach((t) => t.stop());
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    updateTransport();
    if (!blob.size) { toast('Recording produced no data. Please try again.', true); return null; }
    showOutput(blob, type);
    return blob;
  }
  btnRender.onclick = () => { unlockAudio(); renderVideo().catch((e) => { console.error(e); toast('Render failed: ' + (e.message || e), true); stopEngine(); updateTransport(); }); };

  function showOutput(blob, type) {
    if (S.lastOut) URL.revokeObjectURL(S.lastOut);
    const url = URL.createObjectURL(blob); S.lastOut = url; S.outBlob = blob;
    const ext = /mp4/.test(type) ? 'mp4' : 'webm';
    const name = 'beatcut-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.' + ext;
    const v = $('#outVideo'); v.src = url;
    const a = $('#lnkDownload'); a.href = url; a.download = name;
    $('#outInfo').textContent = ext.toUpperCase() + ' · ' + (blob.size / 1048576).toFixed(1) + ' MB';
    const file = (() => { try { return new File([blob], name, { type }); } catch (e) { return null; } })();
    const sb = $('#btnShare');
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      sb.classList.remove('hidden'); sb.onclick = () => navigator.share({ files: [file], title: 'BeatCut' }).catch(() => {});
    } else sb.classList.add('hidden');
    $('#secOut').classList.remove('hidden');
    $('#secOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('Done! Your music video is ready.');
  }

  // ---------- loading a source ----------
  async function loadSource(blob, name) {
    if (S.busy) return; S.busy = true; stopEngine(); updateTransport();
    // Set the source and start a muted play() synchronously, while we may still be inside the user gesture (iOS).
    if (S.url) URL.revokeObjectURL(S.url);
    S.url = URL.createObjectURL(blob); S.blob = blob; S.name = name || 'video';
    S.vw = S.vh = 0; S.ready = false; S.error = null; S.captureMode = FORCE_CAPTURE || null; S.captureStats = null;
    srcVideo.muted = true; srcVideo.playsInline = true; srcVideo.src = S.url;
    try { srcVideo.load(); const pp = srcVideo.play(); if (pp && pp.catch) pp.catch(() => {}); } catch (e) { /* ignore */ }
    $('#monitor').classList.remove('hidden'); showCapturing(true);
    $('#secHits').classList.remove('hidden'); $('#secOut').classList.add('hidden');
    S.extractToken++; S.frameCache.clear(); S.sel = null; S._hitState = {};
    try {
      if (blob.size > 400 * 1048576) toast('Large video: analysis may be slow or run out of memory on phones. Try a shorter clip.', true);
      setProgress(0.03, 'Loading video…');
      const hasVideo = await prepVideo();
      setProgress(0.08, 'Decoding audio…');
      let buf = null;
      try { buf = await decode(await blobToArrayBuffer(blob)); }
      catch (e) {
        console.warn('decodeAudioData failed, capturing via media element', e);
        setProgress(0.08, 'Listening to the audio (plays once in real time)…');
        buf = await captureViaElement(S.url, (p) => setProgress(0.08 + 0.4 * p));
      }
      if (!buf || buf.duration < 0.3) throw new Error('No usable audio found in this video.');
      S.buffer = buf; S.sr = buf.sampleRate; S.mono = mixdown(buf);
      showCapturing(false); srcVideo.pause();
      setProgress(0.5, 'Finding drum hits…');
      S.odf = await computeODF(S.mono, S.sr, (p) => setProgress(0.5 + 0.25 * p));
      detect();
      $('#monitor').classList.remove('hidden'); $('#secBeat').classList.remove('hidden');
      renderChips(); drawWave();
      setProgress(0.75, hasVideo ? 'Grabbing video frames…' : 'No video track found; using an audio visual.');
      await extractAllFrames((p) => setProgress(0.75 + 0.25 * p));
      setProgress(null);
      drawHitFrame(usable('kick')[0] || allHits()[0], 1, null);
      const n = S.hits.kick.length + S.hits.snare.length + S.hits.hat.length;
      toast(`Found ${S.onsets.length} hits · using ${S.hits.kick.length} kick, ${S.hits.snare.length} snare, ${S.hits.hat.length} hat` + (n ? '. Press Play!' : ''));
      S.ready = true;
    } catch (e) {
      console.error(e); setProgress(null); showCapturing(false); toast((e && e.message) || 'Could not analyze this video.', true);
      S.error = String((e && e.message) || e);
    } finally { S.busy = false; updateTransport(); }
  }

  let reTimer = 0;
  function redetect() {
    clearTimeout(reTimer);
    reTimer = setTimeout(async () => {
      if (!S.odf || S.busy) return;
      const was = !!S.play; stopEngine(); detect(); renderChips(); drawWave();
      setProgress(0, 'Grabbing video frames…'); await extractAllFrames((p) => setProgress(p)); setProgress(null);
      if (was) startEngine({ onEnd: updateTransport }); updateTransport();
    }, 250);
  }

  // ---------- camera recording ----------
  let camStream = null, camRec = null, camChunks = [], facing = 'environment', recStart = 0, recTimerIv = 0;
  const camPreview = $('#camPreview');
  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast(window.isSecureContext ? 'Camera recording is not supported in this browser. Choose a video instead.' : 'Camera needs a secure (https) page. Open BeatCut over https, or choose a video file instead.', true, 8000); return;
    }
    closeCamera();
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      try { camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
      catch (e2) { toast('Could not open camera/microphone: ' + (e2.message || e2.name), true, 8000); return; }
    }
    camPreview.srcObject = camStream; camPreview.muted = true; camPreview.play().catch(() => {});
    $('#recorder').classList.remove('hidden');
    $('#btnRecStart').classList.remove('hidden'); $('#btnRecStop').classList.add('hidden'); $('#btnFlip').disabled = false;
  }
  function closeCamera() {
    clearInterval(recTimerIv);
    if (camRec && camRec.state !== 'inactive') { camRec.onstop = null; try { camRec.stop(); } catch (e) { /* ignore */ } }
    camRec = null;
    if (camStream) camStream.getTracks().forEach((t) => t.stop()); camStream = null;
    camPreview.srcObject = null; $('#recorder').classList.add('hidden'); $('#recBadge').classList.add('hidden');
  }
  function startRec() {
    if (!camStream) return;
    if (!window.MediaRecorder) { toast('Recording is not supported in this browser. Use your camera app, then Choose video.', true, 8000); return; }
    const mime = pickMime(IN_TYPES); camChunks = [];
    try { camRec = new MediaRecorder(camStream, mime ? { mimeType: mime } : undefined); } catch (e) { camRec = new MediaRecorder(camStream); }
    camRec.ondataavailable = (e) => { if (e.data && e.data.size) camChunks.push(e.data); };
    camRec.onstop = () => {
      const type = (camRec && camRec.mimeType) || mime || 'video/webm';
      const blob = new Blob(camChunks, { type: type.split(';')[0] });
      closeCamera();
      if (blob.size) loadSource(blob, 'Recording'); else toast('Nothing was recorded.', true);
    };
    camRec.start(500); recStart = performance.now();
    $('#btnRecStart').classList.add('hidden'); $('#btnRecStop').classList.remove('hidden'); $('#btnFlip').disabled = true;
    $('#recBadge').classList.remove('hidden'); $('#recTimer').textContent = '0:00';
    recTimerIv = setInterval(() => {
      const s = (performance.now() - recStart) / 1000; $('#recTimer').textContent = Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
      if (s >= MAX_REC_SEC) stopRec();
    }, 250);
  }
  function stopRec() { clearInterval(recTimerIv); if (camRec && camRec.state !== 'inactive') camRec.stop(); }

  // ---------- wire up UI ----------
  $('#btnCamera').onclick = () => { unlockAudio(); stopEngine(); openCamera(); };
  $('#btnRecStart').onclick = startRec;
  $('#btnRecStop').onclick = stopRec;
  $('#btnRecCancel').onclick = closeCamera;
  $('#btnFlip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; openCamera(); };
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return; closeCamera(); loadSource(f, f.name); e.target.value = '';
  });
  const bindRange = (id, out, fmt, fn) => { const el = $(id); const upd = () => { const v = parseFloat(el.value); $(out).textContent = fmt(v); fn(v); }; el.addEventListener('input', upd); upd(); };
  bindRange('#rngBpm', '#outBpm', (v) => v + ' BPM', (v) => { S.bpm = v; updateDur(); });
  bindRange('#rngSwing', '#outSwing', (v) => Math.round(v * 100) + '%', (v) => { S.swing = v; });
  bindRange('#rngSens', '#outSens', (v) => Math.round(v * 100) + '%', (v) => { if (S.sens !== v) { S.sens = v; redetect(); } });
  bindRange('#rngPer', '#outPer', (v) => String(v), (v) => { if (S.perClass !== v) { S.perClass = v; redetect(); } });
  bindRange('#rngLen', '#outLen', (v) => Math.round(v * 100) + '%', (v) => { if (S.lenMul !== v) { S.lenMul = v; redetect(); } });
  $('#selBars').onchange = (e) => { S.bars = parseInt(e.target.value, 10); updateDur(); if (S.play) S.play.totalSteps = S.bars * 16; };
  const bindChk = (id, k) => { const el = $(id); el.onchange = () => (S[k] = el.checked); S[k] = el.checked; };
  bindChk('#chkVary', 'vary'); bindChk('#chkFill', 'fill'); bindChk('#chkFx', 'fx'); bindChk('#chkEq', 'eq'); bindChk('#chkLoop', 'loop');
  $('#btnDefault').onclick = () => setPattern(defaultPattern());
  $('#btnRandom').onclick = () => setPattern(randomPattern());
  $('#btnClear').onclick = () => setPattern(emptyPat());
  window.addEventListener('resize', () => drawWave());
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.play && !S.play.render) stopEngine(); });

  buildGrid(); setPattern(defaultPattern()); updateDur(); updateTransport(); sizeStage();
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, stage.width, stage.height);

  // expose for automated tests
  S.api = { loadSource, renderVideo, startEngine, stopEngine, previewHit, setPattern, randomPattern };
})();
