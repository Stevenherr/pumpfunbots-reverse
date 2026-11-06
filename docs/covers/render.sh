#!/bin/bash
# cover.html?v=N -> PNG 3000x1200 через headless Chrome
cd "$(dirname "$0")"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
n=(x hero research v3 sniper open-source architecture pumpswap)
for v in ${@:-1 2 3 4 5 6 7}; do
  "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --virtual-time-budget=2000 \
    --screenshot="$PWD/$v-${n[$v]}.png" --window-size=1500,600 "file://$PWD/cover.html?v=$v" 2>/dev/null
done
rm -f ._*
