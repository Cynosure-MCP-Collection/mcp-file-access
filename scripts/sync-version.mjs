import { readFile, writeFile } from "node:fs/promises";

const checkOnly = process.argv.includes("--check");
const packagePath = new URL("../package.json", import.meta.url);
const serverPath = new URL("../server.json", import.meta.url);

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const serverContents = await readFile(serverPath, "utf8");
const serverJson = JSON.parse(serverContents);
const version = packageJson.version;
const npmPackageName = packageJson.name;
const expectedIconUrl = `https://unpkg.com/${npmPackageName}@${version}/icon.png`;
const errors = [];

if (serverJson.version !== version) {
  errors.push(`server.json version is ${serverJson.version}; expected ${version}`);
  serverJson.version = version;
}

const npmPackages = (serverJson.packages ?? []).filter(
  (entry) => entry.registryType === "npm" && entry.identifier === npmPackageName,
);

if (npmPackages.length === 0) {
  errors.push(`server.json has no npm package entry for ${npmPackageName}`);
}

for (const entry of npmPackages) {
  if (entry.version !== version) {
    errors.push(`server.json package version is ${entry.version}; expected ${version}`);
    entry.version = version;
  }
}

for (const icon of serverJson.icons ?? []) {
  if (typeof icon.src !== "string" || !icon.src.startsWith(`https://unpkg.com/${npmPackageName}@`)) {
    continue;
  }

  if (icon.src !== expectedIconUrl) {
    errors.push(`server.json icon URL does not reference version ${version}`);
    icon.src = expectedIconUrl;
  }
}

if (checkOnly) {
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
  }
} else if (errors.length > 0) {
  const indentation = serverContents.match(/\n( +)"/)?.[1].length ?? 2;
  await writeFile(serverPath, `${JSON.stringify(serverJson, null, indentation)}\n`);
  console.log(`Synchronized server.json to ${npmPackageName}@${version}`);
}
