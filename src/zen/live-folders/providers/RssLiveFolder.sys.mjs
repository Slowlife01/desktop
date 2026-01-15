// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { nsZenLiveFolderProvider } from "resource:///modules/zen/ZenLiveFolder.sys.mjs";

const lazy = {}
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["browser/zen-live-folders.ftl"])
);


export class nsRssLiveFolderProvider extends nsZenLiveFolderProvider {
  static type = "rss";
  state = {};

  constructor({ id, state, manager }) {
    super({ id, state, manager });

    this.state.url = state.url;
    this.state.interval = state.interval;
    this.state.maxItems = state.maxItems ?? 20;
    this.state.timeRange = state.timeRange ?? 2 * 60 * 60 * 1000;
    this.state.lastFetched = state.lastFetched;

    this.parser = new DOMParser();
  }

  async fetchItems() {
    try {
      const response = await this.fetch(this.state.url);
      if (!response.ok) {
        return [];
      }

      const text = await response.text();
      const doc = this.parser.parseFromString(text, "text/xml");

      const cutoffTime = Date.now() - this.state.timeRange;

      const isAtom = doc.querySelector("feed > entry") !== null;
      const selector = isAtom ? "entry" : "item";
      const elements = doc.querySelectorAll(selector);

      const items = Array.from(elements)
        .map((item) => {
          const title = item.querySelector("title")?.textContent || "";

          const linkNode = item.querySelector("link");
          const url =
            isAtom && linkNode ? linkNode.getAttribute("href") : linkNode?.textContent || "";

          const guid = item.querySelector(isAtom ? "id" : "guid")?.textContent;
          const id = guid || url;

          const dateStr = item.querySelector(isAtom ? "updated" : "pubDate")?.textContent;
          const date = dateStr ? new Date(dateStr) : null;

          return { title, url, id, date };
        })
        .filter((item) => {
          if (!item.url || !item.date) {
            return false;
          }
          return !isNaN(item.date.getTime()) && item.date.getTime() >= cutoffTime;
        })
        .slice(0, this.state.maxItems)
        .map(({ title, url, id }) => ({ title, url, id }));

      return items;
    } catch (e) {
      return [];
    }
  }

  _buildItemLimitOptions() {
    const entries = [10, 20, 30];
    return entries.map((entry) => {
      return {
        l10nId: "zen-rss-live-folder-option-item-limit-num",
        l10nArgs: { limit: entry },
        key: "maxItems",
        checked: this.state.maxItems === entry,
        value: entry,
        type: "radio",
      };
    });
  }

  _buildTimeRangeOptions() {
    const MINUTE_MS = 60 * 1000;
    const HOUR_MS = 60 * MINUTE_MS;

    const entries = [1, 2, 6, 12, 24];
    return entries.map((entry) => {
      const ms = entry * HOUR_MS;

      return {
        type: "radio",
        key: "timeRange",
        value: ms,

        l10nId: "zen-live-folder-time-range-hours",
        l10nArgs: { hours: entry },

        checked: this.state.timeRange === ms,
      };
    });
  }

  get options() {
    return [
      {
        l10nId: "zen-rss-live-folder-option-feed-url",
        key: "feedURL",
      },
      {
        l10nId: "zen-rss-live-folder-option-item-limit",
        key: "maxItems",
        options: this._buildItemLimitOptions(),
      },
      {
        l10nId: "zen-rss-live-folder-option-time-range",
        key: "timeRange",
        options: this._buildTimeRangeOptions(),
      },
    ];
  }

  async onOptionTrigger(option) {
    super.onOptionTrigger(option);

    const key = option.getAttribute("option-key");
    const value = option.getAttribute("option-value");

    if (!this.options.some((x) => x.key === key)) {
      return;
    }

    switch (key) {
      case "feedURL": {
        const input = { value: this.state.url ?? "" };
        const [prompt] = await lazy.l10n.formatValues([
          "zen-rss-live-folder-prompt-feed-url",
        ]);

        const promptOk = Services.prompt.prompt(
          this.manager.window,
          prompt,
          null,
          input,
          null,
          { value: null }
        );

        if (promptOk) {
          const raw = (input.value ?? "").trim();
          try {
            const parsed = new URL(raw);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              throw new Error();
            }
            this.state.url = parsed.href;
            this.refresh();
          } catch {
            Services.prompt.alert(
              this.manager.window,
              null,
              "Invalid URL. Please enter a valid http(s) URL."
            );
          }
        }
        break;
      }
      case "maxItems":
      case "timeRange": {
        const parsedValue = Number.parseInt(value);
        if (parsedValue) {
          this.state[key] = parsedValue;
        }
        break;
      }
    }

    this.requestSave();
  }

  serialize() {
    return {
      state: this.state,
    };
  }
}
