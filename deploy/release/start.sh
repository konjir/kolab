#!/bin/bash
# Starts Kolab from this release. The instance's konjir-start runs it as the konjir user, with
# /etc/konjir/env, the admin token and the database URL in the environment, and passes --port and --data.
# It ships with the code, so changing how Kolab starts is a plain terraform apply.
set -euo pipefail
# The physical path: the release is reached through the /opt/konjir/current symlink.
cd -P "$(dirname "$0")/../.."
# Sign-in with GitHub (D55): the OAuth app's client id and secret, when Terraform has stored them
# beside the admin token (/konjir/<name>/github-client-id and -secret). Without them, Kolab runs
# without GitHub sign-in. This reads them here rather than in the boot script, so adding them
# doesn't change the boot script, which would replace the instance. Neither is ever printed.
if [ -n "${AWS_REGION:-}" ] && [ -n "${KONJIR_TOKEN_PARAM:-}" ] && [ -z "${KONJIR_GITHUB_CLIENT_ID:-}" ]; then
  PARAMS="${KONJIR_TOKEN_PARAM%/admin-token}"
  if GITHUB_ID=$(aws ssm get-parameter --region "$AWS_REGION" --name "$PARAMS/github-client-id" \
      --query Parameter.Value --output text 2>/dev/null); then
    KONJIR_GITHUB_CLIENT_SECRET=$(aws ssm get-parameter --region "$AWS_REGION" --name "$PARAMS/github-client-secret" \
      --with-decryption --query Parameter.Value --output text)
    export KONJIR_GITHUB_CLIENT_ID="$GITHUB_ID" KONJIR_GITHUB_CLIENT_SECRET
  fi
fi
# Plain node on the output install.sh compiled: each package's default export is its dist/.
exec node apps/cli/dist/main.js serve "$@" --quiet
