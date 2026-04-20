#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DIST_DIR="$ROOT_DIR/dist"
STAMP="$(date +%Y%m%d_%H%M%S)"
PKG_NAME="streaming_wfc_submission_${STAMP}"
PKG_DIR="$DIST_DIR/$PKG_NAME"
ZIP_PATH="$DIST_DIR/${PKG_NAME}.zip"

echo "Preparing submission package..."
mkdir -p "$PKG_DIR"

cp -f README.md "$PKG_DIR/"
cp -f main.tex "$PKG_DIR/"
cp -f references.bib "$PKG_DIR/"

[[ -f main.pdf ]] && cp -f main.pdf "$PKG_DIR/"

cp -R report "$PKG_DIR/"
cp -R experiments "$PKG_DIR/"
cp -R figures "$PKG_DIR/"
cp -R tiles "$PKG_DIR/"
cp -R config "$PKG_DIR/"

cp -f index.html demo.html demo.css app.js demo.js "$PKG_DIR/"
cp -f CONFIG.js renderer.js rng.js rules.js solver.js stats.js utils.js validators.js world.js worldCommon.js "$PKG_DIR/"

find "$PKG_DIR" -type f \( \
  -name '*.aux' -o -name '*.log' -o -name '*.out' -o -name '*.toc' -o -name '*.blg' -o -name '*.fdb_latexmk' -o -name '*.fls' -o -name '*.synctex.gz' \
\) -delete

rm -rf "$PKG_DIR/report/private_slides" || true
rm -rf "$PKG_DIR/archive" "$PKG_DIR/temp" "$PKG_DIR/.tmp_pdf_env" || true

rm -f "$PKG_DIR/report/WFC_Masters_Thesis_Final.pdf" || true

rm -f "$ZIP_PATH"
(
  cd "$DIST_DIR"
  zip -qr "${PKG_NAME}.zip" "$PKG_NAME"
)

echo "Submission package created: $ZIP_PATH"
