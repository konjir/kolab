#!/usr/bin/env bash
# Day-to-day operations on the Terraform-managed Kolab server. Provisioning lives in deploy/terraform;
# this only reads its outputs and talks to the running Kolab server.
#
#   deploy/konjir-ops.sh connect <actor> <product|engineer>   register a collaborator; print token + setup
#   deploy/konjir-ops.sh status                                health, service state
#   deploy/konjir-ops.sh logs                                  last 200 lines from Kolab and Caddy
#   deploy/konjir-ops.sh bootstrap-log                         the instance's first-boot install log
#   deploy/konjir-ops.sh shell                                 interactive shell (Session Manager plugin)
#   deploy/konjir-ops.sh admin-token                           print the admin token
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TF="$HERE/terraform"
export AWS_PROFILE="${AWS_PROFILE:-icedlee337}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PAGER=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
out() { terraform -chdir="$TF" output -raw "$1" 2>/dev/null || die "no Terraform output '$1'; run terraform apply in $TF first"; }

admin_token() {
  aws ssm get-parameter --name "$(out admin_token_parameter)" --with-decryption --query Parameter.Value --output text
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
  local actor="${1:-}" role="${2:-}" url admin token
  [ -n "$actor" ] && [[ "$role" =~ ^(product|engineer)$ ]] || die "usage: konjir-ops.sh connect <actor> <product|engineer>"
  [ -d "$ROOT/node_modules" ] || die "run npm install in $ROOT first (the konjir CLI runs locally)"
  url="$(out url)"
  admin="$(admin_token)"
  KONJIR_URL="$url" KONJIR_TOKEN="$admin" "$ROOT/bin/konjir" admin_add_actor "id=$actor" >/dev/null 2>&1 || true
  token="$(KONJIR_URL="$url" KONJIR_TOKEN="$admin" "$ROOT/bin/konjir" admin_open_session "actor=$actor" "role=$role" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
  cat <<EOF

$actor ($role) can connect with this token. Send it privately; it works like a password.

  Token:        $token

  Claude Code:  claude mcp add --transport http konjir $url --header "Authorization: Bearer $token"
  Shell / CLI:  export KONJIR_URL=$url KONJIR_TOKEN=$token
                konjir instructions

Revoke with:    KONJIR_URL=$url KONJIR_TOKEN=\$(deploy/konjir-ops.sh admin-token) bin/konjir admin_end_session token=$token
EOF
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
  *)             sed -n '2,12p' "$0"; exit 1 ;;
esac
