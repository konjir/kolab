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
#   inject <crash|down [min]|dead-job|errors|rds-cpu|rds-storage> [--yes-production]
#                                                       set off one alarm on purpose, to check it emails (README: Alarms);
#                                                       crash and down break the live Kolab, so they need --yes-production
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

# Sets off one alarm on purpose (README: Alarms). crash and down break the real Kolab, through the
# journal, the agent and the metric filter, so they say what they will do and need --yes-production;
# dead-job and errors put lines into the log group's `inject` stream, which the same filters count;
# the RDS alarms are set by hand, and go back to their real state at their next evaluation.
cmd_inject() {
  local what="" minutes="" yes="" arg site group line count=1 periods=1 alarm
  for arg in "$@"; do
    case "$arg" in
      --yes-production) yes=1 ;;
      *) if [ -z "$what" ]; then what="$arg"; else minutes="$arg"; fi ;;
    esac
  done
  case "$what" in
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
    *) die "usage: konjir-ops.sh inject <crash|down [minutes]|dead-job|errors|rds-cpu|rds-storage>" ;;
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
  *)             sed -n '2,27p' "$0"; exit 1 ;;
esac
