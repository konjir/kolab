variable "aws_profile" {
  description = "AWS CLI profile used for every resource."
  type        = string
  default     = "icedlee337"
}

variable "region" {
  description = "Region for Kolab (and the Bedrock review model)."
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
  description = "Snapshot the data volume when it is destroyed. Set false for a teardown that leaves nothing behind."
  type        = bool
  default     = true
}

variable "review_mode" {
  description = "structural (no model calls) or bedrock (semantic review on review_model)."
  type        = string
  default     = "structural"
  validation {
    condition     = contains(["structural", "bedrock"], var.review_mode)
    error_message = "review_mode must be structural or bedrock."
  }
}

variable "review_model" {
  description = "Bedrock model for the review gate."
  type        = string
  default     = "anthropic.claude-haiku-5-5"
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
