# Third-party notices

veil includes the following runtime components so the reader does not depend on third-party hosts. Exact sources, sizes, and SHA-256 digests are recorded in [`vendor/manifest.json`](./vendor/manifest.json). Complete license texts and notices are collected in [`vendor/licenses/`](./vendor/licenses/) or, when a bundle refers to a specific filename, beside that bundle.

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

The minified pdf-lib, fontkit, and Tesseract.js distributions contain additional runtime modules. Their exact versions, sources, and licenses are listed as embedded components in the manifest, with the corresponding notices collected in the matching `*-third-party-licenses.txt` files. Tesseract.js bundle notices also remain beside the browser and worker files under `vendor/tesseract.js/5.1.1/`, where the bundles refer to them.

The tesseract.js-core WebAssembly build incorporates Tesseract OCR, giflib, Leptonica, IJG libjpeg, libpng, libtiff, libwebp, OpenLibm, and zlib. Exact source commits and license references are recorded in the manifest and [`tesseract-core-third-party-licenses.txt`](./vendor/licenses/tesseract-core-third-party-licenses.txt). This software is based in part on the work of the Independent JPEG Group. OpenLibm's LGPL-covered upstream test files are not compiled into or distributed with the runtime.

The upstream JavaScript, WebAssembly, trained data, and font binaries are unmodified. veil adds a small ES module bridge around the fontkit UMD bundle, local `@font-face` declarations for IBM Plex Sans, and splits each Noto CJK font into two hosting-safe parts. The loader joins those parts byte for byte before fontkit receives them, and the vendor verifier checks the SHA-256 digest of each reconstructed font. Copyright notices embedded in the Noto font metadata are also reproduced in [`noto-font-notices.txt`](./vendor/licenses/noto-font-notices.txt).
