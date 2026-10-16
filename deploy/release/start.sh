#!/bin/bash
# Starts Kolab from this release. The instance's konjir-start runs it as the konjir user, with
# /etc/konjir/env and the admin token in the environment, and passes --port and --data.
# It ships with the code, so changing how Kolab starts is a plain terraform apply.
set -euo pipefail
# The physical path: the release is reached through the /opt/konjir/current symlink.
cd -P "$(dirname "$0")/../.."
# Plain node on the output install.sh compiled: each package's default export is its dist/.
exec node apps/cli/dist/main.js serve "$@" --quiet
