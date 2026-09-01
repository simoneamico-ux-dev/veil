# Third-party notices

veil includes the following runtime components so the reader does not depend on third-party hosts. Exact sources, sizes, and SHA-256 digests are recorded in [`vendor/manifest.json`](./vendor/manifest.json); complete license texts and bundle notices are in [`vendor/licenses/`](./vendor/licenses/).

| Component | Version | License |
|---|---:|---|
| PDF.js | 5.4.149 | Apache-2.0 |
| pdf-lib | 1.17.1 | MIT |
| @pdf-lib/fontkit | 1.1.1 | MIT |
| Tesseract.js | 5.1.1 | Apache-2.0 |
| tesseract.js-core | 5.1.1 | Apache-2.0 |
| Tesseract language data | 4.0.0_best_int | Apache-2.0 |
| Noto export fonts | pinned revisions in the manifest | OFL-1.1 |
| IBM Plex Sans | Google Fonts v23 | OFL-1.1 |

The upstream JavaScript, WebAssembly, trained data, and font binaries are unmodified. veil adds a small ES module bridge around the fontkit UMD bundle, local `@font-face` declarations for IBM Plex Sans, and splits each Noto CJK font into two hosting-safe parts. The loader joins those parts byte for byte before fontkit receives them, and the vendor verifier checks the SHA-256 digest of each reconstructed font.
