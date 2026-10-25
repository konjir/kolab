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
#                                                       no-logs [min], rds-cpu, rds-storage; those but dead-job, errors
#                                                       and the RDS ones touch the instance: they need --yes-production
#   bootstrap-log                                       the instance's first-boot install log
#   shell                                               interactive shell (Session Manager plugin)
#   preflight <NNNN>                                    run deploy/preflight/<NNNN>.sql on the database, read-only, before
#                                                       deploying migration NNNN: its refusals, or that it applies cleanly
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

# Runs deploy/preflight/<NNNN>.sql on Kolab's database, read-only, through Kolab's instance
# (deploy/preflight/run.cjs, as recovery-drill.sh runs recovery-verify.cjs): with the live release's
# own pg module, the instance's environment (/etc/konjir/env) and its database URL from SSM, read
# into a file only the konjir user can read, never printed or put on a command line. It prints the
# migration's refusals, or that it applies cleanly, then what it will do; it changes nothing.
cmd_preflight() {
  local migration="${1:-}" runner sql script
  [[ "$migration" =~ ^[0-9]{4}$ ]] || die "usage: konjir-ops.sh preflight <NNNN>, for example preflight 0027"
  [ -f "$HERE/preflight/$migration.sql" ] || die "no preflight for $migration: deploy/preflight/$migration.sql doesn't exist"
  runner="$(gzip -9c <"$HERE/preflight/run.cjs" | base64 | tr -d '\n')"
  sql="$(gzip -9c <"$HERE/preflight/$migration.sql" | base64 | tr -d '\n')"
  script="set -euo pipefail
. /etc/konjir/env
d=\$(mktemp -d /tmp/konjir-preflight.XXXXXX)
trap 'rm -rf \"\$d\"' EXIT
umask 077
aws ssm get-parameter --region \"\$AWS_REGION\" --name \"\$KONJIR_DATABASE_PARAM\" --with-decryption --query Parameter.Value --output text >\"\$d/url\"
printf '%s' '$runner' | base64 -d | gunzip >\"\$d/run.cjs\"
printf '%s' '$sql' | base64 -d | gunzip >\"\$d/preflight.sql\"
chown -R konjir:konjir \"\$d\"
runuser -u konjir -- /usr/local/bin/node \"\$d/run.cjs\" \"\$d\" '$migration'"
  echo "preflight $migration: read-only, on $ENV's database, through Kolab's instance with the live release's pg"
  on_kolab "$script"
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

INJECT_USAGE="usage: konjir-ops.sh inject <crash|down [1-15 min]|dead-job|errors|log-flood|disk-high [12-30 min]|no-logs [45-60 min]|rds-cpu|rds-storage> [--yes-production]"

# Sets off one alarm on purpose (README: Alarms). crash, down, log-flood, disk-high and no-logs go
# through the real instance, so they say what they will do and need --yes-production; dead-job and
# errors put lines into the log group's `inject` stream, which the same filters count; the RDS
# alarms are set by hand, and go back to their real state at their next evaluation.
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
    log-flood) inject_log_flood "$yes"; return ;;
    disk-high) inject_disk_high "$minutes" "$yes"; return ;;
    no-logs)   inject_no_logs "$minutes" "$yes"; return ;;
    crash|down)
      site="https://$(out url | sed 's|^https://||; s|/mcp$||')"
      if [ "$what" = crash ]; then
        echo "inject crash: kills the live Kolab at $site (SIGKILL); systemd restarts it 3 s later, and service-exited fires"
      else
        minutes="$(minutes_in "${minutes:-4}" 1 15 "down takes 1 to 15 minutes")"
        echo "inject down: stops the live Kolab at $site for $minutes minutes, then systemd starts it again; healthz-failing fires"
      fi
      [ -n "$yes" ] || die "this breaks the production Kolab; run it again with --yes-production"
      # down: systemd starts Kolab again from a timer of its own, so neither this shell nor SSM has
      # to last the wait.
      if [ "$what" = crash ]; then on_kolab_inject crash; else on_kolab_inject down "$minutes"; fi
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

# ---- The injects that go through the instance (W2.19: an injected failure of each kind emails)
#
# Each goes through the real instance, agent and alarm. It says what it will do and for how long,
# then which alarm to watch. What it changes on the instance runs as a transient systemd unit or
# timer, konjir-inject-*, with a bound of its own, so it ends, and undoes itself, even if this
# shell, the SSM command or the laptop goes away. Each refuses while another konjir-inject-* unit
# is active, or a deploy is installing a release (konjir-update, run by the install association),
# so no two overlap: no-logs would blind disk-high, and a flood rotating the copy while the agent
# is stopped would lose lines. disk-high and no-logs also watch their alarm from here, and undo the
# inject as soon as it fires, or on Ctrl-C or a closed terminal.

# A number of minutes from $1, in decimal (a leading 0 isn't octal), from $2 to $3; else dies with $4.
minutes_in() {
  [[ "$1" =~ ^[0-9]+$ ]] || die "$4"
  local m=$((10#$1))
  [ "$m" -ge "$2" ] && [ "$m" -le "$3" ] || die "$4"
  echo "$m"
}

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

hhmm() { python3 -c 'import sys, time; print(time.strftime("%H:%MZ", time.gmtime(int(sys.argv[1]))))' "$1"; }

# Runs inject_script on Kolab, through on_kolab, with a mode and its arguments (plain words). A
# preview runs from stdin and writes nothing. Every other mode runs the script from
# /run/konjir-inject-<its hash>.sh, written only if absent (and atomically), since the units it
# starts run that file: a later call never rewrites a script a unit is running. /run is a tmpfs.
on_kolab_inject() {
  local encoded hash
  encoded="$(inject_script | gzip -9nc | base64 | tr -d '\n')"
  if [ "$1" = disk-high-preview ]; then
    on_kolab "printf '%s' '$encoded' | base64 -d | gunzip | bash -s -- $*"
  else
    hash="$(inject_script | shasum -a 256 | cut -c1-12)"
    on_kolab "f=/run/konjir-inject-$hash.sh; [ -f \$f ] || { printf '%s' '$encoded' | base64 -d | gunzip > \$f.new && mv -f \$f.new \$f; }; bash \$f $*"
  fi
}

# The instance's side of every inject that goes through it, run as root through SSM.
#
# log-flood: lines past the alarm's threshold go into konjir.service's journal, as root with
# OBJECT_SYSTEMD_UNIT, as the journal copy's own probe does, so they take the real path: journald,
# journalctl, the copy, the agent, the log group. Each says what it is, is plain text (so no filter
# but the group's IncomingBytes counts it), and is 16,000 bytes, under the copy's 16 KiB cap. They
# are paced over 25 minutes, about 60 a second, well under journald's rate limit. The generator,
# and the rotations it runs, are at the lowest CPU and I/O priority; journald, the copy and the
# agent, which carry Kolab's own lines too, aren't (README: the log-flood row). The disk stays
# safe: journald compresses lines this repetitive to almost nothing; the flood rotates the copy
# itself every 64 MB (its timer only runs every 10 minutes), so /var/log/konjir holds a few
# hundred MB at most, and the rotated copies are removed when it ends; it stops if / has under
# 2 GiB free.
#
# disk-high: one file, /var/tmp/konjir-inject-disk-high.fill (fallocate, so it takes no time),
# takes / (the file system the alarm watches) to 1 point over the alarm's threshold, which is
# enough, since the alarm takes the maximum. The floor is journald's SystemKeepFree, as journald
# reads it, plus 256 MB: under that, journald stops growing its file and may drop lines. It is
# refused unless the fill leaves 128 MB more than the floor, and the hold removes the file as soon
# as / falls under the floor (a deploy's install, say). The file goes on any exit (a trap), after
# it (ExecStopPost, even if killed), at the unit's bound, and at the next boot (a tmpfiles.d entry,
# removed with the file). Kolab's database is on RDS, and its data volume (/var/lib/konjir) is a
# file system of its own, so neither is touched.
#
# no-logs: stops the CloudWatch agent, so nothing ships, while Kolab, Caddy and the journal copies
# keep running: their lines wait in /var/log/konjir, and the agent sends them, from where it
# stopped, once it starts again. A systemd timer starts it at the bound whatever happens here (it
# is enabled, so a reboot starts it too).
inject_script() {
  cat <<'EOF'
set -euo pipefail
self=$0
fill=/var/tmp/konjir-inject-disk-high.fill
tmpfiles=/etc/tmpfiles.d/konjir-inject.conf
mib=$((1 << 20)); gib=$((1 << 30))

# Refuses while another inject's unit or timer is active, or a deploy is installing a release.
guard() {
  local others
  others=$(systemctl list-units --all --plain --no-legend --state=active,activating,deactivating,reloading 'konjir-inject-*' | awk '{print $1}' | tr '\n' ' ')
  [ -z "${others// /}" ] || { echo "refused: another inject is running on the instance: $others"; exit 1; }
  command -v pgrep >/dev/null || { echo "refused: no pgrep (procps-ng), so a running deploy can't be seen"; exit 1; }
  if pgrep -f '/usr/local/bin/konjir-update|deploy/release/install\.sh' >/dev/null; then
    echo "refused: a deploy is installing a release (konjir-update); try again once it's done"; exit 1
  fi
}
need_agent() {
  systemctl is-active -q amazon-cloudwatch-agent || { echo "refused: the CloudWatch agent isn't running, so nothing ships (no-logs fires on its own)"; exit 1; }
}
free_on_root() { df -B1 --output=avail / | tail -n 1 | tr -d ' '; }

# journald's SystemKeepFree for /var/log/journal, on /, in bytes: as configured, or its default,
# 15% of the file system, at most 4 GiB.
keep_free() {
  local size=$1 v
  v=$(systemd-analyze cat-config systemd/journald.conf 2>/dev/null | sed -n 's/^[[:space:]]*SystemKeepFree=[[:space:]]*//p' | tail -n 1)
  if [[ "$v" =~ ^([0-9]+)([KMGT]?)$ ]]; then
    case "${BASH_REMATCH[2]}" in
      K) echo $(( BASH_REMATCH[1] << 10 )) ;; M) echo $(( BASH_REMATCH[1] << 20 )) ;;
      G) echo $(( BASH_REMATCH[1] << 30 )) ;; T) echo $(( BASH_REMATCH[1] << 40 )) ;;
      *) echo "${BASH_REMATCH[1]}" ;;
    esac
  else
    v=$(( size * 15 / 100 )); [ "$v" -le $((4 * gib)) ] || v=$((4 * gib)); echo "$v"
  fi
}

# disk-high's sizes, and its refusals: sets need and floor. Reads only.
disk_plan() {
  local threshold=$1 used avail size pct target left
  guard; need_agent
  command -v fallocate >/dev/null || { echo "refused: no fallocate (util-linux) on the instance"; exit 1; }
  [ "$(findmnt -n -o TARGET --target /var/tmp)" = / ] || { echo "refused: /var/tmp isn't on /, the file system the alarm watches"; exit 1; }
  read -r used avail < <(df -B1 --output=used,avail / | tail -n 1)
  if [ -f "$fill" ]; then   # left by a hold that ended without its cleanup: the start removes it
    left=$(stat -c %s "$fill"); used=$((used - left)); avail=$((avail + left))
  fi
  size=$((used + avail)); pct=$((used * 100 / size)); target=$((threshold + 1))
  need=$((size * target / 100 - used))
  left=$((avail - need))
  floor=$(( $(keep_free "$(df -B1 --output=size / | tail -n 1 | tr -d ' ')") + 256 * mib ))
  echo "  / is $((size >> 30)) GiB and ${pct}% used, with $((avail / mib)) MiB free. At ${target}% it would have $((left / mib)) MiB free;"
  echo "  the hold ends early under $((floor / mib)) MiB free (journald's keep-free plus 256 MB)"
  [ "$pct" -lt "$threshold" ] || { echo "refused: / is ${pct}% used already, at or over the alarm's ${threshold}%: free space first"; exit 1; }
  [ "$left" -ge $((floor + 128 * mib)) ] || { echo "refused: that would leave / too near journald's keep-free floor"; exit 1; }
}

case "$1" in
  crash)
    guard; need_agent
    systemctl kill --signal=KILL konjir.service && echo "  killed Kolab; systemd restarts it in 3 s" ;;
  down)
    guard
    systemctl reset-failed konjir-inject-start.timer konjir-inject-start.service 2>/dev/null || true
    systemd-run --quiet --collect --unit=konjir-inject-start --on-active="$2m" --timer-property=AccuracySec=1s /usr/bin/systemctl start konjir.service
    systemctl stop konjir.service && echo "  stopped Kolab; systemd starts it again in $2 minutes (konjir-inject-start.timer)" ;;

  log-flood)
    target=$2 seconds=$3 delay=$4 unit=konjir-inject-log-flood
    guard; need_agent
    systemctl is-active -q konjir-journal@konjir || { echo "refused: konjir-journal@konjir isn't running, so the lines wouldn't ship"; exit 1; }
    avail=$(free_on_root)
    [ "$avail" -ge $((3 * gib)) ] || { echo "refused: / has under 3 GiB free"; exit 1; }
    py="${self%.sh}.py"
    [ -f "$py" ] || { cat > "$py.new" <<'PY'
import os, socket, subprocess, sys, time
target, seconds = int(sys.argv[1]), int(sys.argv[2])
LINE, FLOOR, ROTATE_EVERY = 16000, 2 << 30, 64 << 20
SELF = ('konjir-inject-log-flood.service', 'konjir-inject-log-flood.timer')

# Started later by its timer: check again that the agent ships and nothing else is injecting.
if subprocess.run(['/usr/bin/systemctl', 'is-active', '-q', 'amazon-cloudwatch-agent']).returncode != 0:
    sys.exit('the CloudWatch agent is not running: no flood')
units = subprocess.run(['/usr/bin/systemctl', 'list-units', '--all', '--plain', '--no-legend', '--state=active,activating,deactivating,reloading', 'konjir-inject-*'],
                       capture_output=True, text=True).stdout.split('\n')
others = [u.split()[0] for u in units if u.strip() and u.split()[0] not in SELF]
if others:
    sys.exit('another inject is running (%s): no flood' % ' '.join(others))

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
        # What konjir-journal-rotate.service runs (copytruncate once past 50 MB), but from here, at
        # this unit's priority. logrotate locks its state file, so a timer's run at the same time waits.
        subprocess.run(['/usr/sbin/logrotate', '--state', '/var/lib/logrotate/konjir-journal.status', '/etc/logrotate.d/konjir-journal'], check=False)
        since_rotate = 0
    time.sleep(max(0.0, start + sent / per_s - time.monotonic()))
print('wrote %d lines, %d MiB' % (sent, sent * LINE >> 20), flush=True)
PY
      mv -f "$py.new" "$py"; }
    systemctl reset-failed "$unit.service" "$unit.timer" 2>/dev/null || true
    when=()
    [ "$delay" -eq 0 ] || when=(--on-active="${delay}s" --timer-property=AccuracySec=1s)
    # The rotated copies are the flood's, nearly all: removed when it ends, however it ends.
    systemd-run --quiet --collect --unit="$unit" "${when[@]}" -p RuntimeMaxSec=$((seconds + 600)) \
      -p Nice=19 -p IOSchedulingClass=idle -p CPUQuota=30% \
      -p "ExecStopPost=/bin/rm -f /var/log/konjir/konjir.log.1 /var/log/konjir/konjir.log.2" \
      /usr/bin/python3 "$py" "$target" "$seconds"
    echo "  started $unit, with $((avail >> 30)) GiB free on /; its progress: journalctl -u $unit" ;;

  disk-high-preview)
    disk_plan "$2" ;;
  disk-high-start)
    threshold=$2 hold=$3 unit=konjir-inject-disk-high
    disk_plan "$threshold"
    rm -f "$fill"   # left by a hold that ended without its cleanup
    mkdir -p "${tmpfiles%/*}"
    printf 'r %s\n' "$fill" > "$tmpfiles"   # a reboot mid-hold removes it at boot
    systemctl reset-failed "$unit" 2>/dev/null || true
    systemd-run --quiet --collect --unit="$unit" -p RuntimeMaxSec=$((hold + 60)) -p "ExecStopPost=/bin/rm -f $fill $tmpfiles" \
      /bin/bash "$self" disk-high-hold "$need" "$hold" "$floor"
    sleep 3
    echo "  $fill: $((need / mib)) MiB; / is $(df --output=pcent / | tail -n 1 | tr -d ' ') used, for at most $((hold / 60)) minutes" ;;
  disk-high-hold)
    need=$2 hold=$3 floor=$4
    trap 'rm -f "$fill" "$tmpfiles"; echo "removed $fill"' EXIT
    trap 'exit 0' INT TERM HUP
    fallocate -l "$need" "$fill"
    end=$(( $(date +%s) + hold ))
    while [ "$(date +%s)" -lt "$end" ]; do
      [ "$(free_on_root)" -ge "$floor" ] || { echo "under $((floor / mib)) MiB free on /: removing $fill early"; exit 0; }
      sleep 5
    done ;;
  disk-high-stop)
    systemctl stop konjir-inject-disk-high 2>/dev/null || true
    rm -f "$fill" "$tmpfiles"
    echo "  removed $fill; / is $(df --output=pcent / | tail -n 1 | tr -d ' ') used" ;;

  no-logs-start)
    guard; need_agent
    systemctl reset-failed konjir-inject-no-logs.timer konjir-inject-no-logs.service 2>/dev/null || true
    systemd-run --quiet --collect --unit=konjir-inject-no-logs --on-active="$2m" --timer-property=AccuracySec=1s /usr/bin/systemctl start amazon-cloudwatch-agent.service
    systemctl stop amazon-cloudwatch-agent.service
    echo "  stopped the CloudWatch agent; systemd starts it again in $2 minutes (konjir-inject-no-logs.timer)" ;;
  no-logs-restore)
    systemctl stop konjir-inject-no-logs.timer 2>/dev/null || true
    systemctl start amazon-cloudwatch-agent.service
    echo "  started the CloudWatch agent again; the lines written meanwhile ship now" ;;

  *) echo "konjir-ops inject on the instance: unknown mode '$1'"; exit 2 ;;
esac
EOF
}

inject_log_flood() {
  local yes="$1" alarm threshold target seconds=1500 now into delay=0 starts
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
  echo "  journal, paced over $(( seconds / 60 )) minutes and starting $starts. They ship to the konjir stream like Kolab's own lines, and stay"
  echo "  there 30 days, for about \$$(python3 -c 'import sys; print("%.2f" % (int(sys.argv[1]) / 1e9 * 0.5))' "$target") of ingestion. Kolab keeps running, but its own lines queue behind the flood's"
  echo "  in the journal copy, and a line written as the copy is rotated (every minute or so) can be lost; the flood stops if / has under 2 GiB free."
  [ -n "$yes" ] || die "this floods the production instance's log shipping; run it again with --yes-production"
  on_kolab_inject log-flood "$target" "$seconds" "$delay"
  echo "watch $alarm (deploy/konjir-ops.sh alarms): it fires once the hour's lines pass $(( threshold >> 20 )) MiB, so within the hour the"
  echo "flood ends in, and recovers in the hour after. To stop it early, in a shell: sudo systemctl stop konjir-inject-log-flood.timer konjir-inject-log-flood"
}

inject_disk_high() {
  local minutes yes="$2" alarm threshold
  minutes="$(minutes_in "${1:-20}" 12 30 "disk-high holds for 12 to 30 minutes")"
  alarm="$(alarm_named disk-high)"
  refuse_if_alarm "$alarm"
  threshold="$(alarm_value "$alarm" Threshold)"; threshold="${threshold%.*}"
  echo "inject disk-high: fills the instance's root file system to $(( threshold + 1 ))%, past the alarm's ${threshold}%, with one file,"
  echo "  /var/tmp/konjir-inject-disk-high.fill, and holds it until the alarm fires, for at most $minutes minutes, then removes it."
  echo "  Kolab keeps running; its database (RDS) and data volume aren't touched. The plan, from the instance (a read-only check):"
  on_kolab_inject disk-high-preview "$threshold"
  [ -n "$yes" ] || die "this fills the production instance's disk; run it again with --yes-production"
  trap 'echo "interrupted: removing the file now"; on_kolab_inject disk-high-stop; exit 130' INT TERM HUP
  on_kolab_inject disk-high-start "$threshold" $(( minutes * 60 ))
  echo "watching $alarm: the agent reports every minute, and the alarm takes two 5-minute periods over ${threshold}%, so 10 to 15 minutes"
  if await_alarm "$alarm" $(( minutes * 60 )); then
    trap - INT TERM HUP
    on_kolab_inject disk-high-stop
    echo "$alarm fired; its email is on its way, and its OK one follows within about 10 minutes"
  else
    trap - INT TERM HUP
    on_kolab_inject disk-high-stop
    die "$alarm didn't fire within $minutes minutes (if the hold ended early, its journal says why: journalctl -u konjir-inject-disk-high); see deploy/konjir-ops.sh alarms"
  fi
}

inject_no_logs() {
  local minutes yes="$2" alarm
  minutes="$(minutes_in "${1:-50}" 45 60 "no-logs pauses shipping for 45 to 60 minutes")"
  alarm="$(alarm_named no-logs)"
  refuse_if_alarm "$alarm"
  echo "inject no-logs: stops the CloudWatch agent on the instance until the alarm fires, for at most $minutes minutes, then starts it again."
  echo "  Kolab, Caddy and the journal copies keep running, and their lines ship once the agent is back; meanwhile the other log alarms are blind."
  echo "  A deploy meanwhile starts the agent again (observe.sh), which ends the inject early, and the alarm doesn't fire."
  [ -n "$yes" ] || die "this stops log shipping from the production instance; run it again with --yes-production"
  trap 'echo "interrupted: starting the agent again"; on_kolab_inject no-logs-restore; exit 130' INT TERM HUP
  on_kolab_inject no-logs-start "$minutes"
  echo "watching $alarm: it fires after three 10-minute periods with no fresh heartbeat, so in 30 to 45 minutes"
  if await_alarm "$alarm" $(( minutes * 60 )); then
    trap - INT TERM HUP
    on_kolab_inject no-logs-restore
    echo "$alarm fired; its email is on its way. The heartbeats held back ship now, so its OK email follows within about 10 minutes"
  else
    trap - INT TERM HUP
    on_kolab_inject no-logs-restore
    die "$alarm didn't fire within $minutes minutes (a deploy meanwhile starts the agent early); see deploy/konjir-ops.sh alarms"
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
  preflight)     shift; cmd_preflight "$@" ;;
  terraform)     shift; tf "$@" ;;
  *)             sed -n '2,30p' "$0"; exit 1 ;;
esac
