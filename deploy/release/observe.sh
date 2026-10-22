#!/bin/bash
# Ships Kolab's logs to CloudWatch Logs (P11, D68): install.sh runs it as root on the instance, with
# every release, so setting it up or changing it is a plain terraform apply, never a new boot
# script or a new instance. Idempotent: a release that changes nothing here changes nothing.
#
# - Installs the CloudWatch agent (amazon-cloudwatch-agent, from Amazon Linux's own repository)
#   and logrotate, if they aren't installed.
# - The agent reads files, not the journal, so konjir-journal@<unit> copies the journal of each of
#   konjir.service and caddy.service, systemd's own lines about the unit included ("Main process
#   exited", "Stopped"), to /var/log/konjir/<unit>.log, from where it stopped (a cursor file), and
#   logrotate keeps the copies small.
# - The agent ships them to the log group /konjir/<name>, as the streams konjir and caddy, and puts
#   memory and root-disk use in the namespace Konjir/<name>: what deploy/terraform/modules/monitoring
#   creates, and all modules/iam lets the instance write. <name> is read from /etc/konjir/env, as
#   start.sh reads it.
#
# A failure fails the release, so Kolab keeps running the one before it and terraform apply says
# so: shipped logs are what the alarms count.
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
install -d -m 0700 /var/lib/konjir-journal
unit_changed=0
put /etc/systemd/system/konjir-journal@.service "[Unit]
Description=Copies the journal of %i.service to /var/log/konjir/%i.log, for the CloudWatch agent
After=systemd-journald.service
[Service]
ExecStart=/bin/sh -c 'exec /usr/bin/journalctl --follow --no-pager --output=cat --unit=%i.service --cursor-file=/var/lib/konjir-journal/%i.cursor >> /var/log/konjir/%i.log'
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target" && unit_changed=1
put /etc/logrotate.d/konjir-journal "/var/log/konjir/*.log {
  daily
  maxsize 100M
  rotate 2
  missingok
  notifempty
  copytruncate
  nocompress
}" || true
systemctl daemon-reload
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
