#!/usr/bin/env bash
# Day-to-day operations on the Terraform-managed Kolab. Provisioning lives in deploy/terraform and
# runs from CI (.github/workflows/deploy.yml, D73); this reads Terraform's outputs, talks to the
# running Kolab, and runs Terraform by hand.
#
#   deploy/konjir-ops.sh [--env production] <command> …
#
# --env names the environment, production, the only one there is (D83: staging dropped for now); it
# is accepted so that scripts that name it, such as deploy/recovery-drill.sh, keep working.
#
#   connect <actor> <product|engineer> [owner]          register a person, or with owner an agent of that account,
#                                                       granted Write in kolab $KONJIR_KOLAB (default kolab); open a session
#   status                                              health, service state
#   logs                                                last 200 lines from Kolab and Caddy
#   cloudwatch-logs [since]                             Kolab's and Caddy's lines in CloudWatch Logs (default: the last 1h), following
#   alarms                                              each alarm's state, and the reason for it
#   inject <kind> [min] [--yes-production]              set off one alarm on purpose, to check it emails (README: Alarms):
#                                                       crash, down [min], dead-job, errors, log-flood, disk-high [min],
#                                                       no-logs [min], rds-cpu, rds-storage; crash, down, disk-high and
#                                                       no-logs touch the live instance, so they need --yes-production
#   bootstrap-log                                       the instance's first-boot install log
#   shell                                               interactive shell (Session Manager plugin)
#   admin-token                                         print the break-glass admin token
#   rotate-admin-token [--off]                          write a new break-glass admin token to SSM and restart Kolab
#                                                       (W2.22); --off disables the break-glass instead, refused unless
#                                                       a live admin can sign in (--off-without-an-admin-who-signs-in: anyway)
#   terraform <args…>                                   terraform in deploy/terraform on production's state, e.g. terraform
#                                                       plan, with its working data in deploy/terraform/.terraform-production
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TF="$HERE/terraform"
export AWS_PROFILE="${AWS_PROFILE:-icedlee337}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PAGER=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

ENV="${KONJIR_ENV:-production}"
case "${1:-}" in
  --env)   ENV="${2:-}"; shift 2 || die "--env takes production" ;;
  --env=*) ENV="${1#--env=}"; shift ;;
esac
[ "$ENV" = production ] || die "--env is production, the only environment (D83), not '$ENV'"
# Its own Terraform working data, initialised on first use, apart from any older deploy/terraform/.terraform.
export TF_DATA_DIR="$TF/.terraform-$ENV"

tf() {
  if [ ! -f "$TF_DATA_DIR/terraform.tfstate" ]; then
    terraform -chdir="$TF" init -input=false -backend-config="environments/$ENV.s3.tfbackend" >&2 \
      || die "terraform init failed for $ENV"
  fi
  terraform -chdir="$TF" "$@"
}
out() { tf output -raw "$1" 2>/dev/null || die "no Terraform output '$1' in $ENV; has it been deployed?"; }

admin_token() {
  aws ssm get-parameter --name "$(out admin_token_parameter)" --with-decryption --query Parameter.Value --output text
}

# Writes a new break-glass admin token to SSM, outside Terraform (W2.22, D69), and restarts Kolab
# so it takes the new one: the old one stops working once Kolab is back. The value is never printed
# or put on a command line; read it with admin-token when you need it. With --off, the parameter
# holds `off` instead, and Kolab runs with the break-glass disabled: only Konjir admins, signed in
# as themselves, run the admin verbs, and the last of them can't be removed. A new stack's Kolab
# starts once this has written the parameter the first time.
cmd_rotate_admin_token() {
  local name file value off="" force=""
  for arg in "$@"; do
    case "$arg" in
      --off) off=1 ;;
      --off-without-an-admin-who-signs-in) off=1; force=1 ;;
      *) die "usage: konjir-ops.sh rotate-admin-token [--off | --off-without-an-admin-who-signs-in]" ;;
    esac
  done
  if [ -n "$off" ]; then
    value=off
    # Disabling the break-glass leaves only Konjir's admins, so at least one must be live and able to
    # sign in (a linked GitHub identity), or no one could run an admin verb again (L1). Checked with
    # the token still in place; refused unless the long flag says to go ahead anyway.
    [ -n "$force" ] || require_an_admin_who_signs_in
  else
    value="kja_$(python3 -c 'import secrets, string; print("".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(40)))')"
  fi
  name="$(out admin_token_parameter)"
  file="$(mktemp)"
  # shellcheck disable=SC2064 # the file's name now, on any exit
  trap "rm -f '$file'" EXIT
  chmod 600 "$file"
  python3 -c 'import json, sys; print(json.dumps({"Name": sys.argv[1], "Type": "SecureString", "Overwrite": True, "Value": sys.stdin.read().strip(),
    "Description": "Kolab break-glass admin token (W2.22): written by deploy/konjir-ops.sh rotate-admin-token, never by Terraform"}))' "$name" <<<"$value" >"$file"
  unset value
  aws ssm put-parameter --cli-input-json "file://$file" >/dev/null
  echo "wrote a new value to $name; restarting Kolab so it takes it"
  on_kolab "systemctl restart konjir.service && echo 'Kolab restarted'"
  echo "the previous break-glass token no longer works. Read the new one with: deploy/konjir-ops.sh admin-token"
}

# Refuses unless Kolab has a live Konjir admin who can sign in, asked with the break-glass token in
# SSM now. If that is already `off`, the break-glass is disabled already and there is nothing to
# lose. Needs the konjir CLI locally (npm install), as connect does.
require_an_admin_who_signs_in() {
  local current admins
  current="$(admin_token)"
  if [ "$current" = off ]; then unset current; return 0; fi
  [ -d "$ROOT/node_modules" ] || die "run npm install in $ROOT first: --off checks Konjir's admins with the konjir CLI"
  admins="$(KONJIR_URL="$(out url)" KONJIR_TOKEN="$current" "$ROOT/bin/konjir" admin_list_admins)" || { unset current; die "couldn't list Konjir's admins: $admins"; }
  unset current
  python3 -c '
import json, sys
live = [a["actor"] for a in json.load(sys.stdin)["admins"] if not a["archived"] and a.get("signs_in")]
if not live:
    sys.exit("no live Konjir admin can sign in with GitHub, so with the break-glass off no one could run an admin verb. Make one first (konjir admin_make_admin, then admin_link_identity if they have no GitHub identity linked), or run rotate-admin-token --off-without-an-admin-who-signs-in to disable it anyway")
print("Konjir admins who can sign in: " + ", ".join(live))' <<<"$admins" || exit 1
}

# Run a shell command on Kolab through SSM Run Command and print its output.
on_kolab() {
  local instance cmd_id status
  instance="$(out instance_id)"
  cmd_id="$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --parameters "$(python3 -c 'import json,sys;print(json.dumps({"commands":[sys.argv[1]]}))' "$1")" \
    --query Command.CommandId --output text)"
  while :; do
    status="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
      --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) sleep 2 ;; *) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
    --query '[StandardOutputContent, StandardErrorContent]' --output text
  [ "$status" = Success ] || die "command on Kolab ended with status $status"
}

cmd_connect() {
  local actor="${1:-}" role="${2:-}" owner="${3:-}" kolab="${KONJIR_KOLAB:-kolab}" url admin token expires opened added granted existing
  [ -n "$actor" ] && [[ "$role" =~ ^(product|engineer)$ ]] || die "usage: konjir-ops.sh connect <actor> <product|engineer> [owner]"
  [ -d "$ROOT/node_modules" ] || die "run npm install in $ROOT first (the konjir CLI runs locally)"
  url="$(out url)"
  admin="$(admin_token)"
  # An actor registered already is reused only if it is what was asked for: a person, or an agent of
  # that same owner, with the access it already has. Any other refusal (an invalid id, an owner
  # that isn't an account) stops here. A new actor gets Write on both layers of the kolab; an
  # agent's grant is refused if its owner holds less there.
  if added="$(KONJIR_URL="$url" KONJIR_TOKEN="$admin" "$ROOT/bin/konjir" admin_add_actor "id=$actor" ${owner:+"owner=$owner"} 2>&1)"; then
    granted="$(KONJIR_URL="$url" KONJIR_TOKEN="$admin" "$ROOT/bin/konjir" admin_grant "kolab=$kolab" "to=$actor" level=write 2>&1)" \
      || die "$actor was added, but not granted access to kolab $kolab: $granted"
  else
    [[ "$added" == *"actor $actor already exists"* ]] || die "$added"
    existing="$(KONJIR_URL="$url" KONJIR_TOKEN="$admin" "$ROOT/bin/konjir" admin_list_actors \
      | python3 -c 'import json,sys;a=[x for x in json.load(sys.stdin)["actors"] if x["id"]==sys.argv[1]][0];print(a["owner"] or "")' "$actor")"
    [ "$existing" = "$owner" ] || die "$actor already exists as $([ -n "$existing" ] && echo "an agent of $existing" || echo "a person"), not as $([ -n "$owner" ] && echo "an agent of $owner" || echo "a person")"
  fi
  opened="$(KONJIR_URL="$url" KONJIR_TOKEN="$admin" "$ROOT/bin/konjir" admin_open_session "actor=$actor" "role=$role" "kolab=$kolab")"
  token="$(python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])' <<<"$opened")"
  expires="$(python3 -c 'import json,sys;print(json.load(sys.stdin).get("expires_at") or "never")' <<<"$opened")"
  unset opened
  cat <<EOF

$actor ($role in kolab $kolab${owner:+, an agent of $owner}) can connect with this token. Send it privately; it works like a password.
It expires at $expires (W2.22: hand-issued tokens last 30 days unless Kolab's KONJIR_HAND_ISSUED_TOKEN_DAYS says
otherwise); run connect again for a new one then.

  Token:        $token
  Expires:      $expires

  Claude Code:  claude mcp add --transport http konjir $url --header "Authorization: Bearer $token"
  Shell / CLI:  export KONJIR_URL=$url KONJIR_TOKEN=$token
                konjir instructions

Revoke with:    KONJIR_URL=$url KONJIR_TOKEN=\$(deploy/konjir-ops.sh --env $ENV admin-token) bin/konjir admin_end_session actor=$actor
EOF
}

INJECT_USAGE="usage: konjir-ops.sh inject <crash|down [1-15 min]|dead-job|errors|log-flood|disk-high [12-30 min]|no-logs [35-60 min]|rds-cpu|rds-storage> [--yes-production]"

# Sets off one alarm on purpose (README: Alarms). crash and down break the real Kolab, through the
# journal, the agent and the metric filter, so they say what they will do and need --yes-production;
# dead-job and errors put lines into the log group's `inject` stream, which the same filters count;
# the RDS alarms are set by hand, and go back to their real state at their next evaluation.
# log-flood, disk-high and no-logs go through the real instance, agent and alarm (below cmd_inject).
cmd_inject() {
  local what="" minutes="" yes="" arg site group line count=1 periods=1 alarm
  for arg in "$@"; do
    case "$arg" in
      --yes-production) yes=1 ;;
      *) if [ -z "$what" ]; then what="$arg"; elif [ -z "$minutes" ]; then minutes="$arg"; else die "$INJECT_USAGE"; fi ;;
    esac
  done
  case "$what" in
    down|disk-high|no-logs) ;;
    *) [ -z "$minutes" ] || die "inject $what takes no minutes; $INJECT_USAGE" ;;
  esac
  case "$what" in
    log-flood) inject_log_flood; return ;;
    disk-high) inject_disk_high "$minutes" "$yes"; return ;;
    no-logs)   inject_no_logs "$minutes" "$yes"; return ;;
    crash|down)
      site="https://$(out url | sed 's|^https://||; s|/mcp$||')"
      if [ "$what" = crash ]; then
        echo "inject crash: kills the live Kolab at $site (SIGKILL); systemd restarts it 3 s later, and service-exited fires"
      else
        minutes="${minutes:-4}"
        [[ "$minutes" =~ ^[0-9]+$ ]] && [ "$minutes" -ge 1 ] && [ "$minutes" -le 15 ] || die "down takes 1 to 15 minutes"
        echo "inject down: stops the live Kolab at $site for $minutes minutes, then systemd starts it again; healthz-failing fires"
      fi
      [ -n "$yes" ] || die "this breaks the production Kolab; run it again with --yes-production"
      if [ "$what" = crash ]; then
        on_kolab "systemctl kill --signal=KILL konjir.service && echo 'killed Kolab; systemd restarts it in 3 s'"
      else
        # systemd starts Kolab again from a timer of its own, so neither this shell nor SSM has to
        # last the wait.
        on_kolab "systemctl reset-failed konjir-inject-start.timer konjir-inject-start.service 2>/dev/null; systemd-run --quiet --collect --unit=konjir-inject-start --on-active=${minutes}m --timer-property=AccuracySec=1s /usr/bin/systemctl start konjir.service && systemctl stop konjir.service && echo 'stopped Kolab; systemd starts it again in $minutes minutes (konjir-inject-start.timer)'"
      fi
      return ;;
    dead-job)
      line='{"level":"error","message":"injected by deploy/konjir-ops.sh inject dead-job: not a real job","event":"outbox_job_dead","kolab":"injected","_SYSTEMD_UNIT":"konjir.service"}' ;;
    errors)
      # The alarm takes 2 of 3 five-minute periods, so 12 lines go in this period and 12 in the one before.
      line='{"level":"error","message":"injected by deploy/konjir-ops.sh inject errors: not a real error","_SYSTEMD_UNIT":"konjir.service"}'; count=12; periods=2 ;;
    rds-cpu|rds-storage)
      alarm="$(tf output -json alarms | python3 -c 'import json,sys;print([a for a in json.load(sys.stdin) if "-" + sys.argv[1] + "-" in a][0])' "$what")"
      aws cloudwatch set-alarm-state --alarm-name "$alarm" --state-value ALARM --state-reason "injected by deploy/konjir-ops.sh inject $what"
      echo "$alarm set to ALARM; it returns to its real state at its next evaluation"; return ;;
    *) die "$INJECT_USAGE" ;;
  esac
  group="$(out log_group)"
  aws logs create-log-stream --log-group-name "$group" --log-stream-name inject 2>/dev/null || true
  aws logs put-log-events --log-group-name "$group" --log-stream-name inject --log-events "$(python3 -c '
import json, sys, time
t = int(time.time() * 1000)
count, periods = int(sys.argv[1]), int(sys.argv[2])
print(json.dumps([{"timestamp": t - p * 300000 + i, "message": sys.argv[3]} for p in reversed(range(periods)) for i in range(count)]))' "$count" "$periods" "$line")" >/dev/null
  echo "put $((count * periods)) line(s) in $group, stream inject; the alarm fires within about 5 minutes"
}

# ---- inject log-flood, disk-high and no-logs (W2.19: an injected failure of each kind emails)
#
# Each goes through the real instance, agent and alarm, not lines put in the log group. It says
# what it will do and for how long, then which alarm to watch. What it changes on the instance runs
# as a transient systemd unit or timer with a bound of its own, so it ends, and undoes itself, even
# if this shell, the SSM command or the laptop goes away. disk-high and no-logs also watch the
# alarm from here, and undo the inject as soon as it fires, or on Ctrl-C.

# The alarm whose name ends with -<suffix>, from Terraform's outputs.
alarm_named() {
  tf output -json alarms | python3 -c 'import json,sys;print([a for a in json.load(sys.stdin) if a.endswith("-" + sys.argv[1])][0])' "$1" \
    || die "no alarm named *-$1 in Terraform's outputs"
}
alarm_value() { aws cloudwatch describe-alarms --alarm-names "$1" --query "MetricAlarms[0].$2" --output text; }

# An inject can't show an alarm firing that is firing already.
refuse_if_alarm() {
  local state; state="$(alarm_value "$1" StateValue)"
  [ "$state" != ALARM ] || die "$1 is in ALARM already, so this inject couldn't show it firing; see deploy/konjir-ops.sh alarms"
}

# Waits up to $2 seconds for alarm $1 to be in ALARM, printing each state it sees; 1 if it never fires.
await_alarm() {
  local alarm="$1" deadline state last=""
  deadline=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    state="$(alarm_value "$alarm" StateValue 2>/dev/null || echo unknown)"
    [ "$state" = "$last" ] || { echo "$(date -u +%H:%M:%SZ)  $alarm: $state"; last="$state"; }
    [ "$state" = ALARM ] && return 0
    sleep 30
  done
  return 1
}

# Sends the script on stdin to Kolab as /run/konjir-inject-<name>.sh, compressed to stay well
# inside Run Command's parameter limit, and runs it there through on_kolab, with the remaining
# arguments (plain words). /run is a tmpfs: a reboot leaves nothing.
on_kolab_script() {
  local name="$1" encoded; shift
  encoded="$(gzip -9c | base64 | tr -d '\n')"
  on_kolab "printf '%s' '$encoded' | base64 -d | gunzip > /run/konjir-inject-$name.sh && bash /run/konjir-inject-$name.sh $*"
}

hhmm() { python3 -c 'import sys, time; print(time.strftime("%H:%MZ", time.gmtime(int(sys.argv[1]))))' "$1"; }

# log-flood: lines past the alarm's threshold go into konjir.service's journal, as root with
# OBJECT_SYSTEMD_UNIT, as the journal copy's own probe does, so they take the real path: journald,
# journalctl, the copy, the agent, the log group. Each says what it is, is plain text (so no filter
# but the group's IncomingBytes counts it), and is 16,000 bytes, under the copy's 16 KiB cap. They
# are paced over 25 minutes, about 60 a second, well under journald's rate limit, from a unit at
# the lowest CPU and I/O priority. The disk stays safe: journald compresses lines this repetitive
# to almost nothing; the flood rotates the copy itself every 64 MB (its timer only runs every 10
# minutes), so /var/log/konjir holds a few hundred MB at most; and it stops if / has under 2 GiB free.
log_flood_script() {
  cat <<'EOF'
set -euo pipefail
unit=konjir-inject-log-flood
target=$1 seconds=$2 delay=$3
if systemctl is-active -q "$unit.service" || systemctl is-active -q "$unit.timer"; then
  echo "refused: an inject log-flood is running already"; exit 1
fi
for u in konjir-journal@konjir amazon-cloudwatch-agent; do
  systemctl is-active -q "$u" || { echo "refused: $u isn't running, so the lines wouldn't ship"; exit 1; }
done
avail=$(df -B1 --output=avail / | tail -n 1 | tr -d ' ')
[ "$avail" -ge $((3 << 30)) ] || { echo "refused: / has under 3 GiB free"; exit 1; }
cat > /run/konjir-inject-log-flood.py <<'PY'
import os, socket, subprocess, sys, time
target, seconds = int(sys.argv[1]), int(sys.argv[2])
LINE, FLOOR, ROTATE_EVERY = 16000, 2 << 30, 64 << 20
total = -(-target // LINE)
per_s = -(-total // seconds)
journal = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
journal.connect('/run/systemd/journal/socket')
head = 'konjir-ops inject log-flood: harmless filler for the log-flood alarm, not a real event; line %d of %d. '
print('writing %d lines of %d bytes, %d a second, into konjir.service\'s journal' % (total, LINE, per_s), flush=True)
start, sent, since_rotate = time.monotonic(), 0, 0
while sent < total:
    st = os.statvfs('/')
    if st.f_bavail * st.f_frsize < FLOOR:
        sys.exit('under 2 GiB free on /: the flood stops after %d lines' % sent)
    for _ in range(min(per_s, total - sent)):
        sent += 1
        text = head % (sent, total)
        text += 'filler ' * ((LINE - len(text)) // 7)
        journal.send(('MESSAGE=%s\nPRIORITY=6\nSYSLOG_IDENTIFIER=konjir-inject\nOBJECT_SYSTEMD_UNIT=konjir.service\n' % text).encode())
        since_rotate += LINE
    if since_rotate >= ROTATE_EVERY:
        # Rotates /var/log/konjir/konjir.log once it passes 50 MB (copytruncate), as its timer does.
        subprocess.run(['/usr/bin/systemctl', 'start', 'konjir-journal-rotate.service'], check=False)
        since_rotate = 0
    time.sleep(max(0.0, start + sent / per_s - time.monotonic()))
print('wrote %d lines, %d MiB' % (sent, sent * LINE >> 20), flush=True)
PY
systemctl reset-failed "$unit.service" "$unit.timer" 2>/dev/null || true
when=()
[ "$delay" -eq 0 ] || when=(--on-active="${delay}s" --timer-property=AccuracySec=1s)
systemd-run --quiet --collect --unit="$unit" "${when[@]}" -p RuntimeMaxSec=$((seconds + 600)) \
  -p Nice=19 -p IOSchedulingClass=idle -p CPUQuota=30% \
  /usr/bin/python3 /run/konjir-inject-log-flood.py "$target" "$seconds"
echo "  started $unit, with $((avail >> 30)) GiB free on /; its progress: journalctl -u $unit"
EOF
}

inject_log_flood() {
  local alarm threshold target seconds=1500 now into delay=0 starts
  alarm="$(alarm_named log-flood)"
  refuse_if_alarm "$alarm"
  threshold="$(alarm_value "$alarm" Threshold)"; threshold="${threshold%.*}"
  # 30% over: lines the agent hadn't sent yet when the copy was rotated are lost.
  target=$(( threshold * 13 / 10 ))
  # The alarm sums an hour. Started in the hour's first half, the flood ends inside it; later, it
  # waits for the next hour's first minute, so that it isn't split across two.
  now="$(date +%s)"; into=$(( now % 3600 ))
  [ "$into" -le 1800 ] || delay=$(( 3600 - into + 60 ))
  if [ "$delay" -eq 0 ]; then starts=now; else starts="at $(hhmm $(( now + delay ))) (in $(( delay / 60 )) minutes)"; fi
  echo "inject log-flood: writes $(( target >> 20 )) MiB of harmless lines, each marked 'konjir-ops inject log-flood', into konjir.service's"
  echo "  journal, paced over $(( seconds / 60 )) minutes and starting $starts. They ship to the konjir stream like Kolab's own lines, for about"
  echo "  \$$(python3 -c 'import sys; print("%.2f" % (int(sys.argv[1]) / 1e9 * 0.5))' "$target") of ingestion. Kolab keeps running; the flood stops if / has under 2 GiB free."
  log_flood_script | on_kolab_script log-flood "$target" "$seconds" "$delay"
  echo "watch $alarm (deploy/konjir-ops.sh alarms): it fires once the hour's lines pass $(( threshold >> 20 )) MiB, so within the hour the"
  echo "flood ends in, and recovers in the hour after. To stop it early, in a shell: sudo systemctl stop konjir-inject-log-flood.timer konjir-inject-log-flood"
}

# disk-high: one file, /var/tmp/konjir-inject-disk-high.fill (fallocate, so it takes no time),
# takes the root file system, which the alarm watches, to 3 points over the alarm's threshold:
# 83% of 16 GiB leaves 2.7 GiB free, and over journald's own reserve (15%). It is refused if / is
# over the threshold already, or would be left under 2 GiB. The hold is a transient unit that
# removes the file on exit (a trap) and after it (ExecStopPost, even if killed), lasts at most
# its minutes, and removes the file early if / falls under 1 GiB free meanwhile. Kolab's database
# is on RDS, and its data volume (/var/lib/konjir) is a file system of its own, so neither is touched.
disk_high_script() {
  cat <<'EOF'
set -euo pipefail
unit=konjir-inject-disk-high
f=/var/tmp/konjir-inject-disk-high.fill
gib=$((1 << 30))
case "$1" in
  check|start)
    threshold=$2 hold=$3
    if systemctl is-active -q "$unit"; then echo "refused: an inject disk-high is holding already"; exit 1; fi
    rm -f "$f"   # left by a hold that a reboot cut short
    command -v fallocate >/dev/null || { echo "refused: no fallocate (util-linux) on the instance"; exit 1; }
    [ "$(findmnt -n -o TARGET --target /var/tmp)" = / ] || { echo "refused: /var/tmp isn't on /, the file system the alarm watches"; exit 1; }
    read -r used avail < <(df -B1 --output=used,avail / | tail -n 1)
    size=$((used + avail)); pct=$((used * 100 / size)); target=$((threshold + 3))
    need=$((size * target / 100 - used))
    left=$((avail - need))
    echo "  / is $((size >> 30)) GiB and ${pct}% used, with $((avail >> 20)) MiB free; at ${target}% it would have $((left >> 20)) MiB free"
    [ "$pct" -lt "$threshold" ] || { echo "refused: / is ${pct}% used already, at or over the alarm's ${threshold}%: free space first"; exit 1; }
    [ "$left" -ge $((2 * gib)) ] || { echo "refused: that would leave under 2 GiB free on /"; exit 1; }
    [ "$1" = start ] || exit 0
    systemctl reset-failed "$unit" 2>/dev/null || true
    systemd-run --quiet --collect --unit="$unit" -p RuntimeMaxSec=$((hold + 60)) -p "ExecStopPost=/bin/rm -f $f" \
      /bin/bash /run/konjir-inject-disk-high.sh hold "$need" "$hold"
    sleep 3
    echo "  $f: $((need >> 20)) MiB; / is $(df --output=pcent / | tail -n 1 | tr -d ' ') used, for at most $((hold / 60)) minutes" ;;
  hold)
    need=$2 hold=$3
    trap 'rm -f "$f"; echo "removed $f"' EXIT
    trap 'exit 0' INT TERM HUP
    fallocate -l "$need" "$f"
    end=$(( $(date +%s) + hold ))
    while [ "$(date +%s)" -lt "$end" ]; do
      free=$(df -B1 --output=avail / | tail -n 1 | tr -d ' ')
      [ "$free" -ge "$gib" ] || { echo "under 1 GiB free on /: removing $f early"; exit 0; }
      sleep 5
    done ;;
  stop)
    systemctl stop "$unit" 2>/dev/null || true
    rm -f "$f"
    echo "  removed $f; / is $(df --output=pcent / | tail -n 1 | tr -d ' ') used" ;;
esac
EOF
}

inject_disk_high() {
  local minutes="${1:-20}" yes="$2" alarm threshold
  [[ "$minutes" =~ ^[0-9]+$ ]] && [ "$minutes" -ge 12 ] && [ "$minutes" -le 30 ] || die "disk-high holds for 12 to 30 minutes"
  alarm="$(alarm_named disk-high)"
  refuse_if_alarm "$alarm"
  threshold="$(alarm_value "$alarm" Threshold)"; threshold="${threshold%.*}"
  echo "inject disk-high: fills the instance's root file system to $(( threshold + 3 ))%, past the alarm's ${threshold}%, with one file,"
  echo "  /var/tmp/konjir-inject-disk-high.fill, and holds it until the alarm fires, for at most $minutes minutes, then removes it."
  echo "  Kolab keeps running; its database (RDS) and data volume aren't touched, and at least 2 GiB stay free on /."
  disk_high_script | on_kolab_script disk-high check "$threshold" $(( minutes * 60 ))
  [ -n "$yes" ] || die "this fills the production instance's disk; run it again with --yes-production"
  trap 'echo "interrupted: removing the file now"; disk_high_script | on_kolab_script disk-high stop; exit 130' INT TERM
  disk_high_script | on_kolab_script disk-high start "$threshold" $(( minutes * 60 ))
  echo "watching $alarm: the agent reports every minute, and the alarm takes two 5-minute periods over ${threshold}%, so 10 to 15 minutes"
  if await_alarm "$alarm" $(( minutes * 60 )); then
    trap - INT TERM
    disk_high_script | on_kolab_script disk-high stop
    echo "$alarm fired; its email is on its way, and its OK one follows within about 10 minutes"
  else
    trap - INT TERM
    disk_high_script | on_kolab_script disk-high stop
    die "$alarm didn't fire within $minutes minutes; see deploy/konjir-ops.sh alarms, and the agent's disk_used_percent in Konjir/<name>"
  fi
}

# no-logs: stops the CloudWatch agent, so nothing ships, while Kolab, Caddy and the journal copies
# keep running: their lines wait in /var/log/konjir, and the agent sends them, from where it
# stopped, once it starts again. A systemd timer starts it after the minutes whatever happens here
# (it is enabled, so a reboot starts it too), as down's does for Kolab; this starts it as soon as
# the alarm fires, or on Ctrl-C. Meanwhile every log alarm, and disk-high, is blind.
restore_shipping() {
  on_kolab "systemctl stop konjir-inject-no-logs.timer 2>/dev/null; systemctl start amazon-cloudwatch-agent.service && echo '  started the CloudWatch agent again; the lines written meanwhile ship now'"
}

inject_no_logs() {
  local minutes="${1:-45}" yes="$2" alarm
  [[ "$minutes" =~ ^[0-9]+$ ]] && [ "$minutes" -ge 35 ] && [ "$minutes" -le 60 ] || die "no-logs pauses shipping for 35 to 60 minutes"
  alarm="$(alarm_named no-logs)"
  refuse_if_alarm "$alarm"
  echo "inject no-logs: stops the CloudWatch agent on the instance until the alarm fires, for at most $minutes minutes, then starts it again."
  echo "  Kolab, Caddy and the journal copies keep running, and their lines ship once the agent is back; meanwhile the other log alarms are blind."
  [ -n "$yes" ] || die "this stops log shipping from the production instance; run it again with --yes-production"
  trap 'echo "interrupted: starting the agent again"; restore_shipping; exit 130' INT TERM
  on_kolab "systemctl is-active -q amazon-cloudwatch-agent || { echo 'refused: the CloudWatch agent is not running already'; exit 1; }; systemctl reset-failed konjir-inject-no-logs.timer konjir-inject-no-logs.service 2>/dev/null; systemd-run --quiet --collect --unit=konjir-inject-no-logs --on-active=${minutes}m --timer-property=AccuracySec=1s /usr/bin/systemctl start amazon-cloudwatch-agent.service && systemctl stop amazon-cloudwatch-agent.service && echo '  stopped the CloudWatch agent; systemd starts it again in $minutes minutes (konjir-inject-no-logs.timer)'"
  echo "watching $alarm: it fires after 30 minutes with no fresh heartbeat, so in 30 to 40"
  if await_alarm "$alarm" $(( minutes * 60 )); then
    trap - INT TERM
    restore_shipping
    echo "$alarm fired; its email is on its way. The heartbeats held back ship now, so its OK email follows within about 10 minutes"
  else
    trap - INT TERM
    restore_shipping
    die "$alarm didn't fire within $minutes minutes; see deploy/konjir-ops.sh alarms"
  fi
}

case "${1:-}" in
  connect)       shift; cmd_connect "$@" ;;
  status)        url="$(out url)"; printf 'health (%s): ' "${url%/mcp}/healthz"
                 curl -fsS --max-time 5 "${url%/mcp}/healthz" || printf 'not answering'; echo
                 on_kolab "systemctl --no-pager --lines=0 status konjir caddy | grep -E '●|Active:'; echo \"live release: \$(readlink -f /opt/konjir/current)\"" ;;
  logs)          on_kolab "journalctl -u konjir -u caddy -n 200 --no-pager" ;;
  bootstrap-log) on_kolab "tail -n 200 /var/log/konjir-bootstrap.log" ;;
  shell)         command -v session-manager-plugin >/dev/null || die "install the Session Manager plugin: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"
                 aws ssm start-session --target "$(out instance_id)" ;;
  admin-token)   admin_token ;;
  rotate-admin-token) shift; cmd_rotate_admin_token "$@" ;;
  cloudwatch-logs) aws logs tail "$(out log_group)" --since "${2:-1h}" --follow --format short ;;
  alarms)        # shellcheck disable=SC2046 # one alarm name per word
                 aws cloudwatch describe-alarms --alarm-names $(tf output -json alarms | python3 -c 'import json,sys;print(" ".join(json.load(sys.stdin)))') \
                   --query 'MetricAlarms[].[AlarmName,StateValue,StateReason]' --output table ;;
  inject)        shift; cmd_inject "$@" ;;
  terraform)     shift; tf "$@" ;;
  *)             sed -n '2,28p' "$0"; exit 1 ;;
esac
