#!/bin/sh
# fetch every field in a "name ra dec" list, 3 at a time, into the v4 cache (v3's fetch tool, unchanged); log per field
S=/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad
cd $S/wt-detector-v4 && cat "$1" | DET_V3_OUT=$S/detector-v4 xargs -P 3 -L 1 sh -c '$0/detector-v4/py.sh bake/detector_v3_fetch.py field $1 $2 $3 > $0/detector-v4/cache/fetch_$1.log 2>&1; echo "$1 exit $?"' $S
