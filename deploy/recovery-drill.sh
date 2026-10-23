#!/usr/bin/env bash
# The restore drill (P12, D75; W2.24), and the restore runbook's verify step (deploy/RECOVERY.md).
#
#   deploy/recovery-drill.sh                restore production's latest restorable time into a scratch RDS
#                                           instance, <production>-drill-<UTC date-time>; wait for it; verify it
#                                           through Kolab's instance (deploy/recovery-verify.cjs, over SSM); log the
#                                           timings to deploy/drills/<scratch>.log; then delete it, with no final
#                                           snapshot. It asks before creating anything and before deleting.
#   deploy/recovery-drill.sh verify <id>    verify a restored instance against production, as the drill does (runbook)
#   deploy/recovery-drill.sh delete <id>    delete a scratch instance a drill left behind (only one this script made)
#
# It never modifies, restarts or deletes the production database, and never changes a parameter:
# production is only described, and read through read-only sessions. The scratch instance gets
# production's subnet group, security group and class, so only Kolab's instance can reach it, and
# costs about $0.02 an hour while it exists. Production is the database deploy/terraform's outputs name.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF="$HERE/terraform"
export AWS_PROFILE="${AWS_PROFILE:-icedlee337}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PAGER=""
LOG_DIR="${KONJIR_DRILL_LOG_DIR:-$HERE/drills}"
TAG_PURPOSE=recovery-drill
RPO_TARGET_S=300      # recovery point: under 5 minutes (D75)
RTO_TARGET_S=3600     # restore: under 1 hour (D75)
WAIT_CAP_S=5400       # give up waiting for the scratch instance after 90 minutes
LOG=/dev/null

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
out() { terraform -chdir="$TF" output -raw "$1" 2>/dev/null || die "no Terraform output '$1'; run terraform init in $TF, with access to its state"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s\n' "$(now)" "$*" | tee -a "$LOG"; }
# Seconds since the epoch, from an RDS timestamp such as 2026-10-22T18:04:31.123000+00:00 or ...Z.
epoch_of() { python3 -c 'import datetime,sys;print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp()))' "$1"; }
mins() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

# Asks on the terminal; anything but the exact word is no.
confirm() {
  local word="$1" answer
  { : </dev/tty; } 2>/dev/null || die "this needs a terminal to confirm; nothing was done"
  printf 'Type %s to go on, anything else to stop: ' "$word" >/dev/tty
  read -r answer </dev/tty || answer=""
  [ "$answer" = "$word" ]
}

# The production database's identifier: the first label of Terraform's database_endpoint.
production_id() {
  local endpoint; endpoint="$(out database_endpoint)"
  endpoint="${endpoint%%.*}"
  [ -n "$endpoint" ] || die "Terraform's database_endpoint is empty"
  printf '%s' "$endpoint"
}

# 0 if the instance exists, 1 if RDS says it doesn't; anything else (credentials, network) stops.
exists() {
  local err
  if err="$(aws rds describe-db-instances --db-instance-identifier "$1" --query 'DBInstances[0].DBInstanceIdentifier' --output text 2>&1 >/dev/null)"; then return 0; fi
  [[ "$err" == *DBInstanceNotFound* ]] && return 1
  die "could not ask RDS about $1: $err"
}

field() { aws rds describe-db-instances --db-instance-identifier "$1" --query "DBInstances[0].$2" --output text; }

# Refuses anything that is, or might be, production.
not_production() {
  local id="$1" prod="$2"
  [ -n "$id" ] || die "name an instance"
  [ "$id" != "$prod" ] || die "$id is the production database; refusing"
}

# Runs a shell script on Kolab's instance through SSM Run Command, as deploy/konjir-ops.sh does, and
# prints its output. Returns the command's status.
# It is called where set -e doesn't apply (if verify ...), so each step checks for itself.
on_kolab() {
  local instance cmd_id status t0
  instance="$(out instance_id)" || return 1
  cmd_id="$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --comment "konjir recovery verify" --timeout-seconds 600 \
    --parameters "$(python3 -c 'import json,sys;print(json.dumps({"commands":[sys.argv[1]],"executionTimeout":["900"]}))' "$1")" \
    --query Command.CommandId --output text)" || return 1
  [ -n "$cmd_id" ] || return 1
  t0="$(date +%s)"
  while :; do
    status="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
      --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) ;; *) break ;; esac
    [ $(($(date +%s) - t0)) -lt 1200 ] || { echo "SSM command $cmd_id still $status after 20 minutes"; return 1; }
    sleep 3
  done
  aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
    --query '[StandardOutputContent, StandardErrorContent]' --output text
  [ "$status" = Success ]
}

# Verifies a restored instance against production through Kolab's instance (deploy/recovery-verify.cjs).
# Production's URL is read there, from its SSM parameter, into a file only the konjir user can read,
# and is never printed or put on a command line.
verify() {
  local id="$1" prod="$2" host port verifier script
  not_production "$id" "$prod"
  [ "$(field "$id" DBInstanceStatus)" = available ] || die "$id is not available yet"
  host="$(field "$id" Endpoint.Address)"
  port="$(field "$id" Endpoint.Port)"
  [[ "$host" =~ ^[a-z0-9.-]+$ && "$port" =~ ^[0-9]+$ ]] || die "unexpected endpoint for $id"
  verifier="$(gzip -9c <"$HERE/recovery-verify.cjs" | base64 | tr -d '\n')"
  script="set -euo pipefail
. /etc/konjir/env
d=\$(mktemp -d /tmp/konjir-recovery.XXXXXX)
trap 'rm -rf \"\$d\"' EXIT
umask 077
aws ssm get-parameter --region \"\$AWS_REGION\" --name \"\$KONJIR_DATABASE_PARAM\" --with-decryption --query Parameter.Value --output text >\"\$d/prod-url\"
printf '%s' '$verifier' | base64 -d | gunzip >\"\$d/verify.cjs\"
chown -R konjir:konjir \"\$d\"
runuser -u konjir -- /usr/local/bin/node \"\$d/verify.cjs\" \"\$d\" '$host' '$port'"
  log "verify: $id ($host) against $prod, through Kolab's instance"
  local status=0
  on_kolab "$script" 2>&1 | tee -a "$LOG" || status=$?
  return "$status"
}

delete_scratch() {
  local id="$1" prod="$2" arn purpose
  not_production "$id" "$prod"
  [[ "$id" == "$prod"-drill-* ]] || die "$id is not a drill's scratch instance ($prod-drill-...); refusing"
  arn="$(field "$id" DBInstanceArn)"
  purpose="$(aws rds list-tags-for-resource --resource-name "$arn" --query "TagList[?Key=='Purpose'].Value | [0]" --output text)"
  [ "$purpose" = "$TAG_PURPOSE" ] || die "$id has no Purpose=$TAG_PURPOSE tag, so this script didn't make it; refusing"
  [ "$(field "$id" DeletionProtection)" = False ] || die "$id has deletion protection on; refusing"
  echo "Delete $id now, with no final snapshot and none of its automated backups kept?"
  if ! confirm delete; then
    log "left $id running; delete it later with: deploy/recovery-drill.sh delete $id"
    return 1
  fi
  local t0; t0="$(date +%s)"
  aws rds delete-db-instance --db-instance-identifier "$id" --skip-final-snapshot --delete-automated-backups \
    --query DBInstance.DBInstanceStatus --output text >/dev/null
  log "delete: requested for $id; waiting until it is gone"
  while exists "$id"; do sleep 30; done
  log "delete: $id is gone, in $(mins $(($(date +%s) - t0)))"
}

# Once the scratch instance may exist, a failure or ^C still offers to delete it.
DRILL_PROD="" DRILL_SCRATCH="" DRILL_CREATED=0
drill_exit() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$DRILL_CREATED" = 1 ] && exists "$DRILL_SCRATCH"; then
    log "drill stopped before the end; $DRILL_SCRATCH still exists"
    delete_scratch "$DRILL_SCRATCH" "$DRILL_PROD" || true
  fi
  exit "$rc"
}

drill() {
  local prod status retention latest subnets sgs class kolab ping scratch t_start t_avail t_verified lag verified=0
  prod="$(production_id)"
  exists "$prod" || die "production database $prod not found"
  status="$(field "$prod" DBInstanceStatus)"
  retention="$(field "$prod" BackupRetentionPeriod)"
  latest="$(field "$prod" LatestRestorableTime)"
  subnets="$(field "$prod" DBSubnetGroup.DBSubnetGroupName)"
  sgs="$(field "$prod" 'VpcSecurityGroups[].VpcSecurityGroupId')"
  class="$(field "$prod" DBInstanceClass)"
  [ "$status" = available ] || die "production database $prod is $status, not available; try later"
  [ "$retention" -gt 0 ] 2>/dev/null || die "production database $prod keeps no automated backups, so has no point-in-time recovery"
  [ -n "$latest" ] && [ "$latest" != None ] || die "production database $prod has no latest restorable time yet"
  kolab="$(out instance_id)"
  ping="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$kolab" --query 'InstanceInformationList[0].PingStatus' --output text)"
  [ "$ping" = Online ] || die "Kolab's instance $kolab isn't online in Systems Manager ($ping), so the drill couldn't verify; nothing was done"

  scratch="$prod-drill-$(date -u +%Y%m%d-%H%M)"
  not_production "$scratch" "$prod"
  ! exists "$scratch" || die "$scratch already exists; refusing to touch it. Wait a minute, or delete it: deploy/recovery-drill.sh delete $scratch"

  cat <<EOF
Restore drill (P12, D75)

  Production:     $prod ($class, $retention days of backups), never modified
  Recovery point: its latest restorable time, $latest
  Scratch:        $scratch, a new $class in subnet group $subnets and security group(s) $sgs
  Verify:         through Kolab's instance $kolab (SSM): migrations, row counts, and a second Kolab
                  on its 127.0.0.1:7499 against the scratch copy, briefly
  Cost:           about \$0.02 an hour while the scratch instance exists; the drill takes 20-60 minutes
  Log:            $LOG_DIR/$scratch.log

This creates $scratch now.
EOF
  confirm "$scratch" || die "stopped; nothing was created"

  mkdir -p "$LOG_DIR"
  LOG="$LOG_DIR/$scratch.log"
  DRILL_PROD="$prod" DRILL_SCRATCH="$scratch"
  trap drill_exit EXIT
  trap 'exit 130' INT TERM

  # The recovery point is read again just before the restore, so the lag is what an incident now would lose.
  latest="$(field "$prod" LatestRestorableTime)"
  t_start="$(date +%s)"
  lag=$((t_start - $(epoch_of "$latest")))
  log "drill: production $prod, scratch $scratch, by ${USER:-?} from $(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo '?')"
  log "recovery point: $latest, $lag s behind now (target under $RPO_TARGET_S s)"
  # shellcheck disable=SC2086 # one security group id per word
  aws rds restore-db-instance-to-point-in-time \
    --source-db-instance-identifier "$prod" \
    --target-db-instance-identifier "$scratch" \
    --restore-time "$latest" \
    --db-instance-class "$class" \
    --db-subnet-group-name "$subnets" \
    --vpc-security-group-ids $sgs \
    --no-publicly-accessible --no-multi-az --no-deletion-protection --no-auto-minor-version-upgrade \
    --tags "Key=Project,Value=konjir" "Key=Purpose,Value=$TAG_PURPOSE" "Key=Source,Value=$prod" "Key=ManagedBy,Value=recovery-drill.sh" \
    --query DBInstance.DBInstanceStatus --output text >/dev/null
  DRILL_CREATED=1
  log "restore: requested"

  local last="" s
  while :; do
    s="$(field "$scratch" DBInstanceStatus 2>/dev/null || echo requested)"
    [ "$s" = "$last" ] || { log "restore: $s ($(mins $(($(date +%s) - t_start))))"; last="$s"; }
    [ "$s" = available ] && break
    case "$s" in failed|incompatible-*|inaccessible-encryption-credentials*|storage-full) die "restore ended $s" ;; esac
    [ $(($(date +%s) - t_start)) -lt "$WAIT_CAP_S" ] || die "not available after $(mins "$WAIT_CAP_S"); giving up"
    sleep 30
  done
  t_avail="$(date +%s)"
  log "restore: available in $(mins $((t_avail - t_start)))"

  if verify "$scratch" "$prod"; then verified=1; fi
  t_verified="$(date +%s)"

  local rpo_ok=no rto_ok=no
  [ "$lag" -lt "$RPO_TARGET_S" ] && rpo_ok=yes
  [ "$verified" = 1 ] && [ $((t_verified - t_start)) -lt "$RTO_TARGET_S" ] && rto_ok=yes
  log "summary: recovery point $lag s behind (under $RPO_TARGET_S s: $rpo_ok); restored in $(mins $((t_avail - t_start))), verified in $(mins $((t_verified - t_start))) (under $(mins "$RTO_TARGET_S"): $rto_ok); verification $([ "$verified" = 1 ] && echo passed || echo FAILED)"

  delete_scratch "$scratch" "$prod" || true
  trap - EXIT INT TERM
  log "drill: done; log at $LOG"
  [ "$verified" = 1 ]
}

case "${1:-drill}" in
  drill)  [ $# -le 1 ] || die "usage: recovery-drill.sh [drill | verify <id> | delete <id>]"; drill ;;
  verify) [ $# -eq 2 ] || die "usage: recovery-drill.sh verify <id>"
          prod="$(production_id)"; exists "$2" || die "$2 not found"
          mkdir -p "$LOG_DIR"; LOG="$LOG_DIR/verify-$2-$(date -u +%Y%m%d-%H%M).log"; verify "$2" "$prod" ;;
  delete) [ $# -eq 2 ] || die "usage: recovery-drill.sh delete <id>"
          prod="$(production_id)"; exists "$2" || die "$2 not found"; delete_scratch "$2" "$prod" ;;
  *)      sed -n '2,16p' "$0"; exit 1 ;;
esac
