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

variable "github_oauth_client_id" {
  description = "Client id of the GitHub OAuth app people sign in with (D55). Its callback URL is https://<domain_name>/oauth/callback/github. Empty: no GitHub sign-in."
  type        = string
  default     = ""
}

variable "github_oauth_client_secret" {
  description = "Client secret of that GitHub OAuth app, stored as an SSM SecureString (and in Terraform state, as the admin token is). Set it with the client id, e.g. TF_VAR_github_oauth_client_secret, never in a committed file."
  type        = string
  default     = ""
  sensitive   = true
}
