#!/bin/bash
# Starts Kolab from this release. The instance's konjir-start runs it as the konjir user, with
# /etc/konjir/env, the admin token and the database URL in the environment, and passes --port and
# --data. It ships with the code, so changing how Kolab starts is a plain terraform apply.
set -euo pipefail
# The physical path: the release is reached through the /opt/konjir/current symlink.
cd -P "$(dirname "$0")/../.."
# Sign-in with GitHub (D55): the OAuth app's client id, which Terraform keeps beside the admin
# token (/konjir/<name>/github-client-id), and its secret, which Lee puts there by hand
# (/konjir/<name>/github-client-secret). Without either, Kolab runs without GitHub sign-in, and
# says so in one line. This reads them here rather than in the boot script, so adding them
# doesn't change the boot script, which would replace the instance. The secret is never printed.
if [ -n "${AWS_REGION:-}" ] && [ -n "${KONJIR_TOKEN_PARAM:-}" ] && [ -z "${KONJIR_GITHUB_CLIENT_ID:-}" ]; then
  PARAMS="${KONJIR_TOKEN_PARAM%/admin-token}"
  if GITHUB_ID=$(aws ssm get-parameter --region "$AWS_REGION" --name "$PARAMS/github-client-id" \
      --query Parameter.Value --output text 2>/dev/null); then
    if GITHUB_SECRET=$(aws ssm get-parameter --region "$AWS_REGION" --name "$PARAMS/github-client-secret" \
        --with-decryption --query Parameter.Value --output text 2>/dev/null) && [ -n "$GITHUB_SECRET" ]; then
      export KONJIR_GITHUB_CLIENT_ID="$GITHUB_ID" KONJIR_GITHUB_CLIENT_SECRET="$GITHUB_SECRET"
    else
      # One of Kolab's JSON log lines (P11, D68).
      printf '{"time":"%s","level":"warn","message":"the GitHub OAuth app client id is set but %s/github-client-secret cannot be read; running without GitHub sign-in"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$PARAMS" >&2
    fi
    unset GITHUB_SECRET
  fi
fi
# The published kolab CLI's npm spec (W3.7), which Terraform keeps beside the admin token
# (/konjir/<name>/cli-npm-spec), so the web page shows npx commands for it. Without the
# parameter, the page shows none. Like the GitHub app's, it is read here, not in the boot script.
if [ -n "${AWS_REGION:-}" ] && [ -n "${KONJIR_TOKEN_PARAM:-}" ] && [ -z "${KONJIR_CLI_NPM_SPEC:-}" ]; then
  if CLI_NPM_SPEC=$(aws ssm get-parameter --region "$AWS_REGION" --name "${KONJIR_TOKEN_PARAM%/admin-token}/cli-npm-spec" \
      --query Parameter.Value --output text 2>/dev/null) && [ -n "$CLI_NPM_SPEC" ]; then
    export KONJIR_CLI_NPM_SPEC="$CLI_NPM_SPEC"
  fi
  unset CLI_NPM_SPEC
fi
# Expo's access token, for push notifications to konnect's phone app (S4): the SecureString
# /konjir/<name>/expo-access-token beside the admin token, which Terraform makes as `unset` and Lee
# fills in. Unset, unreadable or missing, Kolab runs with push off and says so in one line of its
# own. Like the GitHub app's, it is read here, not in the boot script. The token is never printed.
if [ -n "${AWS_REGION:-}" ] && [ -n "${KONJIR_TOKEN_PARAM:-}" ] && [ -z "${KONJIR_EXPO_ACCESS_TOKEN:-}" ]; then
  if EXPO_TOKEN=$(aws ssm get-parameter --region "$AWS_REGION" --name "${KONJIR_TOKEN_PARAM%/admin-token}/expo-access-token" \
      --with-decryption --query Parameter.Value --output text 2>/dev/null) && [ -n "$EXPO_TOKEN" ] && [ "$EXPO_TOKEN" != unset ]; then
    export KONJIR_EXPO_ACCESS_TOKEN="$EXPO_TOKEN"
  fi
  unset EXPO_TOKEN
fi
# Plain node on the output install.sh compiled: each package's default export is its dist/.
exec node apps/cli/dist/main.js serve "$@" --quiet
