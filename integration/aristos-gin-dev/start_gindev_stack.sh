#!/usr/bin/env bash
# Start the full gin-dev ARISTOS stack for the simulator demo:
#   workflow server :24601 · backend :5003 · media server :24602 (from the
#   gin-dev worktree) · frontend :5173 (branch bowei/simulator).
# Data: ~/moonshot/aristos/data/ARISTOS-Data (task_graphs.db + media/), linked as
# the worktree's data/. Logs in the worktree's logs/.
set -u
W=/home/lbw/moonshot/aristos-gindev
FE=/home/lbw/moonshot/aristos/external/aristos_frontend
PY=/home/lbw/miniconda3/envs/aristos/bin/python
export PYTHONPATH=$W:$W/external/workflow

up() { curl -s -o /dev/null -m 2 "$1"; }
cd "$W" && mkdir -p logs
up http://127.0.0.1:24601/api/v1/task-graphs || up http://127.0.0.1:24601/ || \
  { setsid nohup $PY external/workflow/server.py data/task_graphs.db > logs/workflow.log 2>&1 < /dev/null & }
up "http://127.0.0.1:5003/socket.io/?EIO=4&transport=polling" || \
  { setsid nohup $PY aristos.py > logs/backend.log 2>&1 < /dev/null & }
up http://127.0.0.1:24602/ping || \
  { setsid nohup $PY contributor/media_server/server.py data/media/db/media.db data/media/videos data/media/images data/media/models > logs/media.log 2>&1 < /dev/null & }
up http://localhost:5173/ || \
  { cd "$FE" && setsid nohup npx vite --config vite.config.polling.ts --port 5173 --strictPort > /tmp/kb_vite.log 2>&1 < /dev/null & }
sleep 6
for u in "http://127.0.0.1:24601/|workflow :24601" "http://127.0.0.1:5003/socket.io/?EIO=4&transport=polling|backend  :5003" \
         "http://127.0.0.1:24602/ping|media    :24602" "http://localhost:5173/|frontend :5173"; do
  code=$(curl -s -o /dev/null -m 4 -w '%{http_code}' "${u%%|*}"); echo "${u##*|} -> $code"
done
echo; echo "Open:  http://localhost:5173/   (frontend branch: $(git -C "$FE" branch --show-current))"
