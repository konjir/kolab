# Failures noticed before users report them (P11, D68; W2.19): Kolab's logs in CloudWatch Logs,
# and alarms that email the operator through SNS.
#
# - Logs: the log group /konjir/<name>, kept 30 days. The release's deploy/release/observe.sh
#   installs the CloudWatch agent on the instance and ships the journal of konjir.service and
#   caddy.service into it, as the streams `konjir` and `caddy`: Kolab's own lines are JSON, one
#   object per line, and systemd's lines about each unit are beside them as plain text. Nothing here
#   touches the boot script, so nothing replaces the instance.
# - Alarms: /healthz (a Route 53 health check), Kolab or Caddy exiting, a dead outbox job, a spike
#   in error lines, and RDS CPU and free storage. Each emails the SNS topic when it fires and when it
#   recovers. README: "Alarms" says what each means and what to do.

variable "name" { type = string }
variable "domain_name" { type = string }
variable "db_instance_identifier" { type = string }

variable "alarm_email" {
  description = "The operator's email address. Empty: the topic has no subscriber, and alarms email no one."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "server_error_threshold" {
  description = "Error-level lines in 5 minutes that count as a spike."
  type        = number
  default     = 10
}

variable "db_cpu_percent" {
  type    = number
  default = 80
}

variable "db_free_storage_gib" {
  type    = number
  default = 2
}

data "aws_region" "current" {}

locals {
  log_group = "/konjir/${var.name}"
  # The agent's metrics and the log metric filters' share one namespace, the only one the
  # instance role may write to (modules/iam).
  namespace = "Konjir/${var.name}"
  topic     = [aws_sns_topic.alarms.arn]
}

# ---- Logs

resource "aws_cloudwatch_log_group" "kolab" {
  #checkov:skip=CKV_AWS_158:Logs are masked of tokens at the source; a customer-managed key is a production step
  #checkov:skip=CKV_AWS_338:30 days is enough for a test server (D68)
  name              = local.log_group
  retention_in_days = var.log_retention_days
}

# ---- Where alarms go

resource "aws_sns_topic" "alarms" {
  #checkov:skip=CKV_AWS_26:Alarm notices carry no secrets; an encrypted topic needs a key policy CloudWatch can use, a production step
  name = "${var.name}-alarms"
}

# Email subscriptions wait for the address to confirm: AWS sends a link, which Lee follows once.
resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# ---- /healthz, from outside: a Route 53 health check (cheaper than a Synthetics canary)

resource "aws_route53_health_check" "healthz" {
  fqdn              = var.domain_name
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  enable_sni        = true
  request_interval  = 30
  failure_threshold = 3
  # Three regions, the fewest Route 53 allows, so the checkers add as few requests as they can.
  regions = ["us-east-1", "us-west-2", "eu-west-1"]
  tags    = { Name = "${var.name}-healthz" }
}

resource "aws_cloudwatch_metric_alarm" "healthz" {
  alarm_name        = "${var.name}-healthz-failing"
  alarm_description = "https://${var.domain_name}/healthz has failed for 2 minutes: Kolab is down, or can't reach its database, or Caddy or DNS is broken. Run deploy/konjir-ops.sh status, then logs; see README, Alarms."
  namespace         = "AWS/Route53"
  metric_name       = "HealthCheckStatus"
  dimensions        = { HealthCheckId = aws_route53_health_check.healthz.id }
  statistic         = "Minimum"
  period            = 60
  # Route 53 already waits for 3 failed checks, 30 s apart, before it reports a failure.
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  # No status at all is as bad as a failing one.
  treat_missing_data = "breaching"
  alarm_actions      = local.topic
  ok_actions         = local.topic

  lifecycle {
    precondition {
      condition     = data.aws_region.current.region == "us-east-1"
      error_message = "Route 53 health check metrics are only in us-east-1; the healthz alarm needs a us-east-1 provider in any other region."
    }
  }
}

# ---- From the logs

# systemd logs "<unit>: Main process exited, code=…, status=…" only when a service's process ends
# with a failure (a crash, a kill, a failed start); a stop or restart for a deploy exits cleanly and
# logs nothing like it. Kolab restarts itself 3 s later (Restart=always), so this is the alarm for
# a service that is restarting, and /healthz's is the one for a service that stays down.
resource "aws_cloudwatch_log_metric_filter" "service_exits" {
  for_each       = toset(["konjir", "caddy"])
  name           = "${var.name}-${each.key}-exited"
  log_group_name = aws_cloudwatch_log_group.kolab.name
  pattern        = "\"${each.key}.service: Main process exited\""
  metric_transformation {
    name      = "ServiceExits"
    namespace = local.namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "service_exits" {
  alarm_name          = "${var.name}-service-exited"
  alarm_description   = "Kolab (konjir.service) or Caddy exited with a failure and systemd is restarting it. Read why with deploy/konjir-ops.sh logs, or CloudWatch Logs ${local.log_group} (streams konjir and caddy); see README, Alarms."
  namespace           = local.namespace
  metric_name         = "ServiceExits"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.topic
  ok_actions          = local.topic
  depends_on          = [aws_cloudwatch_log_metric_filter.service_exits]
}

# Kolab logs one line, at error level, with "event":"outbox_job_dead", when an outbox job dies
# after its tenth failed attempt (libs/engine, Kolab.fail).
resource "aws_cloudwatch_log_metric_filter" "outbox_dead" {
  name           = "${var.name}-outbox-job-dead"
  log_group_name = aws_cloudwatch_log_group.kolab.name
  pattern        = "{ $.event = \"outbox_job_dead\" }"
  metric_transformation {
    name      = "OutboxJobsDead"
    namespace = local.namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "outbox_dead" {
  alarm_name          = "${var.name}-outbox-job-dead"
  alarm_description   = "An outbox job died after 10 failed attempts: its cascade or rebase, and any later cascade of its node, waits. List them with konjir admin_outbox state=dead, read last_error, fix the cause, then konjir admin_outbox retry=<id>; see README, Alarms."
  namespace           = local.namespace
  metric_name         = "OutboxJobsDead"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.topic
  ok_actions          = local.topic
  depends_on          = [aws_cloudwatch_log_metric_filter.outbox_dead]
}

# Every error-level JSON line: Kolab's (each 5xx answer is one, event http_5xx) and Caddy's (a 502
# when Kolab doesn't answer, say). Lines that aren't JSON never match.
resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "${var.name}-error-lines"
  log_group_name = aws_cloudwatch_log_group.kolab.name
  pattern        = "{ $.level = \"error\" }"
  metric_transformation {
    name      = "ErrorLines"
    namespace = local.namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${var.name}-server-errors"
  alarm_description   = "At least ${var.server_error_threshold} error-level lines from Kolab or Caddy in 5 minutes (5xx answers among them). In CloudWatch Logs ${local.log_group}, filter { $.level = \"error\" } to see which; see README, Alarms."
  namespace           = local.namespace
  metric_name         = "ErrorLines"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.server_error_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.topic
  ok_actions          = local.topic
  depends_on          = [aws_cloudwatch_log_metric_filter.errors]
}

# ---- The database

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-rds-cpu-high"
  alarm_description   = "Kolab's database has averaged over ${var.db_cpu_percent}% CPU for 15 minutes. Look in the logs for a runaway cascade or rebase storm; a db.t4g.micro out of CPU credits (CPUCreditBalance) is throttled. Consider a bigger db_instance_class; see README, Alarms."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.db_instance_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.db_cpu_percent
  treat_missing_data  = "missing"
  alarm_actions       = local.topic
  ok_actions          = local.topic
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${var.name}-rds-storage-low"
  alarm_description   = "Kolab's database has under ${var.db_free_storage_gib} GiB free. Raise db_allocated_gib and terraform apply (RDS grows storage in place), before writes start failing; see README, Alarms."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.db_instance_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = var.db_free_storage_gib * 1024 * 1024 * 1024
  treat_missing_data  = "missing"
  alarm_actions       = local.topic
  ok_actions          = local.topic
}

output "log_group_name" { value = aws_cloudwatch_log_group.kolab.name }
output "log_group_arn" { value = aws_cloudwatch_log_group.kolab.arn }
output "metrics_namespace" { value = local.namespace }
output "alarm_topic_arn" { value = aws_sns_topic.alarms.arn }
output "alarm_names" {
  value = concat(
    [aws_cloudwatch_metric_alarm.healthz.alarm_name, aws_cloudwatch_metric_alarm.service_exits.alarm_name],
    [aws_cloudwatch_metric_alarm.outbox_dead.alarm_name, aws_cloudwatch_metric_alarm.errors.alarm_name],
    [aws_cloudwatch_metric_alarm.db_cpu.alarm_name, aws_cloudwatch_metric_alarm.db_storage.alarm_name],
  )
}
