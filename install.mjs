#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  cpSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const defaultSkillName = "api-replay-recorder";

function usage() {
  return `Usage:
  node install.mjs --target-dir <agent-skills-dir> [--name api-replay-recorder]
  node install.mjs --codex

Options:
  --target-dir <dir>  Directory where the skill link or copy should be installed.
  --codex            Install into \${CODEX_HOME:-~/.codex}/skills.
  --name <name>      Installed skill folder name. Default: api-replay-recorder.
  --copy             Copy the skill folder instead of creating a symlink.
  --force            Replace an existing install at the destination.
  --no-deps          Skip npm install in this repository.
  --dry-run          Print the planned install without changing files.
  --help             Show this help.
`;
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function parseArgs(argv) {
  const out = {
    targetDir: process.env.AGENT_SKILLS_DIR || null,
    name: defaultSkillName,
    copy: false,
    force: false,
    installDeps: true,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--codex") {
      const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
      out.targetDir = join(codexHome, "skills");
    } else if (arg === "--target-dir") {
      out.targetDir = argv[++index];
    } else if (arg === "--name") {
      out.name = argv[++index];
    } else if (arg === "--copy") {
      out.copy = true;
    } else if (arg === "--force") {
      out.force = true;
    } else if (arg === "--no-deps") {
      out.installDeps = false;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!out.targetDir && !out.help) {
    out.targetDir = join(homedir(), ".agent-skills");
  }

  out.targetDir = expandHome(out.targetDir);
  return out;
}

function runNpmInstall(cwd, dryRun) {
  if (dryRun) return;
  const result = spawnSync("npm", ["install"], {
    cwd,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status}`);
  }
}

function writeCopiedPackage(destination) {
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const copiedPackage = {
    name: "api-replay-recorder-skill",
    version: rootPackage.version || "0.1.0",
    private: true,
    dependencies: rootPackage.dependencies || {}
  };
  writeFileSync(join(destination, "package.json"), `${JSON.stringify(copiedPackage, null, 2)}\n`);
}

function sameSymlink(destination, source) {
  if (!existsSync(destination)) return false;
  const stat = lstatSync(destination);
  if (!stat.isSymbolicLink()) return false;
  return resolve(dirname(destination), readlinkSync(destination)) === source;
}

function installSkill(options) {
  const source = resolve(repoRoot, defaultSkillName);
  const destination = resolve(options.targetDir, options.name);

  if (!existsSync(join(source, "SKILL.md"))) {
    throw new Error(`Missing skill entrypoint: ${join(source, "SKILL.md")}`);
  }

  const plan = {
    repoRoot,
    source,
    destination,
    mode: options.copy ? "copy" : "symlink",
    installDeps: options.installDeps,
    dryRun: options.dryRun
  };

  if (options.dryRun) {
    console.log(JSON.stringify({ ok: true, plan }, null, 2));
    return;
  }

  if (!options.copy && options.installDeps) runNpmInstall(repoRoot, options.dryRun);

  mkdirSync(options.targetDir, { recursive: true });

  if (existsSync(destination)) {
    if (!options.copy && sameSymlink(destination, source)) {
      console.log(JSON.stringify({ ok: true, alreadyInstalled: true, ...plan }, null, 2));
      return;
    }
    if (!options.force) {
      throw new Error(`Destination already exists: ${destination}. Use --force to replace it.`);
    }
    rmSync(destination, { recursive: true, force: true });
  }

  if (options.copy) {
    cpSync(source, destination, { recursive: true });
    if (options.installDeps) {
      writeCopiedPackage(destination);
      runNpmInstall(destination, options.dryRun);
    }
  } else {
    symlinkSync(source, destination, "dir");
  }

  console.log(JSON.stringify({ ok: true, ...plan }, null, 2));
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  installSkill(options);
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(1);
}
