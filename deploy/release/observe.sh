#!/bin/bash
# Ships Kolab's logs to CloudWatch Logs (P11, D68): install.sh runs it as root on the instance, with
# every release, so setting it up or changing it is a plain terraform apply, never a new boot
# script or a new instance. Idempotent: a release that changes nothing here changes nothing.
#
# - Installs the CloudWatch agent (amazon-cloudwatch-agent, from Amazon Linux's own repository)
#   logrotate and python3 (Amazon Linux has it), if they aren't installed.
# - The agent reads files, not the journal, so konjir-journal@<unit> (journal-copy.py, beside this
#   script) copies the journal of each of konjir.service and caddy.service, systemd's own lines
#   about the unit included ("Main process exited", "Stopped"), to /var/log/konjir/<unit>.log. It
#   starts from now, never replaying older lines, and reads lines of any length (--all); masks
#   tokens, passwords, query secrets and secret fields, Caddy's lines included, before anything
#   leaves the instance, and caps each line at 16 KiB; marks each line with the journal's trusted
#   unit and PID, which the metric filters match; and every 5 minutes writes a probe into the
#   unit's journal and a heartbeat saying how long ago it last read a journal line, which the
#   no-logs alarm checks is fresh.
# - konjir-journal-rotate.timer rotates the copies every 10 minutes once one passes 50 MB, so a
#   log flood can't fill the root disk between the daily logrotate runs; the disk alarm watches it.
# - The agent ships them to the log group /konjir/<name>, as the streams konjir and caddy, and puts
#   memory and root-disk use in the namespace Konjir/<name>: what deploy/terraform/modules/monitoring
#   creates, and all modules/iam lets the instance write. <name> is read from /etc/konjir/env, as
#   start.sh reads it.
#
# It exits non-zero on a failure, but install.sh only warns: shipping logs must never stop a
# release or a new instance's first boot. The no-logs alarm says when nothing is shipping.
set -euo pipefail

ENV=/etc/konjir/env
if [ ! -f "$ENV" ] || [ "$(id -u)" -ne 0 ]; then
  echo "observe.sh: not on a Kolab instance as root; nothing to set up"; exit 0
fi
TOKEN_PARAM=$(sed -n 's/^KONJIR_TOKEN_PARAM=//p' "$ENV")
case "$TOKEN_PARAM" in
  /konjir/?*/admin-token) NAME=${TOKEN_PARAM#/konjir/}; NAME=${NAME%/admin-token} ;;
  *) echo "observe.sh: KONJIR_TOKEN_PARAM in $ENV isn't /konjir/<name>/admin-token" >&2; exit 1 ;;
esac
LOG_GROUP="/konjir/$NAME"
NAMESPACE="Konjir/$NAME"
CTL=/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl
CONFIG=/opt/aws/amazon-cloudwatch-agent/etc/konjir.json
UNITS="konjir caddy"

# ---- Packages
missing=""
rpm -q amazon-cloudwatch-agent >/dev/null 2>&1 || missing="$missing amazon-cloudwatch-agent"
rpm -q logrotate >/dev/null 2>&1 || missing="$missing logrotate"
rpm -q python3 >/dev/null 2>&1 || missing="$missing python3"
# shellcheck disable=SC2086 # one word per package
[ -z "$missing" ] || dnf install -y -q $missing

# Writes $2 to $1 if it differs; says whether it did (exit 0: changed).
put() {
  local tmp; tmp=$(mktemp)
  printf '%s\n' "$2" > "$tmp"
  if cmp -s "$tmp" "$1"; then rm -f "$tmp"; return 1; fi
  install -m 0644 "$tmp" "$1"; rm -f "$tmp"; return 0
}

# ---- The journal's copies
install -d -m 0750 /var/log/konjir
rm -rf /var/lib/konjir-journal   # the cursor files of an earlier copy, which replayed old lines
unit_changed=0
put /usr/local/libexec/konjir-journal-copy "$(cat "$(dirname "$0")/journal-copy.py")" && unit_changed=1
chmod 0755 /usr/local/libexec/konjir-journal-copy
put /etc/systemd/system/konjir-journal@.service "[Unit]
Description=Copies the journal of %i.service, masked, to /var/log/konjir/%i.log, for the CloudWatch agent
After=systemd-journald.service
[Service]
ExecStart=/usr/bin/python3 /usr/local/libexec/konjir-journal-copy %i /var/log/konjir/%i.log
Restart=always
RestartSec=5
ProtectSystem=strict
ReadWritePaths=/var/log/konjir
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target" && unit_changed=1
put /etc/logrotate.d/konjir-journal "/var/log/konjir/*.log {
  size 50M
  rotate 2
  missingok
  notifempty
  copytruncate
  nocompress
  nodateext
}" || true
put /etc/systemd/system/konjir-journal-rotate.service "[Unit]
Description=Rotates the journal copies in /var/log/konjir once one passes 50 MB
[Service]
Type=oneshot
ExecStart=/usr/sbin/logrotate --state /var/lib/logrotate/konjir-journal.status /etc/logrotate.d/konjir-journal" || true
put /etc/systemd/system/konjir-journal-rotate.timer "[Unit]
Description=Rotates the journal copies in /var/log/konjir every 10 minutes
[Timer]
OnCalendar=*:0/10
AccuracySec=1min
[Install]
WantedBy=timers.target" || true
install -d -m 0755 /var/lib/logrotate
systemctl daemon-reload
systemctl enable -q --now logrotate.timer konjir-journal-rotate.timer
for u in $UNITS; do
  systemctl enable -q "konjir-journal@$u.service"
  if [ "$unit_changed" = 1 ]; then systemctl restart "konjir-journal@$u.service"; else systemctl start "konjir-journal@$u.service"; fi
done

# ---- The agent
STREAMS=""
for u in $UNITS; do
  STREAMS="$STREAMS${STREAMS:+,}
          { \"file_path\": \"/var/log/konjir/$u.log\", \"log_group_name\": \"$LOG_GROUP\", \"log_stream_name\": \"$u\" }"
done
if put "$CONFIG" "{
  \"agent\": { \"metrics_collection_interval\": 60, \"run_as_user\": \"root\" },
  \"logs\": {
    \"force_flush_interval\": 5,
    \"logs_collected\": {
      \"files\": {
        \"collect_list\": [$STREAMS
        ]
      }
    }
  },
  \"metrics\": {
    \"namespace\": \"$NAMESPACE\",
    \"append_dimensions\": { \"InstanceId\": \"\${aws:InstanceId}\" },
    \"metrics_collected\": {
      \"mem\": { \"measurement\": [\"mem_used_percent\"] },
      \"disk\": { \"measurement\": [\"used_percent\"], \"resources\": [\"/\"], \"drop_device\": true }
    }
  }
}" || ! systemctl is-active -q amazon-cloudwatch-agent; then
  "$CTL" -a fetch-config -m ec2 -s -c "file:$CONFIG" >/dev/null
fi
systemctl is-active -q amazon-cloudwatch-agent || { echo "observe.sh: the CloudWatch agent isn't running" >&2; exit 1; }
echo "observe.sh: shipping the journal of $UNITS to CloudWatch Logs $LOG_GROUP"
