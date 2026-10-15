# A small VPC with one public subnet. Only 443 (and 80 for certificate issuance) is open; no SSH.
# Two private subnets, in two zones as RDS requires, hold the database; only Kolab reaches it.

variable "name" { type = string }
variable "az" { type = string }

resource "aws_vpc" "this" {
  #checkov:skip=CKV2_AWS_11:Test environment; flow logs add cost and no consumer reads them yet
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "10.42.1.0/24"
  availability_zone       = var.az
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# The default security group of a new VPC allows all traffic between its members; lock it down.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_security_group" "web" {
  #checkov:skip=CKV2_AWS_5:Attached to the Kolab instance in the kolab module
  name        = "${var.name}-web"
  description = "HTTPS for Kolab and HTTP for certificate issuance only - no SSH"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-web" }
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.web.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  #checkov:skip=CKV_AWS_260:Let's Encrypt HTTP-01 needs port 80; Caddy only redirects it to HTTPS
  security_group_id = aws_security_group.web.id
  description       = "ACME HTTP-01 challenges and redirects to HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

# Outbound: package downloads (Node, Caddy, npm), AWS APIs (S3, SSM, Bedrock), Let's Encrypt.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.web.id
  description       = "Outbound HTTPS and DNS for installs and AWS APIs"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---- Database: private subnets in two zones, reachable on 5432 from Kolab only.
data "aws_availability_zones" "this" { state = "available" }

locals {
  db_azs = [var.az, [for z in data.aws_availability_zones.this.names : z if z != var.az][0]]
}

resource "aws_subnet" "db" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = "10.42.${11 + count.index}.0/24"
  availability_zone = local.db_azs[count.index]
  tags              = { Name = "${var.name}-db-${count.index}" }
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres from Kolab only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_kolab" {
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from the Kolab instance"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.web.id
}

output "subnet_id" { value = aws_subnet.public.id }
output "db_subnet_ids" { value = aws_subnet.db[*].id }
output "db_security_group_id" { value = aws_security_group.db.id }
output "security_group_id" { value = aws_security_group.web.id }
output "vpc_id" { value = aws_vpc.this.id }
