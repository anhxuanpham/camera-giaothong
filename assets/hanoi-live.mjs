export const HANOI_LIVE_CODEC = 'video/mp4; codecs="avc1.42E01E"';

export function createAppendQueue(sourceBuffer) {
  const queue = [];
  let stopped = false;
  const pump = () => {
    if (stopped || sourceBuffer.updating || !queue.length) return;
    const next = queue.shift();
    try { sourceBuffer.appendBuffer(next); }
    catch { queue.unshift(next); }
  };
  sourceBuffer.addEventListener('updateend', pump);
  return {
    push(chunk) { if (!stopped && chunk?.byteLength) { queue.push(chunk); pump(); } },
    get length() { return queue.length; },
    stop() { stopped = true; queue.length = 0; }
  };
}

export function attachHanoiLive(video, url, {
  fetchImpl = fetch, signal, onStatus,
  MediaSourceImpl = globalThis.MediaSource
} = {}) {
  if (typeof MediaSourceImpl !== 'function') {
    onStatus?.('Trình duyệt không phát được live fMP4 (MediaSource).');
    return {stop() {}};
  }
  const mediaSource = new MediaSourceImpl();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  video.muted = true;
  let queue, stopped = false, revoked = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    queue?.stop();
    try { if (mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch {}
    if (!revoked) { URL.revokeObjectURL(objectUrl); revoked = true; }
    video.removeAttribute('src');
    try { video.load(); } catch {}
  };
  mediaSource.addEventListener('sourceopen', async () => {
    try {
      if (typeof mediaSource.addSourceBuffer !== 'function') throw new Error('mse');
      const sourceBuffer = mediaSource.addSourceBuffer(HANOI_LIVE_CODEC);
      sourceBuffer.mode = 'segments';
      queue = createAppendQueue(sourceBuffer);
      onStatus?.('Đang nhận luồng live…');
      const response = await fetchImpl(url, {signal});
      if (!response.ok) {
        onStatus?.(response.status === 503
          ? 'Máy chủ chưa có ffmpeg để phát live.'
          : 'Chưa lấy được live Hà Nội. Hãy thử lại.');
        stop();
        return;
      }
      if (!response.body?.getReader) throw new Error('body');
      const reader = response.body.getReader();
      video.play?.().catch(() => {});
      while (!stopped) {
        const {done, value} = await reader.read();
        if (done) break;
        queue.push(value);
        if (sourceBuffer.buffered?.length && video.currentTime - sourceBuffer.buffered.start(0) > 10 && !sourceBuffer.updating) {
          try { sourceBuffer.remove(sourceBuffer.buffered.start(0), Math.max(0, video.currentTime - 5)); } catch {}
        }
      }
      if (!stopped) onStatus?.('Luồng live đã kết thúc.');
    } catch (error) {
      onStatus?.(error?.name === 'AbortError' ? 'Đã dừng live.' : 'Chưa lấy được live Hà Nội. Hãy thử lại.');
      stop();
    }
  });
  return {stop};
}
