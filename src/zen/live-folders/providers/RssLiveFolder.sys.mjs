// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { nsZenLiveFolderProvider } from "resource:///modules/zen/ZenLiveFolder.sys.mjs";

const lazy = {};
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
    this.state.maxItems = state.maxItems ?? 25;
    this.state.lastFetched = state.lastFetched;

    this.parser = new DOMParser();
  }

  async fetchItems() {
    try {
      const response = await this.fetch(this.state.url);
      if (!response.ok) {
        return [{ error: "Failed to fetch" }];
      }

      const text = await response.text();
      const doc = this.parser.parseFromString(text, "text/xml");

      const isAtom = doc.querySelector("feed > entry") !== null;
      const selector = isAtom ? "entry" : "item";
      const elements = doc.querySelectorAll(selector);

      const items = Array.from(elements)
        .slice(0, this.state.maxItems)
        .map((item) => {
          const title = item.querySelector("title")?.textContent || "";

          const linkNode = item.querySelector("link");
          const url =
            isAtom && linkNode ? linkNode.getAttribute("href") : linkNode?.textContent || "";

          const guid = item.querySelector(isAtom ? "id" : "guid")?.textContent;
          const id = guid || url;

          return { title, url, id };
        })
        .filter((item) => item.url)
        .map(({ title, url, id }) => ({ title, url, id }));

      return items;
    } catch (e) {
      return [{ error: "Failed to fetch" }];
    }
  }

  _buildItemLimitOptions() {
    const entries = [10, 25, 50];
    return entries.map((entry) => {
      return {
        type: "radio",
        key: "maxItems",
        value: entry,

        l10nId: "zen-rss-live-folder-option-item-limit-num",
        l10nArgs: { limit: entry },

        checked: this.state.maxItems === entry,
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
    ];
  }

  // static so it can be easily accessed by the manager without having to create the live folder first
  static async getMetadata(url, fetchFn = fetch) {
    try {
      const response = await fetchFn(url);
      if (!response.ok) {
        return { label: "" };
      }

      const text = await response.text();
      const doc = new DOMParser().parseFromString(text, "text/xml");

      const isAtom = doc.querySelector("feed") !== null;
      const title = (
        isAtom
          ? doc.querySelector("feed > title")?.textContent
          : doc.querySelector("rss > channel > title, channel > title")?.textContent
      )?.trim();

      return { label: title || "" };
    } catch (e) {
      return { label: "" };
    }
  }

  static async promptForFeedUrl(window, initialUrl = "") {
    const input = { value: initialUrl ?? "" };
    const [prompt] = await lazy.l10n.formatValues(["zen-rss-live-folder-prompt-feed-url"]);
    const promptOk = Services.prompt.prompt(window, prompt, null, input, null, {
      value: null,
    });

    if (!promptOk) {
      return null;
    }

    const raw = (input.value ?? "").trim();
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error();
      }
      return parsed.href;
    } catch {
      Services.prompt.alert(window, null, "Invalid URL. Please enter a valid http(s) URL.");
    }

    return null;
  }

  async getMetadata() {
    return nsRssLiveFolderProvider.getMetadata(this.state.url, this.fetch.bind(this));
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
        const url = await nsRssLiveFolderProvider.promptForFeedUrl(this.manager.window);
        if (url) {
          this.state.url = url;
          this.refresh();
        }
        break;
      }
      case "maxItems": {
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
