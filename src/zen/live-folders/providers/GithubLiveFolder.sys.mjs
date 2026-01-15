// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { nsZenLiveFolderProvider } from "resource:///modules/zen/ZenLiveFolder.sys.mjs";

export class nsGithubLiveFolderProvider extends nsZenLiveFolderProvider {
  static type = "github";
  state = {};

  constructor({ id, state, manager }) {
    super({ id, state, manager });

    this.state.url = "https://github.com/issues/assigned";
    this.state.interval = state.interval;
    this.state.lastFetched = state.lastFetched;
    this.state.options = state.options;

    this.parser = new DOMParser();
  }

  async fetchItems() {
    try {
      const cookies = Services.cookies
        .getCookiesWithOriginAttributes("{}", "github.com")
        .filter((c) => c.isSession);
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      const searchParams = this.#buildSearchOptions();
      const url = `${this.state.url}?${searchParams}`;
      const response = await this.fetch(url, {
        headers: {
          Cookie: cookieHeader,
        },
        credentials: "include",
      });

      if (!response.ok) {
        return [];
      }

      const text = await response.text();
      const document = this.parser.parseFromString(text, "text/html");

      const issues = document.querySelectorAll(
        "div[class^=IssueItem-module__defaultRepoContainer]"
      );
      const items = [];

      if (issues.length) {
        const authors = document.querySelectorAll("a[class^=IssueItem-module__authorCreatedLink]");
        const titles = document.querySelectorAll("div[class^=Title-module__container]");
        const links = document.querySelectorAll('[data-testid="issue-pr-title-link"]');

        for (let i = 0; i < issues.length; i++) {
          const [rawRepo, rawNumber] = issues[i].childNodes;
          const author = authors[i]?.textContent;
          const title = titles[i]?.textContent;
          const issueUrl = links[i]?.href;

          const number = rawNumber.textContent.match(/[0-9]+/)[0];

          items.push({
            title,
            subtitle: author,
            url: `https://github.com/${issueUrl}`,
            id: `${rawRepo.textContent}#${number}`,
          });
        }
      }

      return items;
    } catch {}

    return [];
  }

  #buildSearchOptions() {
    let searchParams = new URLSearchParams();
    const options = [
      {
        value: "state:open",
        enabled: true,
      },
      {
        value: "sort:updated-desc",
        enabled: true,
      },
      [
        {
          value: "is:pr",
          enabled: true,
        },
        {
          value: "is:issue",
          enabled: false,
        },
      ],
      [
        {
          value: "author:@me",
          enabled: this.state.options.authorMe ?? true,
        },
        {
          value: "assignee:@me",
          enabled: this.state.options.assignedMe ?? false,
        },
        {
          value: "review-requested:@me",
          enabled: this.state.options.reviewRequested ?? false,
        },
      ],
    ];

    let outputString = "";
    for (const option of options) {
      if (Array.isArray(option)) {
        const enabledOptions = option.filter((x) => x.enabled).map((x) => x.value);
        if (enabledOptions.length) {
          outputString += ` (${enabledOptions.join(" OR ")}) `;
        }
        continue;
      }

      if (option.enabled) {
        outputString += ` ${option.value} `;
      }
    }

    searchParams.set("q", outputString);
    return searchParams.toString();
  }

  get options() {
    return [
      {
        l10nId: "zen-github-live-folder-option-author-self",
        key: "authorMe",
        checked: this.state.options.authorMe ?? true,
      },
      {
        l10nId: "zen-github-live-folder-option-assigned-self",
        key: "assignedMe",
        checked: this.state.options.assignedMe ?? false,
      },
      {
        l10nId: "zen-github-live-folder-option-review-requested",
        key: "reviewRequested",
        checked: this.state.options.reviewRequested ?? false,
      },
    ];
  }

  onOptionTrigger(option) {
    super.onOptionTrigger(option);

    const checked = option.getAttribute("checked") === "true";
    const key = option.getAttribute("option-key");
    if (!this.options.some((x) => x.key === key)) {
      return;
    }

    this.state.options[key] = checked;
    this.requestSave();
  }

  serialize() {
    return {
      state: this.state,
    };
  }
}
