# Ships the Konjir code: pack the tracked files of the checkout's commit, upload them, and run the
# installer on Kolab through Systems Manager. deploy/release/pack.sh packs it with `git archive`,
# so nothing untracked or ignored can ship (.env, .claude/, .konjir/, *.tfvars), it refuses a
# checkout with uncommitted tracked changes, so a deploy is exactly a commit, and the release id
# is the commit's tree id without site/ (konjir.com, D81, which the zip leaves out too), which
# changes only when Kolab's tracked content does: a site-only change is no new release. A new id updates the
# association and re-runs the install. `terraform apply` is the deploy.
#
# In CI (W2.23, D76) the release is built before Terraform runs: .github/workflows/deploy.yml runs
# pack.sh once on the commit and passes its zip and release id here (release_zip, release_id), so
# what was approved is exactly what installs. Without them, Terraform runs pack.sh itself.

variable "name" { type = string }
variable "source_dir" { type = string }
variable "artifact_bucket" { type = string }
variable "instance_id" { type = string }
variable "domain_name" { type = string }

variable "release_zip" {
  type    = string
  default = null
}
variable "release_id" {
  type    = string
  default = null
}

data "external" "app" {
  count   = var.release_zip == null ? 1 : 0
  program = ["bash", "${path.module}/../../../release/pack.sh", var.source_dir, abspath("${path.root}/.build/konjir-release.zip")]
}

locals {
  release = var.release_zip == null ? data.external.app[0].result : { path = var.release_zip, release = var.release_id }
}

resource "aws_s3_object" "release" {
  bucket      = var.artifact_bucket
  key         = "releases/current.zip"
  source      = local.release.path
  source_hash = local.release.release
}

# The install runs the SSM document deploy/terraform/github-oidc makes, <name>-install-release
# (W2.23): cloud-init's wait, then the boot script's konjir-update, with the release id as its one
# parameter, hex only. The deploy role may associate no other document, so it can run nothing else
# on the instance. Lee applies github-oidc before this (README: Setting it up, once).
resource "aws_ssm_association" "install" {
  name             = "${var.name}-install-release"
  association_name = "${var.name}-install-release"

  targets {
    key    = "InstanceIds"
    values = [var.instance_id]
  }

  parameters = {
    # A new release id is what makes a code change re-run this association.
    release = local.release.release
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

output "release" { value = local.release.release }
output "install" {
  value = { document = aws_ssm_association.install.name, parameters = aws_ssm_association.install.parameters }
}
