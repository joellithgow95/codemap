# Third-party notices

CodeMap's own code is MIT licensed (see [LICENSE](LICENSE)). The demo maps in `web/public/demo/`
are not: each is generated from a public GitHub repository by `npm run demo` and contains that
repository's file contents and commit history. They are redistributed under the original licenses.

| Demo map | Source | Copyright | License |
|----------|--------|-----------|---------|
| `simonw-shot-scraper.json` | https://github.com/simonw/shot-scraper | Simon Willison | [Apache License 2.0](https://github.com/simonw/shot-scraper/blob/main/LICENSE) |
| `simonw-ttok.json` | https://github.com/simonw/ttok | Simon Willison | [Apache License 2.0](https://github.com/simonw/ttok/blob/main/LICENSE) |

The maps are unmodified extracts: file text, file paths, commit metadata and diffs as returned by
the GitHub API, truncated where noted in the data. A full copy of the Apache License 2.0 is at
https://www.apache.org/licenses/LICENSE-2.0.

When you add a demo map, add a row here, and only use a public repository whose license allows
redistribution.

## Runtime dependencies

| Package | License |
|---------|---------|
| [three](https://github.com/mrdoob/three.js) | MIT |
| [diff](https://github.com/kpdecker/jsdiff) (jsdiff, local-folder line diffs) | BSD-3-Clause |
| [vite](https://github.com/vitejs/vite) (build tool) | MIT |
