variable "aws_profile" {
  description = "AWS CLI profile used for every resource."
  type        = string
  default     = "icedlee337"
}

variable "region" {
  description = "Region for Kolab."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name prefix for every resource; also the tag that groups them."
  type        = string
  default     = "konjir-test"
}

variable "zone_name" {
  description = "Route 53 hosted zone that already exists in the account."
  type        = string
  default     = "konjir.com"
}

variable "domain_name" {
  description = "Public hostname for Kolab. Must be inside zone_name."
  type        = string
  default     = "kolab.konjir.com"
}

variable "availability_zone" {
  description = "Zone for the instance and its data volume. Never change it after the first apply: the volume can't move zones."
  type        = string
  default     = "us-east-1a"
}

variable "instance_type" {
  description = "Graviton instance for Kolab."
  type        = string
  default     = "t4g.small"
}

variable "data_volume_gib" {
  description = "Size of Kolab's data volume."
  type        = number
  default     = 20
}

variable "final_snapshot_on_destroy" {
  description = "Snapshot the data volume and the database when they are destroyed. Set false for a teardown that leaves nothing behind."
  type        = bool
  default     = true
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
  description = "RDS instance class for Kolab's database."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_gib" {
  description = "Storage for Kolab's database."
  type        = number
  default     = 20
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

variable "github_oauth_client_id" {
  description = "Client id of the GitHub OAuth app people sign in with (D55); it is public. Its callback URL is https://<domain_name>/oauth/callback/github. Its secret is never Terraform's: put it with aws ssm put-parameter (README). Empty: no GitHub sign-in."
  type        = string
  default     = "Ov23licO2Gy9ngM4tgPE"
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
