# Ships the Konjir code: pack the tracked files of the checkout's commit, upload them, and run the
# installer on Kolab through Systems Manager. deploy/release/pack.sh packs it with `git archive`,
# so nothing untracked or ignored can ship (.env, .claude/, .konjir/, *.tfvars), it refuses a
# checkout with uncommitted tracked changes, so a deploy is exactly a commit, and the release id
# is the commit's tree id, which changes only when tracked content does. A new id updates the
# association and re-runs the install. `terraform apply` is the deploy.

variable "name" { type = string }
variable "source_dir" { type = string }
variable "artifact_bucket" { type = string }
variable "instance_id" { type = string }
variable "domain_name" { type = string }

data "external" "app" {
  program = ["bash", "${path.module}/../../../release/pack.sh", var.source_dir, abspath("${path.root}/.build/konjir-release.zip")]
}

resource "aws_s3_object" "release" {
  bucket      = var.artifact_bucket
  key         = "releases/current.zip"
  source      = data.external.app.result.path
  source_hash = data.external.app.result.release
}

resource "aws_ssm_association" "install" {
  name             = "AWS-RunShellScript"
  association_name = "${var.name}-install-release"

  targets {
    key    = "InstanceIds"
    values = [var.instance_id]
  }

  parameters = {
    # The release hash in the comment is what makes a code change re-run this association.
    commands         = "cloud-init status --wait >/dev/null || true; /usr/local/bin/konjir-update  # release ${data.external.app.result.release}"
    executionTimeout = "1800"
  }

  # Block the apply until the install has succeeded on the instance (first boot included).
  wait_for_success_timeout_seconds = 1800

  depends_on = [aws_s3_object.release]
}

# After apply: is Kolab answering over HTTPS? A warning, not a failure, because DNS and the
# first certificate can take a few minutes after a fresh deploy.
check "kolab_is_live" {
  data "http" "health" {
    url = "https://${var.domain_name}/healthz"
    retry {
      attempts     = 10
      min_delay_ms = 5000
      max_delay_ms = 15000
    }
  }
  assert {
    condition     = data.http.health.status_code == 200
    error_message = "https://${var.domain_name}/healthz is not answering yet. Give DNS and the certificate a few minutes, then run deploy/konjir-ops.sh status."
  }
}

output "release" { value = data.external.app.result.release }
