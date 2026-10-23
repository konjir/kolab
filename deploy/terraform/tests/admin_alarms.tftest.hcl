# The alarms on Konjir's admins (W2.22, Lee's ruling of 2026-10-23), planned against a mock AWS
# provider: each counts one of Kolab's own log lines by its event, and emails the alarm topic when it
# fires and when it recovers, as break-glass-used does. apps/cli/test/admins.test.ts checks that
# Kolab logs each event these filters match.
mock_provider "aws" {
  override_data {
    target = data.aws_region.current
    values = { region = "us-east-1" }
  }
}

run "admin_alarms" {
  command = plan

  module {
    source = "./modules/monitoring"
  }

  variables {
    name                   = "konjir-test"
    domain_name            = "kolab.example.com"
    db_instance_identifier = "konjir-test-db"
    alarm_email            = "ops@example.com"
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.break_glass.pattern == "{ $.event = \"break_glass_used\" && $._SYSTEMD_UNIT = \"konjir.service\" }"
    error_message = "break-glass-used counts Kolab's break_glass_used lines"
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.admin_granted.pattern == "{ $.event = \"admin_granted\" && $._SYSTEMD_UNIT = \"konjir.service\" }"
    error_message = "admin-granted counts Kolab's admin_granted lines"
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.admin_elevated.pattern == "{ $.event = \"admin_elevated\" && $._SYSTEMD_UNIT = \"konjir.service\" }"
    error_message = "admin-session-raised counts Kolab's admin_elevated lines"
  }
  assert {
    condition = alltrue([for a in [aws_cloudwatch_metric_alarm.admin_granted, aws_cloudwatch_metric_alarm.admin_elevated] :
      a.threshold == 1 && a.evaluation_periods == 1 && a.comparison_operator == "GreaterThanOrEqualToThreshold" && a.treat_missing_data == "notBreaching"
    ])
    error_message = "one admin made or one session raised is enough to fire, as one break-glass use is"
  }
  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.admin_granted.metric_name == one(aws_cloudwatch_log_metric_filter.admin_granted.metric_transformation).name,
      aws_cloudwatch_metric_alarm.admin_elevated.metric_name == one(aws_cloudwatch_log_metric_filter.admin_elevated.metric_transformation).name,
    ])
    error_message = "each alarm watches its own filter's metric"
  }
  assert {
    condition     = length(setsubtract(["konjir-test-admin-granted", "konjir-test-admin-session-raised", "konjir-test-break-glass-used"], output.alarm_names)) == 0
    error_message = "deploy/konjir-ops.sh alarms lists the admin alarms"
  }
}
