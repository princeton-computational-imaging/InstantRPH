#!/usr/bin/env bash
# Re-encode the site's videos for web delivery.
#
# Two things matter here, and the first matters more than the second:
#
#   1. +faststart. The originals carry their moov atom AFTER the mdat, so a
#      browser cannot decode a single frame until the whole file has landed --
#      105 MB for ARH.mp4. Moving the index to the front is what turns "wait for
#      the download" into "start playing immediately".
#   2. A sane bitrate. The originals run 26-35 Mbps at <= 1280x800, roughly ten
#      times what the page needs.
#
# CRF is kept conservative (20) on purpose: the content is speckle, which is the
# exact artifact the paper is about, and speckle is the first thing a lossy
# encoder throws away. Size is the secondary goal; not softening the result is
# the constraint.
#
# Writes to assets_optimized/ rather than in place, so originals survive and the
# two can be compared before anything is swapped.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/assets"
OUT="$ROOT/assets_optimized"

CRF="${CRF:-20}"

encode() {
    local rel="$1"; local crf="$2"; shift 2
    local in="$SRC/$rel"
    local out="$OUT/$rel"
    [ -f "$in" ] || { echo "skip (missing): $rel"; return; }
    mkdir -p "$(dirname "$out")"
    echo "==> $rel (crf $crf)"
    ffmpeg -y -loglevel error -stats -i "$in" \
        -c:v libx264 -preset slow -crf "$crf" \
        -pix_fmt yuv420p -profile:v high -level 4.0 \
        -g 50 -movflags +faststart -an \
        "$@" "$out"
    local a b
    a=$(stat -c%s "$in"); b=$(stat -c%s "$out")
    # awk in the C locale, not bc+printf: the shell's locale can make printf's
    # %f parse a period-decimal bc result as invalid (comma-decimal locales)
    # and silently abort the whole script under set -e.
    awk -v a="$a" -v b="$b" 'BEGIN {
        printf "    %.1f MB -> %.1f MB  (%.1fx smaller)\n", a/1e6, b/1e6, a/b
    }'
}

# Hero comparison and parallax: the big ones. The bitrate cap keeps a worst-case
# speckle burst from spiking back into tens of Mbps on a slow connection.
capped=(-maxrate 12M -bufsize 24M)

# ARH.mp4 is the "before" side of the hero comparison: its whole point is to
# show the competing method's speckle artifacts. At CRF 20 / 12 Mbps a visual
# check (see tools/README or the verification step in the plan) showed the
# encoder smoothing that very speckle away -- which would misrepresent the
# comparison the paper is making, not just look worse. It gets its own,
# much less aggressive pass: CRF 16 and double the bitrate ceiling. That only
# buys back to ~85 MB (vs. 105 MB original, 1.2x), but faststart is doing the
# real work here regardless of final size -- the file plays immediately either
# way, it just doesn't get much smaller. OURS.mp4 and the parallax clips carry
# comparatively little chroma noise and held up fine under the shared CRF 20.
encode videos/ARH.mp4                            16 -maxrate 24M -bufsize 48M
encode videos/OURS.mp4                           "$CRF" "${capped[@]}"
encode parallax/frames_loop_arh.mp4              "$CRF" "${capped[@]}"
encode parallax/frames_loop_checkpoint_model.mp4 "$CRF" "${capped[@]}"

# LAE training clips: already faststart and already lazy-loaded, but still
# 6-12 Mbps for a 31-frame loop. No cap needed -- they are short.
for f in "$SRC"/lae_training/*.mp4; do
    [ -e "$f" ] || continue
    encode "lae_training/$(basename "$f")" "$CRF"
done

echo
echo "Done. Originals untouched in $SRC; encodes in $OUT"
echo "Next: tools/check-faststart.py, then compare stills before swapping."
