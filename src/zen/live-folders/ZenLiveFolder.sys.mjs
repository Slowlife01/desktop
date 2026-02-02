// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  requestIdleCallback: "resource://gre/modules/Timer.sys.mjs",
  cancelIdleCallback: "resource://gre/modules/Timer.sys.mjs",
});

export class nsZenLiveFolderProvider {
  #timerHandle = null;
  #idleCallbackHandle = null;
  state = {};

  constructor({ id, manager }) {
    this.id = id;
    this.manager = manager;
  }

  fetchItems() {
    throw new Error("Unimplemented");
  }

  getMetadata() {
    throw new Error("Unimplemented");
  }

  async refresh() {
    this.stop();
    await this.#internalFetch();
    this.start();
  }

  start() {
    const now = Date.now();
    const lastFetched = this.state.lastFetched;
    const interval = this.state.interval;

    const timeSinceLast = now - lastFetched;
    let delay = interval - timeSinceLast;

    if (delay <= 0) {
      delay = 0;
    }

    this.#scheduleNext(delay);
  }

  stop() {
    if (this.#timerHandle) {
      lazy.clearTimeout(this.#timerHandle);
      this.#timerHandle = null;
    }

    if (this.#idleCallbackHandle) {
      lazy.cancelIdleCallback(this.#idleCallbackHandle);
      this.#idleCallbackHandle = null;
    }
  }

  #scheduleNext(delay) {
    if (this.#timerHandle) {
      lazy.clearTimeout(this.#timerHandle);
    }

    this.#timerHandle = lazy.setTimeout(() => {
      const fetchWhenIdle = () => {
        this.#internalFetch();
        this.#idleCallbackHandle = null;
      };

      this.#idleCallbackHandle = lazy.requestIdleCallback(fetchWhenIdle);
      if (this.#timerHandle) {
        this.#scheduleNext(this.state.interval);
      }
    }, delay);
  }

  async #internalFetch() {
    try {
      const items = await this.fetchItems();
      this.state.lastFetched = Date.now();
      this.requestSave();

      this.manager.onLiveFolderFetch(this, items);
    } catch {}
  }

  get options() {
    return [];
  }

  onOptionTrigger(option) {
    const key = option.getAttribute("option-key");

    switch (key) {
      case "refresh": {
        this.refresh();
        break;
      }
      case "setInterval": {
        const intervalMs = Number.parseInt(option.getAttribute("option-value"));
        if (intervalMs > 0) {
          this.state.interval = intervalMs;
          this.requestSave();
          this.stop();
          this.start();
        }

        break;
      }
    }
  }

  requestSave() {
    this.manager.saveState();
  }

  // For automated tests
  fetch(url, options) {
    return fetch(url, options);
  }
}
