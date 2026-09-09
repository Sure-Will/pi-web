# Pi application icon

The application badge comes from the original Pi project's official website.

- Project: https://github.com/earendil-works/pi
- Official asset listing: https://pi.dev/press-kit
- Source: https://pi.dev/favicon.svg
- Retrieved: 2026-09-09
- Local source: [pi.svg](./pi.svg), preserved byte-for-byte
- Source SHA-256: `a5624bc3b8cac94de75f6f13701eca2ad3ef67bbeba286c4af3f398806f0858a`

The badge geometry, white mark, dark background (`#09090b`), rounded corners and padding are unchanged. Pi Web retains its own application name.

## Derived assets

Render `pi.svg` with Sharp at density 192, resize to each target size, and encode as PNG:

| File | Size |
| --- | --- |
| `icon-192.png` | 192 x 192 |
| `icon-512.png` | 512 x 512 |
| `apple-touch-icon.png` | 180 x 180 |
| `../../app/favicon.ico` | PNG frames at 16, 32, 48, 64, 128 and 256 pixels |

The SVG is also used beside the Pi Web title on the new-session screen. Login and offline pages use the derived PNGs. Keep these assets together when changing the badge. Update the static-cache revision in `../sw.js` when replacing assets at the same URLs.
