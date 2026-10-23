#!/usr/bin/env bash
# The restore drill (P12, D75; W2.24), and the restore runbook's verify step (deploy/RECOVERY.md).
#
#   deploy/recovery-drill.sh --env production|staging
#        restore the stack's latest restorable time into a scratch RDS instance, <db>-drill-<UTC date-time>;
#        wait for it; verify it through Kolab's instance (deploy/recovery-verify.cjs, over SSM) and compare
#        it with the stack's database; log the timings to deploy/drills/<scratch>.log; then delete it, with
#        no final snapshot. It asks before creating anything and before deleting.
#   deploy/recovery-drill.sh --env production|staging verify <id> [--compare-production]
#        verify a restored instance, changing nothing (runbook step 3); with --compare-production, also
#        compare it with the stack's database, if that is reachable
#   deploy/recovery-drill.sh --env production|staging delete <id>
#        delete a scratch instance a drill left behind (only one this script made, from this stack)
#   deploy/recovery-drill.sh --env production|staging vars
#        print the environment's database settings as shell assignments, checked, for the runbook
#
# --env names the environment (D73). Its state is read as deploy/konjir-ops.sh reads it: with W2.23's
# environments/<env>.s3.tfbackend in its own TF_DATA_DIR, or, before W2.23, production's one state.
# The state's database and the SSM parameter holding its URL must both have that environment's
# names, or it refuses; `vars` prints them, for the runbook (deploy/RECOVERY.md). It never
# modifies, restarts or deletes the stack's database, and never changes a parameter: the database is
# only described, restored from, and read through read-only sessions. The scratch instance gets the
# stack's subnet group, security group and class, so only Kolab's instance can reach it, and costs
# about $0.02 an hour while it exists.
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
DB="" PARAM="" SUBNETS="" SGS="" CLASS="" STORAGE="" RETENTION=""

# Each environment's Terraform name: deploy/terraform/modules/environments (W2.23, D73).
stack_of() {
  case "$1" in
    production) echo konjir-test ;;
    staging) echo konjir-staging ;;
    *) die "--env is production or staging, not '$1'" ;;
  esac
}

# Terraform on the environment's state, as deploy/konjir-ops.sh runs it.
tf() {
  if [ -f "$TF/environments/$ENV.s3.tfbackend" ]; then
    export TF_DATA_DIR="$TF/.terraform-$ENV" TF_VAR_environment="$ENV"
    if [ ! -f "$TF_DATA_DIR/terraform.tfstate" ]; then
      terraform -chdir="$TF" init -input=false -backend-config="environments/$ENV.s3.tfbackend" >&2 || die "terraform init failed for $ENV"
    fi
  else
    # Before W2.23 there is one state, production's.
    [ "$ENV" = production ] || die "there is no $ENV environment before W2.23"
  fi
  terraform -chdir="$TF" "$@"
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
out() { tf output -raw "$1" 2>/dev/null || die "no Terraform output '$1' in $ENV; run terraform init in $TF, and apply this branch once"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s\n' "$(now)" "$*" | tee -a "$LOG"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
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

# The environment's database, from its state's database_recovery output, checked against --env:
# sets DB, PARAM, SUBNETS, SGS, CLASS, STORAGE and RETENTION.
load_stack() {
  local stack="$1" json
  json="$(tf output -json database_recovery 2>/dev/null)" \
    || die "no Terraform output 'database_recovery' in $ENV's state; run terraform init in $TF, and apply this branch once"
  local assignments
  assignments="$(python3 -c '
import json, shlex, sys
r = json.loads(sys.argv[1])
for k, v in [("DB", r["identifier"]), ("PARAM", r["url_parameter"]), ("SUBNETS", r["subnet_group"]),
             ("SGS", r["security_group"]), ("CLASS", r["instance_class"]), ("STORAGE", r["storage_type"]),
             ("RETENTION", r["backup_retention_days"])]:
    print(f"{k}={shlex.quote(str(v))}")' "$json")" || die "unexpected database_recovery output in $ENV's state"
  eval "$assignments"
  [ "$(lower "$DB")" = "$(lower "$stack-db")" ] && [ "$PARAM" = "/konjir/$stack/database-url" ] \
    || die "$ENV's Terraform state holds database $DB and parameter $PARAM, not $stack's ($stack-db, /konjir/$stack/database-url); refusing"
}

# The AWS error, classified: 0 found, 1 not found; credentials or anything else stops, saying
# what to clean up when a scratch instance may exist.
aws_failed() {
  local err="$1" what="$2"
  [[ "$err" == *DBInstanceNotFound* ]] && return 1
  local hint=""
  [ "${DRILL_CREATED:-0}" = 1 ] && hint="; the scratch instance $DRILL_SCRATCH may still exist: once you can reach AWS again, run deploy/recovery-drill.sh --env $ENV delete $DRILL_SCRATCH"
  if [[ "$err" == *xpired* || "$err" == *redentials* || "$err" == *"Token"* || "$err" == *"SSO"* ]]; then
    die "AWS credentials failed while asking about $what: $err$hint"
  fi
  die "could not ask RDS about $what: $err$hint"
}

# 0 if the instance exists, 1 if RDS says it doesn't; anything else stops.
exists() {
  local err
  if err="$(aws rds describe-db-instances --db-instance-identifier "$1" --query 'DBInstances[0].DBInstanceIdentifier' --output text 2>&1 >/dev/null)"; then return 0; fi
  aws_failed "$err" "$1"
}

field() {
  local value err
  if value="$(aws rds describe-db-instances --db-instance-identifier "$1" --query "DBInstances[0].$2" --output text 2>"${TMPDIR:-/tmp}/recovery-drill.$$")"; then
    rm -f "${TMPDIR:-/tmp}/recovery-drill.$$"; printf '%s' "$value"; return 0
  fi
  err="$(cat "${TMPDIR:-/tmp}/recovery-drill.$$")"; rm -f "${TMPDIR:-/tmp}/recovery-drill.$$"
  aws_failed "$err" "$1" || die "$1 not found"
}

# Refuses anything that is, or might be, the stack's own database. RDS identifiers ignore case.
not_production() {
  [ -n "$1" ] || die "name an instance"
  [ "$(lower "$1")" != "$(lower "$DB")" ] || die "$1 is $ENV's database; refusing"
}

# Runs a shell script on Kolab's instance through SSM Run Command, as deploy/konjir-ops.sh does, and
# prints its output. Returns the command's status. It is called where set -e doesn't apply
# (if verify ...), so each step checks for itself.
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

# Verifies a restored instance through Kolab's instance (deploy/recovery-verify.cjs), changing
# nothing. The stack's URL is read there, from its SSM parameter (which must be $PARAM, the one
# the instance itself uses), into a file only the konjir user can read; it is never printed or put
# on a command line. compare: also compare with the stack's database, if reachable.
verify() {
  local id="$1" mode="${2:-}" host port verifier script status=0
  not_production "$id"
  [ "$(field "$id" DBInstanceStatus)" = available ] || die "$id is not available yet"
  host="$(field "$id" Endpoint.Address)"
  port="$(field "$id" Endpoint.Port)"
  [[ "$host" =~ ^[a-z0-9.-]+$ && "$port" =~ ^[0-9]+$ ]] || die "unexpected endpoint for $id"
  verifier="$(gzip -9c <"$HERE/recovery-verify.cjs" | base64 | tr -d '\n')"
  script="set -euo pipefail
. /etc/konjir/env
[ \"\$KONJIR_DATABASE_PARAM\" = '$PARAM' ] || { echo \"FAIL this instance uses \$KONJIR_DATABASE_PARAM, not $PARAM; refusing\"; exit 1; }
d=\$(mktemp -d /tmp/konjir-recovery.XXXXXX)
trap 'rm -rf \"\$d\"' EXIT
umask 077
aws ssm get-parameter --region \"\$AWS_REGION\" --name \"\$KONJIR_DATABASE_PARAM\" --with-decryption --query Parameter.Value --output text >\"\$d/prod-url\"
printf '%s' '$verifier' | base64 -d | gunzip >\"\$d/verify.cjs\"
chown -R konjir:konjir \"\$d\"
runuser -u konjir -- /usr/local/bin/node \"\$d/verify.cjs\" \"\$d\" '$host' '$port' '$mode'"
  log "verify: $id ($host), $([ "$mode" = compare ] && echo "compared with $DB" || echo "on its own"), through Kolab's instance"
  on_kolab "$script" 2>&1 | tee -a "$LOG" || status=$?
  return "$status"
}

# The Purpose and Source tags and deletion protection, read again just before deleting.
deletable() {
  local id="$1" arn tags
  arn="$(field "$id" DBInstanceArn)"
  tags="$(aws rds list-tags-for-resource --resource-name "$arn" \
    --query "[TagList[?Key=='Purpose'].Value | [0], TagList[?Key=='Source'].Value | [0]]" --output text)" || die "could not read $id's tags"
  [ "$tags" = "$TAG_PURPOSE	$DB" ] || die "$id isn't tagged Purpose=$TAG_PURPOSE and Source=$DB, so this script didn't make it from $ENV; refusing"
  [ "$(field "$id" DeletionProtection)" = False ] || die "$id has deletion protection on; refusing"
}

delete_scratch() {
  local id="$1" t0
  not_production "$id"
  [[ "$(lower "$id")" == "$(lower "$DB")"-drill-* ]] || die "$id is not a drill's scratch instance ($DB-drill-...); refusing"
  if [ "$(field "$id" DBInstanceStatus)" = deleting ]; then log "delete: $id is already being deleted"; return 0; fi
  deletable "$id"
  echo "Delete $id now, with no final snapshot and none of its automated backups kept?"
  if ! confirm delete; then
    log "left $id running; delete it later with: deploy/recovery-drill.sh --env $ENV delete $id"
    return 1
  fi
  deletable "$id"
  t0="$(date +%s)"
  aws rds delete-db-instance --db-instance-identifier "$id" --skip-final-snapshot --delete-automated-backups \
    --query DBInstance.DBInstanceStatus --output text >/dev/null
  log "delete: requested for $id; waiting until it is gone"
  while exists "$id"; do sleep 30; done
  log "delete: $id is gone, in $(mins $(($(date +%s) - t0)))"
}

# Once the scratch instance may exist, any exit says how to delete it, then offers to.
DRILL_SCRATCH="" DRILL_CREATED=0
drill_exit() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ "$DRILL_CREATED" = 1 ]; then
    printf '\nThe drill stopped before the end. If %s exists, delete it with:\n  deploy/recovery-drill.sh --env %s delete %s\n' \
      "$DRILL_SCRATCH" "$ENV" "$DRILL_SCRATCH" | tee -a "$LOG" >&2
    if exists "$DRILL_SCRATCH"; then delete_scratch "$DRILL_SCRATCH" || true; fi
  fi
  exit "$rc"
}

drill() {
  local status retention latest kolab ping scratch leftovers t_start t_avail t_verified lag verified=0 last="" s
  exists "$DB" || die "$ENV's database $DB not found; the drill restores a running database (deploy/RECOVERY.md covers a lost one)"
  status="$(field "$DB" DBInstanceStatus)"
  retention="$(field "$DB" BackupRetentionPeriod)"
  latest="$(field "$DB" LatestRestorableTime)"
  [ "$status" = available ] || die "$DB is $status, not available; try later"
  [ "$retention" -gt 0 ] 2>/dev/null || die "$DB keeps no automated backups, so has no point-in-time recovery"
  [ -n "$latest" ] && [ "$latest" != None ] || die "$DB has no latest restorable time yet"
  kolab="$(out instance_id)"
  ping="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$kolab" --query 'InstanceInformationList[0].PingStatus' --output text)"
  [ "$ping" = Online ] || die "Kolab's instance $kolab isn't online in Systems Manager ($ping), so the drill couldn't verify; nothing was done"
  leftovers="$(aws rds describe-db-instances --query "DBInstances[?starts_with(DBInstanceIdentifier, '$(lower "$DB")-drill-')].DBInstanceIdentifier" --output text)"
  [ -z "$leftovers" ] || die "an earlier drill's instance still exists: $leftovers. Delete it first: deploy/recovery-drill.sh --env $ENV delete <id>"

  scratch="$(lower "$DB")-drill-$(date -u +%Y%m%d-%H%M)"
  not_production "$scratch"
  ! exists "$scratch" || die "$scratch already exists; refusing to touch it"

  cat <<EOF
Restore drill (P12, D75), $ENV

  Terraform:      $ENV's state
  Database:       $DB ($CLASS, $retention days of backups), never modified
  Recovery point: its latest restorable time, $latest
  Scratch:        $scratch, a new $CLASS ($STORAGE) in subnet group
                  $SUBNETS and security group $SGS
  Verify:         through Kolab's instance $kolab (SSM), changing nothing: migrations, tables, and a
                  read-only Kolab (no migration, no outbox) on its 127.0.0.1:7499, briefly; then a
                  comparison with $DB
  Cost:           about \$0.02 an hour while the scratch instance exists; the drill takes 20-60 minutes
  Log:            $LOG_DIR/$scratch.log

This creates $scratch now.
EOF
  confirm "$scratch" || die "stopped; nothing was created"

  mkdir -p "$LOG_DIR"
  LOG="$LOG_DIR/$scratch.log"
  DRILL_SCRATCH="$scratch"
  trap drill_exit EXIT
  trap 'exit 130' INT TERM
  trap 'exit 129' HUP

  # The recovery point is read again just before the restore, so the lag is what an incident now would lose.
  latest="$(field "$DB" LatestRestorableTime)"
  t_start="$(date +%s)"
  lag=$((t_start - $(epoch_of "$latest")))
  log "drill: $ENV, database $DB, scratch $scratch, by ${USER:-?} from $(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo '?')"
  log "recovery point: $latest, $lag s behind now (D75: under $RPO_TARGET_S s)"
  # Set before the call: if RDS takes the request and the call is interrupted, the exit still offers cleanup.
  DRILL_CREATED=1
  aws rds restore-db-instance-to-point-in-time \
    --source-db-instance-identifier "$DB" \
    --target-db-instance-identifier "$scratch" \
    --restore-time "$latest" \
    --db-instance-class "$CLASS" --storage-type "$STORAGE" \
    --db-subnet-group-name "$SUBNETS" \
    --vpc-security-group-ids "$SGS" \
    --no-publicly-accessible --no-multi-az --no-deletion-protection --no-auto-minor-version-upgrade \
    --tags "Key=Project,Value=konjir" "Key=Purpose,Value=$TAG_PURPOSE" "Key=Source,Value=$DB" "Key=ManagedBy,Value=recovery-drill.sh" \
    --query DBInstance.DBInstanceStatus --output text >/dev/null
  log "restore: requested"

  while :; do
    if exists "$scratch"; then s="$(field "$scratch" DBInstanceStatus)"; else s=requested; fi
    [ "$s" = "$last" ] || { log "restore: $s ($(mins $(($(date +%s) - t_start))))"; last="$s"; }
    [ "$s" = available ] && break
    case "$s" in failed|incompatible-*|inaccessible-encryption-credentials*|storage-full) die "restore ended $s" ;; esac
    [ $(($(date +%s) - t_start)) -lt "$WAIT_CAP_S" ] || die "not available after $(mins "$WAIT_CAP_S"); giving up"
    sleep 30
  done
  t_avail="$(date +%s)"
  log "restore: available in $(mins $((t_avail - t_start)))"

  if verify "$scratch" compare; then verified=1; fi
  t_verified="$(date +%s)"

  local rpo_ok=no rto_ok=no
  [ "$lag" -lt "$RPO_TARGET_S" ] && rpo_ok=yes
  [ "$verified" = 1 ] && [ $((t_verified - t_start)) -lt "$RTO_TARGET_S" ] && rto_ok=yes
  log "summary: recovery point $lag s behind (under $RPO_TARGET_S s: $rpo_ok); restored in $(mins $((t_avail - t_start))), verified in $(mins $((t_verified - t_start))) (under $(mins "$RTO_TARGET_S"): $rto_ok); verification $([ "$verified" = 1 ] && echo passed || echo FAILED)"

  delete_scratch "$scratch" || true
  trap - EXIT INT TERM HUP
  log "drill: done; log at $LOG"
  [ "$verified" = 1 ]
}

ENV=""
[ "${1:-}" = --env ] && [ -n "${2:-}" ] || { sed -n '2,25p' "$0"; exit 1; }
ENV="$2"; shift 2
STACK="$(stack_of "$ENV")"
load_stack "$STACK"
case "${1:-drill}" in
  drill)  [ $# -le 1 ] || die "usage: recovery-drill.sh --env production|staging [drill | verify <id> [--compare-production] | delete <id>]"; drill ;;
  verify) [ $# -ge 2 ] && [ $# -le 3 ] || die "usage: recovery-drill.sh --env production|staging verify <id> [--compare-production]"
          mode=""; [ $# -eq 3 ] && { [ "$3" = --compare-production ] || die "unknown option $3"; mode=compare; }
          not_production "$2"; exists "$2" || die "$2 not found"
          mkdir -p "$LOG_DIR"; LOG="$LOG_DIR/verify-$2-$(date -u +%Y%m%d-%H%M).log"; verify "$2" "$mode" ;;
  delete) [ $# -eq 2 ] || die "usage: recovery-drill.sh --env production|staging delete <id>"
          not_production "$2"; exists "$2" || die "$2 not found"; delete_scratch "$2" ;;
  vars)   printf 'DB=%q PARAM=%q SUBNETS=%q SGS=%q CLASS=%q STORAGE=%q RETENTION=%q INSTANCE=%q\n' \
            "$DB" "$PARAM" "$SUBNETS" "$SGS" "$CLASS" "$STORAGE" "$RETENTION" "$(out instance_id)" ;;
  *)      sed -n '2,25p' "$0"; exit 1 ;;
esac
