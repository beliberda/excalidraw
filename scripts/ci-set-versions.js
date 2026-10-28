#!/usr/bin/env node
// Bumps the version of every publishable workspace package to
// `<version>-<suffix>` and rewrites cross-package dependency pins so they
// stay internally consistent. Run before `yarn install`/`yarn build:packages`
// in CI — not meant to be committed back to the repo.
const fs = require("fs");
const path = require("path");

const suffix = process.argv[2];
if (!suffix) {
  console.error("Usage: node ci-set-versions.js <suffix>");
  process.exit(1);
}

const packages = [
  "common",
  "fractional-indexing",
  "laser-pointer",
  "math",
  "element",
  "excalidraw",
];

const pkgPaths = packages.map((pkg) =>
  path.join(__dirname, "..", "packages", pkg, "package.json"),
);

const newVersions = {};
for (const pkgPath of pkgPaths) {
  const json = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  newVersions[json.name] = `${json.version}-${suffix}`;
}

for (const pkgPath of pkgPaths) {
  const json = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  json.version = newVersions[json.name];
  for (const depField of [
    "dependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    if (!json[depField]) continue;
    for (const dep of Object.keys(json[depField])) {
      if (newVersions[dep]) {
        json[depField][dep] = newVersions[dep];
      }
    }
  }
  fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2) + "\n");
  console.log(`${json.name} -> ${json.version}`);
}
