# Browser encoder dependencies

These files are bundled locally for Windows and Web only. Android keeps its native encoders. No CDN or npm install is needed at runtime or build time.

| Component | Version | License | Unmodified source |
|---|---|---|---|
| Mediabunny | 1.65.2 | MPL-2.0 | https://github.com/Vanilagy/mediabunny/tree/173f6b70765fa3a6ffc1c82737514416fa559ef5 |
| @jsquash/webp | 1.5.0 | Apache-2.0, bundled libwebp BSD | https://github.com/jamsinclair/jSquash/tree/8bcd212da8c2be7c9c223e8f222eb3d9574a713b |
| wasm-feature-detect | 1.8.0 | Apache-2.0 | https://github.com/GoogleChromeLabs/wasm-feature-detect/tree/8bfe6691b0749b53d605f3220f15e68751c4b5b6 |

The upstream license text is included in each component directory; libwebp's notice is `jsquash-webp-1.5.0/LIBWEBP-LICENSE`. `encoder-packages.json` records the npm tarball integrity and source revision. Mediabunny's corresponding source is available at the exact revision linked above. All distributed vendor code is unmodified.

H.264 uses the browser's platform codec through WebCodecs. No FFmpeg/x264 codec is bundled. Unsupported H.264 sizes and environments fail before export; GIF and WebP remain available. jSquash is an encode-only fallback for locally rendered RGBA; its older libwebp build needs reevaluation before upgrading or enabling untrusted WebP decoding.

Web fonts: the Flutter SDK's Roboto files use Apache-2.0 (`assets/fonts/LICENSE.txt`). The Web-only Noto Sans Symbols v43 WOFF2 fallback uses SIL OFL-1.1 (`font-fallback/OFL.txt`); source: https://github.com/notofonts/symbols. Its SHA-256 is `08202e258ea583254c036cff46a7077bb5af4f82c41a6c0a6775f6e44d99f1aa`. Runtime font fallbacks use the local origin.
