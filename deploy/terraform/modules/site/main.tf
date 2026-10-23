# konjir.com, the marketing site (D81): the konjir-site kolab's deployable copy in site/.
#  - a private, versioned, encrypted bucket that only this CloudFront distribution reads (OAC)
#  - CloudFront for konjir.com and www.konjir.com, www redirected to the apex by a CloudFront Function
#  - an ACM certificate in us-east-1, validated through the konjir.com zone
#  - security headers on every response, a strict CSP among them
#  - every file in site/ (README.md and dotfiles aside) uploaded with its content type and cache policy:
#    hashed files under assets/ cached a year as immutable, everything else a minute, so a deploy shows
#    within a minute and needs no invalidation

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

variable "name" { type = string }
variable "zone_id" { type = string }

variable "domain_name" {
  description = "The apex the site is served at; www.<domain_name> redirects to it."
  type        = string
}

variable "site_dir" {
  description = "The directory whose files are published."
  type        = string
}

locals {
  www = "www.${var.domain_name}"

  # The page loads nothing from another origin (deploy/site/from-artifact.mjs self-hosts fonts and
  # moves inline styles into the stylesheet), so everything is 'self'.
  csp = join("; ", [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ])

  files = toset([for f in fileset(var.site_dir, "**") : f if f != "README.md" && !startswith(basename(f), ".")])

  content_types = {
    css   = "text/css; charset=utf-8"
    html  = "text/html; charset=utf-8"
    ico   = "image/x-icon"
    jpeg  = "image/jpeg"
    jpg   = "image/jpeg"
    js    = "text/javascript; charset=utf-8"
    json  = "application/json"
    png   = "image/png"
    svg   = "image/svg+xml"
    txt   = "text/plain; charset=utf-8"
    webp  = "image/webp"
    woff2 = "font/woff2"
    xml   = "application/xml"
  }
}

# --- Bucket ---

resource "aws_s3_bucket" "site" {
  #checkov:skip=CKV_AWS_18:A static site rebuilt from the repository; CloudFront is the only reader
  #checkov:skip=CKV_AWS_144:The site is rebuildable from the repository; no replication
  #checkov:skip=CKV_AWS_145:SSE-S3 is sufficient for public web pages
  #checkov:skip=CKV2_AWS_62:Nothing consumes bucket events
  bucket_prefix = "${var.name}-site-"
  force_destroy = true # every object is a copy of a file in site/
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    id     = "expire-replaced-files"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

data "aws_iam_policy_document" "site" {
  statement {
    sid       = "CloudFrontReads"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket     = aws_s3_bucket.site.id
  policy     = data.aws_iam_policy_document.site.json
  depends_on = [aws_s3_bucket_public_access_block.site]
}

resource "aws_s3_object" "site" {
  for_each = local.files

  bucket        = aws_s3_bucket.site.id
  key           = each.value
  source        = "${var.site_dir}/${each.value}"
  etag          = filemd5("${var.site_dir}/${each.value}")
  content_type  = lookup(local.content_types, lower(reverse(split(".", each.value))[0]), "application/octet-stream")
  cache_control = startswith(each.value, "assets/") ? "public, max-age=31536000, immutable" : "public, max-age=60"

  depends_on = [aws_s3_bucket_server_side_encryption_configuration.site]
}

# --- Certificate ---

resource "aws_acm_certificate" "site" {
  provider                  = aws.us_east_1
  domain_name               = var.domain_name
  subject_alternative_names = [local.www]
  validation_method         = "DNS"

  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "validation" {
  for_each = {
    for o in aws_acm_certificate.site.domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  }

  zone_id         = var.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

# --- CloudFront ---

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-site"
  description                       = "${var.domain_name}: CloudFront reads the site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "www_redirect" {
  name    = "${var.name}-site-www-redirect"
  runtime = "cloudfront-js-2.0"
  comment = "301 from ${local.www} to ${var.domain_name}"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var host = request.headers.host ? request.headers.host.value : '';
      if (host !== '${local.www}') return request;
      var qs = [];
      for (var key in request.querystring) {
        var v = request.querystring[key];
        var all = v.multiValue ? v.multiValue : [v];
        for (var i = 0; i < all.length; i++) qs.push(all[i].value === '' ? key : key + '=' + all[i].value);
      }
      return {
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: { location: { value: 'https://${var.domain_name}' + request.uri + (qs.length ? '?' + qs.join('&') : '') } }
      };
    }
  EOT
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_response_headers_policy" "site" {
  name    = "${var.name}-site-security"
  comment = "${var.domain_name}: security headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_security_policy {
      content_security_policy = local.csp
      override                = true
    }
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=()"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  #checkov:skip=CKV_AWS_68:No WAF: a static site with nothing to attack behind it, and WAF would cost more than the site
  #checkov:skip=CKV_AWS_86:No access logging for a static marketing site
  #checkov:skip=CKV_AWS_310:One origin; nothing to fail over to
  #checkov:skip=CKV_AWS_374:Served worldwide
  #checkov:skip=CKV2_AWS_47:No WAF (see CKV_AWS_68)
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = var.domain_name
  aliases             = [var.domain_name, local.www]
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.www_redirect.arn
    }
  }

  # Without s3:ListBucket a missing key is a 403 from S3; both are the 404 page.
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# --- DNS ---

resource "aws_route53_record" "alias" {
  for_each = { for p in setproduct([var.domain_name, local.www], ["A", "AAAA"]) : "${p[0]} ${p[1]}" => { name = p[0], type = p[1] } }

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

output "url" { value = "https://${var.domain_name}" }
output "bucket" { value = aws_s3_bucket.site.id }
output "distribution_id" { value = aws_cloudfront_distribution.site.id }
output "distribution_domain" { value = aws_cloudfront_distribution.site.domain_name }
