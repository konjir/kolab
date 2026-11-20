# The site module publishes what deploy/site/build.mjs builds in site/, and nothing else: not the
# page's source in site/src/ (D92), not site/README.md, not a dotfile. Planned against mocked
# providers, on the repository's own site/, through the fixture in tests/site/.
mock_provider "aws" {}
mock_provider "aws" {
  alias = "us_east_1"
  # The validation records are keyed by the certificate's names, which a plan otherwise can't know,
  # and CloudFront checks the validated certificate's ARN.
  override_resource {
    target          = module.site.aws_acm_certificate.site
    override_during = plan
    values = {
      arn = "arn:aws:acm:us-east-1:747533038441:certificate/mock"
      domain_validation_options = [
        { domain_name = "konjir.com", resource_record_name = "_a.konjir.com.", resource_record_type = "CNAME", resource_record_value = "_a.acm-validations.aws." },
        { domain_name = "www.konjir.com", resource_record_name = "_b.www.konjir.com.", resource_record_type = "CNAME", resource_record_value = "_b.acm-validations.aws." },
      ]
    }
  }
}

run "site_publishes_only_the_build" {
  command = plan

  module {
    source = "./tests/site"
  }

  assert {
    condition     = length(fileset(var.site_dir, "src/**")) > 0
    error_message = "site/src/ holds the page's source, so there is something to keep out"
  }
  assert {
    condition     = length([for f in output.files : f if startswith(f, "src/")]) == 0
    error_message = "nothing under site/src/ is uploaded"
  }
  assert {
    condition     = !contains(output.files, "README.md") && length([for f in output.files : f if startswith(basename(f), ".")]) == 0
    error_message = "site/README.md and dotfiles aren't uploaded"
  }
  assert {
    condition     = alltrue([for f in ["index.html", "404.html", "kolab/index.html", "kolab/hands-on/index.html", "konnect/index.html", "konnect/guide/index.html", "robots.txt", "sitemap.xml", "favicon.svg", "og/www.jpg"] : contains(output.files, f)])
    error_message = "the built pages are uploaded, each product's section included, with the sitemap and the Open Graph image"
  }
  assert {
    condition     = alltrue([for f in ["index.html", "404.html", "kolab/index.html", "kolab/hands-on/index.html", "konnect/index.html", "konnect/guide/index.html"] : output.objects[f].content_type == "text/html; charset=utf-8" && output.objects[f].cache_control == "public, max-age=60"])
    error_message = "every page, in every section, is uploaded as HTML and cached a minute"
  }
  assert {
    condition     = length([for f in output.files : f if startswith(f, "hands-on/") || startswith(f, "messages/")]) == 0
    error_message = "the pages that moved aren't uploaded at their old paths, where the CloudFront Function redirects"
  }
  assert {
    condition     = output.objects["sitemap.xml"].content_type == "application/xml" && output.objects["og/www.jpg"].content_type == "image/jpeg" && output.objects["og/www.jpg"].cache_control == "public, max-age=60"
    error_message = "the sitemap is uploaded as XML, and the Open Graph image as a JPEG under a name that doesn't change, cached a minute"
  }
  assert {
    condition     = alltrue([for f, o in output.objects : o.cache_control == "public, max-age=31536000, immutable" if can(regex("^assets/site\\.[0-9a-f]{10}\\.css$", f))]) && length([for f, o in output.objects : f if can(regex("^assets/site\\.[0-9a-f]{10}\\.css$", f)) && o.content_type == "text/css; charset=utf-8"]) > 0
    error_message = "the hashed stylesheet the pages share is uploaded as CSS, cached a year"
  }
}
