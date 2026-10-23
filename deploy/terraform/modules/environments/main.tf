# The two Kolabs (D73, W2.23), read by both root modules: deploy/terraform, which builds the one its
# `environment` variable names, and deploy/terraform/github-oidc, which gives CI a role for each.
# Nothing here is a secret, so it is committed.

output "all" {
  value = {
    production = {
      # Named before staging existed (D11 kept it). A new name would replace every resource, so it stays.
      name        = "konjir-test"
      domain_name = "kolab.konjir.com"
      # Must equal key in ../../environments/production.s3.tfbackend (tests/environments.tftest.hcl checks).
      state_key = "konjir/test/terraform.tfstate"
      # The GitHub OAuth app people sign in with (D55); its callback is
      # https://kolab.konjir.com/oauth/callback/github. A client id is public.
      github_oauth_client_id    = "Ov23licO2Gy9ngM4tgPE"
      instance_type             = "t4g.small"
      data_volume_gib           = 20
      db_instance_class         = "db.t4g.micro"
      db_allocated_gib          = 20
      final_snapshot_on_destroy = true
    }
    staging = {
      name        = "konjir-staging"
      domain_name = "staging.kolab.konjir.com"
      state_key   = "konjir/staging/terraform.tfstate"
      # Staging's own GitHub OAuth app, with the callback
      # https://staging.kolab.konjir.com/oauth/callback/github (README: Staging). Empty until Lee
      # creates it and commits its client id here: staging then runs without GitHub sign-in.
      github_oauth_client_id = ""
      # Production's size: a release installs with npm ci and an Nx build on the instance, which
      # a t4g.micro's 1 GiB can't hold.
      instance_type = "t4g.small"
      # Only the boot script mounts it; staging never held the PGlite database it keeps for production.
      data_volume_gib = 1
      # The smallest RDS takes: 20 GB of gp3, one zone.
      db_instance_class = "db.t4g.micro"
      db_allocated_gib  = 20
      # Staging's data is disposable, so a teardown leaves no snapshot behind.
      final_snapshot_on_destroy = false
    }
  }
}
