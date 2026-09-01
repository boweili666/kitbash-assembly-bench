/* ============================================================
 * 录屏 — 网页内直接把演示录成视频(MediaRecorder)
 *
 * 优先 getDisplayMedia(整页含界面;浏览器弹选择器,选"当前标签页"),
 * 可混入麦克风解说;不可用时回退为只录 3D 画布(canvas.captureStream)。
 * 输出 WebM(VP9/VP8 + Opus),通过 KB.saveFile 保存。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var btn = document.getElementById('btnRecord');
  if (!btn) return;
  var label = btn.querySelector('.lbl');

  var rec = null, chunks = [], stream = null, micStream = null, audioCtx = null;
  var t0 = 0, timer = 0;

  function fmt(s) {
    var m = Math.floor(s / 60), r = Math.floor(s % 60);
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }

  function pickMime() {
    var list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (var i = 0; i < list.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(list[i])) return list[i];
    }
    return '';
  }

  function start() {
    if (!window.MediaRecorder) { KB.toast('Recording is not supported in this browser'); return; }
    var md = navigator.mediaDevices;
    var getVideo = (md && md.getDisplayMedia)
      ? md.getDisplayMedia({
          video: { frameRate: 60 }, audio: true,
          preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude'
        })
      : Promise.reject(new Error('no-display-capture'));

    getVideo.catch(function (err) {
      if (err && err.name === 'NotAllowedError') throw err; // 用户取消
      // 回退:只录 3D 视口
      KB.toast('Screen capture unavailable — recording the 3D viewport only');
      return document.getElementById('viewport').captureStream(60);
    }).then(function (video) {
      var micP = (md && md.getUserMedia)
        ? md.getUserMedia({ audio: true }).catch(function () { return null; })
        : Promise.resolve(null);
      return micP.then(function (mic) { return { video: video, mic: mic }; });
    }).then(function (r) {
      micStream = r.mic;
      var tracks = r.video.getVideoTracks().slice();
      var audioTracks = [];
      var tabAudio = r.video.getAudioTracks();
      if (micStream || tabAudio.length) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var dest = audioCtx.createMediaStreamDestination();
        if (tabAudio.length) audioCtx.createMediaStreamSource(new MediaStream(tabAudio)).connect(dest);
        if (micStream) audioCtx.createMediaStreamSource(micStream).connect(dest);
        audioTracks = dest.stream.getAudioTracks();
        tabAudio.forEach(function (t) { tracks.push(t); }); // 便于统一停止
      }
      stream = new MediaStream(tracks.filter(function (t) { return t.kind === 'video'; }).concat(audioTracks));
      stream._all = tracks; // 记录源轨道以便释放
      var mime = pickMime();
      chunks = [];
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : { videoBitsPerSecond: 8e6 });
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = finish;
      // 用户在浏览器的"停止共享"条上结束时也收尾
      tracks[0].addEventListener('ended', function () { stop(); });
      rec.start(1000);
      t0 = performance.now();
      btn.classList.add('rec-on');
      label.textContent = '00:00';
      timer = setInterval(function () { label.textContent = fmt((performance.now() - t0) / 1000); }, 500);
      KB.toast('Recording… click Rec again to stop and save');
    }).catch(function (err) {
      if (err && err.name === 'NotAllowedError') KB.toast('Recording canceled');
      else KB.toast('Could not start recording: ' + (err.message || err.name || err));
    });
  }

  function stop() {
    if (rec && rec.state !== 'inactive') rec.stop();
  }

  function finish() {
    clearInterval(timer);
    var blob = new Blob(chunks, { type: 'video/webm' });
    if (stream) {
      (stream._all || []).forEach(function (t) { t.stop(); });
      stream.getTracks().forEach(function (t) { t.stop(); });
    }
    if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
    if (audioCtx) audioCtx.close();
    stream = micStream = audioCtx = rec = null;
    chunks = [];
    btn.classList.remove('rec-on');
    label.textContent = 'Rec';
    if (!blob.size) { KB.toast('Nothing was recorded'); return; }
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var name = 'kitbash-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.webm';
    KB.saveFile(blob, name, 'Recording saved: ' + name + ' (' + (blob.size / 1048576).toFixed(1) + ' MB)');
  }

  btn.addEventListener('click', function () { rec ? stop() : start(); });
  window.KBRecord = { isRecording: function () { return !!rec; }, stop: stop };
})();
