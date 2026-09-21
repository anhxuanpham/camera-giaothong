import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppendQueue, attachHanoiLive, HANOI_LIVE_CODEC} from '../assets/hanoi-live.mjs';

test('append queue waits while the source buffer is updating', () => {
  const appended = [];
  const listeners = {};
  const sourceBuffer = {
    updating: false,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    appendBuffer(chunk) {
      if (this.updating) throw new Error('updating');
      this.updating = true;
      appended.push(chunk);
    }
  };
  const queue = createAppendQueue(sourceBuffer);
  queue.push(new Uint8Array([1]));
  queue.push(new Uint8Array([2]));
  assert.deepEqual([...appended[0]], [1]);
  assert.equal(queue.length, 1);
  sourceBuffer.updating = false;
  listeners.updateend.forEach(fn => fn());
  assert.deepEqual([...appended[1]], [2]);
  queue.stop();
  queue.push(new Uint8Array([3]));
  assert.equal(appended.length, 2);
});

test('attachHanoiLive reports missing MediaSource without fetching', () => {
  const statuses = [];
  let fetched = 0;
  const player = attachHanoiLive({muted: true}, './api/hanoi/live/x', {
    MediaSourceImpl: undefined,
    fetchImpl: async () => { fetched++; return {ok: true}; },
    onStatus: text => statuses.push(text)
  });
  assert.match(statuses[0], /MediaSource/);
  assert.equal(fetched, 0);
  player.stop();
});

test('HANOI_LIVE_CODEC is baseline AVC for the transcoded live pipe', () => {
  assert.equal(HANOI_LIVE_CODEC, 'video/mp4; codecs="avc1.42E01E"');
});
