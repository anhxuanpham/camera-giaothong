// Keep the last successful frame visible while the next one loads. A clock tick
// never proves capture time; only an image load can advance the download time.
export class SnapshotLoader {
  constructor({url, onState, imageFactory = () => new Image(), now = () => Date.now(), timeoutMs = 12000,
    schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id)}) {
    Object.assign(this, {url, onState, imageFactory, now, timeoutMs, schedule, unschedule});
    this.state = {status: 'idle', src: null, image: null, loadedAt: null, error: null};
    this.pending = null;
    this.active = false;
  }
  publish(patch) { this.state = {...this.state, ...patch}; this.onState(this.state); }
  start() { this.active = true; this.refresh(); }
  refresh() {
    if (!this.active || this.pending) return;
    if (!this.url) { this.publish({status: 'error', error: 'Camera này chưa có đường dẫn ảnh hợp lệ.'}); return; }
    const image = this.imageFactory();
    const url = new URL(this.url, globalThis.location?.href || 'http://127.0.0.1/');
    url.searchParams.set('t', this.now());
    const pending = {image, timer: null};
    this.pending = pending;
    const finish = success => {
      if (this.pending !== pending || !this.active) return;
      this.unschedule(pending.timer);
      image.onload = image.onerror = null;
      this.pending = null;
      if (success && image.naturalWidth > 0) this.publish({status: 'ready', src: url.href, image, loadedAt: this.now(), error: null});
      else {
        image.removeAttribute('src');
        this.publish({status: 'error', error: 'Không tải được ảnh mới. Hãy thử lại.'});
      }
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    pending.timer = this.schedule(() => finish(false), this.timeoutMs);
    this.publish({status: 'loading', error: null});
    image.src = url.href;
  }
  stop() {
    this.active = false;
    if (this.pending) {
      const {image, timer} = this.pending;
      this.unschedule(timer);
      image.onload = image.onerror = null;
      image.removeAttribute('src');
      this.pending = null;
      this.publish({status: this.state.src ? 'ready' : 'idle'});
    }
  }
}

export class SnapshotRefresh {
  constructor({intervalMs = 15000, schedule = (fn, ms) => setInterval(fn, ms), unschedule = id => clearInterval(id)} = {}) {
    Object.assign(this, {intervalMs, schedule, unschedule});
    this.loaders = new Set();
    this.enabled = false;
    this.visible = true;
    this.timer = null;
  }
  add(loader) { this.loaders.add(loader); if (this.visible) loader.start(); this.sync(); }
  remove(loader) { loader.stop(); this.loaders.delete(loader); this.sync(); }
  setEnabled(value) { this.enabled = value; this.sync(); }
  setVisible(value) {
    if (this.visible === value) return;
    this.visible = value;
    for (const loader of this.loaders) value ? loader.start() : loader.stop();
    this.sync();
  }
  sync() {
    if (this.timer !== null) this.unschedule(this.timer);
    this.timer = this.enabled && this.visible && this.loaders.size ?
      this.schedule(() => { for (const loader of this.loaders) loader.refresh(); }, this.intervalMs) : null;
  }
  dispose() {
    for (const loader of this.loaders) loader.stop();
    this.loaders.clear();
    this.sync();
  }
}
