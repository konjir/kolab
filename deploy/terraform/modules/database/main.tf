# Kolab's database: managed Postgres on RDS (binding DAT1, Decisions Log D39), in private
# subnets, encrypted, with 7 days of automated backups. Kolab connects with TLS, verified
# against the RDS certificate bundle. Its URL, password included, is an SSM SecureString;
# it is also in Terraform state, like the admin token.
#
# Recovery (P12, D75; W2.24): the automated backups give point-in-time recovery to any second
# from the last 7 days up to the latest restorable time, which RDS keeps about 5 minutes behind
# now. Deletion protection is on, and deleting the instance keeps those backups (and a final
# snapshot) unless the teardown asks to leave nothing. deploy/RECOVERY.md is the runbook, and
# deploy/recovery-drill.sh the drill.

variable "name" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_id" { type = string }
variable "postgres_version" { type = string }
variable "instance_class" { type = string }
variable "allocated_gib" { type = number }
variable "final_snapshot" { type = bool }
variable "deletion_protection" { type = bool }

# Where the instance keeps the RDS certificate bundle; the kolab module's bootstrap downloads it.
locals {
  ca_path               = "/etc/konjir/rds-ca.pem"
  storage_type          = "gp3"
  backup_retention_days = 7
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = var.subnet_ids
}

resource "random_password" "db" {
  length  = 40
  special = false
}

# Each database's final snapshot gets a name of its own, so a second teardown doesn't collide with the first.
resource "random_id" "final_snapshot" {
  byte_length = 4
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV_AWS_157:One zone for a test environment; Multi-AZ is a production step (P10)
  #checkov:skip=CKV_AWS_118:Enhanced monitoring adds cost and no consumer reads it yet
  #checkov:skip=CKV_AWS_353:Performance Insights is a production step (P11)
  #checkov:skip=CKV_AWS_129:Log exports to CloudWatch are a production step (P11)
  #checkov:skip=CKV2_AWS_30:Query logging is a production step (P11)
  #checkov:skip=CKV_AWS_161:Kolab logs in with a password from SSM; IAM auth is a production step
  identifier                 = "${var.name}-db"
  engine                     = "postgres"
  engine_version             = var.postgres_version
  instance_class             = var.instance_class
  allocated_storage          = var.allocated_gib
  storage_type               = local.storage_type
  storage_encrypted          = true
  db_name                    = "kolab"
  username                   = "kolab"
  password                   = random_password.db.result
  db_subnet_group_name       = aws_db_subnet_group.this.name
  vpc_security_group_ids     = [var.security_group_id]
  publicly_accessible        = false
  multi_az                   = false
  backup_retention_period    = local.backup_retention_days
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  # Deletion protection is on unless db_deletion_protection is off, which a teardown applies
  # first (README). terraform destroy then keeps a final snapshot and the automated backups, so
  # the database can still be restored to a point in time, unless final_snapshot is off. Destroy
  # reads both from state, so turning them off takes an apply first too.
  deletion_protection       = var.deletion_protection
  delete_automated_backups  = !var.final_snapshot
  skip_final_snapshot       = !var.final_snapshot
  final_snapshot_identifier = "${var.name}-db-final-${random_id.final_snapshot.hex}"
  apply_immediately         = false
}

resource "aws_ssm_parameter" "database_url" {
  #checkov:skip=CKV_AWS_337:SecureString with the AWS-managed SSM key; a customer-managed key is a production step
  name        = "/konjir/${var.name}/database-url"
  description = "Kolab's Postgres URL, password included"
  type        = "SecureString"
  value = format(
    "postgres://kolab:%s@%s/kolab?sslmode=verify-full&sslrootcert=%s",
    random_password.db.result, aws_db_instance.this.endpoint, local.ca_path,
  )
}

output "database_url_param_name" { value = aws_ssm_parameter.database_url.name }
output "database_url_param_arn" { value = aws_ssm_parameter.database_url.arn }
output "endpoint" { value = aws_db_instance.this.endpoint }
output "identifier" { value = aws_db_instance.this.identifier }
output "ca_path" { value = local.ca_path }

# What a restore into a new instance needs (deploy/RECOVERY.md), from state, so it works when the
# instance itself is gone.
output "recovery" {
  value = {
    identifier            = aws_db_instance.this.identifier
    url_parameter         = aws_ssm_parameter.database_url.name
    subnet_group          = aws_db_subnet_group.this.name
    security_group        = var.security_group_id
    instance_class        = var.instance_class
    storage_type          = local.storage_type
    backup_retention_days = local.backup_retention_days
  }
}
