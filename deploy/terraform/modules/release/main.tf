# Ships the Konjir code: zip the source tree, upload it, and run the installer on Kolab
# through Systems Manager. Any change to the code changes the zip's hash, which updates the
# association and re-runs the install. `terraform apply` is the deploy.

variable "name" { type = string }
variable "source_dir" { type = string }
variable "artifact_bucket" { type = string }
variable "instance_id" { type = string }
variable "domain_name" { type = string }

data "archive_file" "app" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.root}/.build/konjir-release.zip"
  excludes = [
    "node_modules",
    ".konjir",
    ".git",
    "deploy/terraform/.terraform",
    "deploy/terraform/.build",
    "deploy/terraform/terraform.tfstate",
    "deploy/terraform/terraform.tfstate.backup",
    "deploy/terraform/.terraform.lock.hcl",
  ]
}

resource "aws_s3_object" "release" {
  bucket      = var.artifact_bucket
  key         = "releases/current.zip"
  source      = data.archive_file.app.output_path
  source_hash = data.archive_file.app.output_md5
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
    commands         = "cloud-init status --wait >/dev/null || true; /usr/local/bin/konjir-update  # release ${data.archive_file.app.output_md5}"
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

output "release_md5" { value = data.archive_file.app.output_md5 }
