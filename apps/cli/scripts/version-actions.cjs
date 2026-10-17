// nx release's version actions for konjir (W2.6), so nx release versions the CLI without @nx/js.
// @nx/js's own would bring Babel into every install, including the instance's (install.sh), and
// installing it turns on Nx's source-file analysis, which needs TypeScript 5's JavaScript API.
// konjir has one manifest, apps/cli/package.json, and no workspace dependency nx release must
// update: the published package bundles what it uses. Publishing isn't nx release's: the Release
// CLI workflow publishes the tarball it tested (.github/workflows/release-cli.yml).
const { join } = require('node:path');
const { VersionActions } = require('nx/release');

class KonjirVersionActions extends VersionActions {
  validManifestFilenames = ['package.json'];

  manifest(tree) {
    return join(this.projectGraphNode.data.root, 'package.json');
  }

  async readCurrentVersionFromSourceManifest(tree) {
    const path = this.manifest(tree);
    return { currentVersion: JSON.parse(tree.read(path, 'utf-8')).version, manifestPath: path };
  }

  async readCurrentVersionFromRegistry() {
    return null; // the git tag (konjir@<version>) or the manifest is the current version
  }

  async readCurrentVersionOfDependency() {
    return { currentVersion: null, dependencyCollection: null };
  }

  async updateProjectVersion(tree, newVersion) {
    const path = this.manifest(tree);
    const json = JSON.parse(tree.read(path, 'utf-8'));
    json.version = newVersion;
    tree.write(path, `${JSON.stringify(json, null, 2)}\n`);
    return [`✍️  New version ${newVersion} written to ${path}`];
  }

  async updateProjectDependencies() {
    return [];
  }
}

module.exports = KonjirVersionActions;
