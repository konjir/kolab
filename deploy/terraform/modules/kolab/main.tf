# The Kolab instance, its data volume attachment, a stable public address and its DNS name.
#
# The instance holds no state of its own: the database is on the storage module's volume.
# That makes replacement safe, so a change to the boot script replaces the instance.
# The AMI is pinned at creation; refresh the OS with
#   terraform apply -replace=module.kolab.aws_instance.kolab

variable "name" { type = string }
variable "instance_type" { type = string }
variable "subnet_id" { type = string }
variable "security_group_id" { type = string }
variable "instance_profile_name" { type = string }
variable "data_volume_id" { type = string }
variable "artifact_bucket" { type = string }
variable "admin_token_param_name" { type = string }
variable "database_url_param_name" { type = string }
variable "database_ca_path" { type = string }
variable "domain_name" { type = string }
variable "zone_id" { type = string }
variable "letsencrypt_email" { type = string }

variable "node_version" {
  type    = string
  default = "22.23.3"
}
variable "caddy_version" {
  type    = string
  default = "2.11.7"
}

data "aws_region" "current" {}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "kolab" {
  #checkov:skip=CKV_AWS_126:Basic 5-minute monitoring is enough for a test server
  ami                         = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [var.security_group_id]
  iam_instance_profile        = var.instance_profile_name
  associate_public_ip_address = false # the Elastic IP below is the public address
  user_data_replace_on_change = true
  monitoring                  = false
  ebs_optimized               = true

  user_data = templatefile("${path.module}/userdata.sh.tftpl", {
    domain         = var.domain_name
    bucket         = var.artifact_bucket
    region         = data.aws_region.current.region
    token_param    = var.admin_token_param_name
    database_param = var.database_url_param_name
    database_ca    = var.database_ca_path
    data_volume_id = var.data_volume_id
    # Retired with the Bedrock reviewer (W1.7, REV5): Kolab makes no model calls and ignores
    # KONJIR_REVIEW and KONJIR_REVIEW_MODEL. The boot script still writes them, with the values
    # the instance was created with, only so that it renders unchanged: a changed boot script
    # replaces the instance. Remove them, and these two lines, with the next change that does.
    review_mode   = "structural"
    review_model  = "anthropic.claude-haiku-5-5"
    caddy_email   = var.letsencrypt_email == "" ? "" : "email ${var.letsencrypt_email}"
    node_version  = var.node_version
    caddy_version = var.caddy_version
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size           = 16
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  tags = { Name = "${var.name}-kolab" }

  lifecycle {
    # The AMI is pinned at creation (README: OS refresh). With the Elastic IP associated, AWS reports
    # associate_public_ip_address as true; without this, every apply would replace the instance.
    ignore_changes = [ami, associate_public_ip_address]
  }
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = var.data_volume_id
  instance_id                    = aws_instance.kolab.id
  stop_instance_before_detaching = true # clean unmount of the database volume on replacement
}

resource "aws_eip" "kolab" {
  domain = "vpc"
  tags   = { Name = "${var.name}-kolab" }
}

resource "aws_eip_association" "kolab" {
  instance_id   = aws_instance.kolab.id
  allocation_id = aws_eip.kolab.id
}

resource "aws_route53_record" "kolab" {
  zone_id = var.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 300
  records = [aws_eip.kolab.public_ip]
}

output "instance_id" { value = aws_instance.kolab.id }
output "public_ip" { value = aws_eip.kolab.public_ip }

# Renamed from "hub" on 2026-10-11 (Decisions Log D11). Keeps the Elastic IP and the rest in place.
moved {
  from = aws_instance.hub
  to   = aws_instance.kolab
}
moved {
  from = aws_eip.hub
  to   = aws_eip.kolab
}
moved {
  from = aws_eip_association.hub
  to   = aws_eip_association.kolab
}
moved {
  from = aws_route53_record.hub
  to   = aws_route53_record.kolab
}
