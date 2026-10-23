variable "aws_profile" {
  description = "AWS CLI profile used for every resource. Null: the environment's credentials, AWS_PROFILE on Lee's machine (deploy/konjir-ops.sh sets icedlee337) and the OIDC role's in CI."
  type        = string
  default     = null
}

variable "region" {
  description = "Region for Kolab."
  type        = string
  default     = "us-east-1"
}

variable "zone_name" {
  description = "Route 53 hosted zone that already exists in the account."
  type        = string
  default     = "konjir.com"
}

variable "availability_zone" {
  description = "Zone for the instance and its data volume. Never change it after the first apply: the volume can't move zones."
  type        = string
  default     = "us-east-1a"
}

variable "instance_type" {
  description = "Graviton instance for Kolab. Null: the environment's (environments.tf)."
  type        = string
  default     = null
}

variable "data_volume_gib" {
  description = "Size of Kolab's data volume. Null: the environment's."
  type        = number
  default     = null
}

variable "final_snapshot_on_destroy" {
  description = "Snapshot the data volume and the database when they are destroyed. Set false for a teardown that leaves nothing behind. Null: the environment's (true for production, false for staging)."
  type        = bool
  default     = null
}

variable "letsencrypt_email" {
  description = "Optional contact address for certificate expiry notices."
  type        = string
  default     = ""
}

variable "app_source_dir" {
  description = "The Konjir source tree to ship. Defaults to this repository."
  type        = string
  default     = null
}

variable "postgres_version" {
  description = "Postgres major version on RDS. RDS picks the minor version and upgrades it automatically; a pinned minor would make the next apply try to downgrade."
  type        = string
  default     = "18"
}

variable "db_instance_class" {
  description = "RDS instance class for Kolab's database. Null: the environment's."
  type        = string
  default     = null
}

variable "db_allocated_gib" {
  description = "Storage for Kolab's database. Null: the environment's."
  type        = number
  default     = null
}

variable "db_deletion_protection" {
  description = "RDS deletion protection on Kolab's database (P12, D75). Turn it off with an apply before terraform destroy (README: Tear down)."
  type        = bool
  default     = true
}

variable "alarm_email" {
  description = "The operator's email address for alarms (P11, D68). Set: Terraform subscribes it to the alarm topic, and AWS emails it a link to confirm, once. Empty: no subscriber, and alarms email no one."
  type        = string
  default     = ""

  validation {
    condition     = var.alarm_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email is an email address, or empty."
  }
}

variable "cli_npm_spec" {
  description = "The published konjir CLI's npm spec, pinned to an exact version (konjir@X.Y.Z), that Kolab's web page shows in its npx commands (W3.7). Kept as the SSM parameter /konjir/<name>/cli-npm-spec, which start.sh reads when Kolab starts. Bump it after each CLI release (README). Empty: no parameter, and the page shows no npx commands."
  type        = string
  default     = "konjir@0.5.0"

  # The server's rule, isPinnedNpmSpec in apps/server/src/kolab-server.module.ts: Kolab refuses to start on anything else.
  validation {
    condition     = var.cli_npm_spec == "" || can(regex("^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*@(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$", var.cli_npm_spec))
    error_message = "cli_npm_spec is a package pinned to an exact version, such as konjir@1.2.3, or empty."
  }
}

variable "site_enabled" {
  description = "Serve the marketing site (site/) at the apex of zone_name and its www (D81). On by default: this stack, konjir-test, is production (staging was dropped, D83). Set it false only for a stack that mustn't own konjir.com, such as a throwaway copy in the same zone."
  type        = bool
  default     = true
}

# A release built before Terraform runs (W2.23, D76): .github/workflows/deploy.yml packs the commit
# once with deploy/release/pack.sh and hands both environments the same zip. Both null: Terraform
# runs pack.sh on app_source_dir itself, as a local apply always has.
variable "release_zip" {
  description = "Path to a release zip deploy/release/pack.sh wrote. Set with release_id, or neither."
  type        = string
  default     = null
}

variable "release_id" {
  description = "The release id pack.sh printed for release_zip: the commit's tree id."
  type        = string
  default     = null

  validation {
    condition     = var.release_id == null || can(regex("^[0-9a-f]{40}([0-9a-f]{24})?$", var.release_id))
    error_message = "release_id is a git tree id (40 or 64 hex characters)."
  }
  validation {
    condition     = (var.release_id == null) == (var.release_zip == null)
    error_message = "Set release_zip and release_id together, or neither."
  }
}
