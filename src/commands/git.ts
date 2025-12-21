#!/usr/bin/env bun
import { loadAndValidateVPSConfig } from "../lib/config.js";
import { log } from "../lib/logger.js";
import { sshExec, sshExecQuiet, sshExecStdout } from "../lib/ssh.js";
import { getComposeHome } from "../lib/compose.js";

/**
 * Get the app directory path for a project and alias
 */
async function getAppDir(
  projectName: string,
  alias: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<string> {
  const composeHome = await getComposeHome(config);
  return `${composeHome}/${projectName}/apps/${alias}`;
}

/**
 * Ensure the app directory is a git repository
 */
async function ensureGitRepo(
  appDir: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  const gitExists = await sshExecQuiet(`[ -d "${appDir}/.git" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (!gitExists.success) {
    log.error(`Not a git repository: ${appDir}`);
    log.info(`Clone it first with: bin/git clone <project> <alias> <url>`);
    process.exit(1);
  }
}

/**
 * Clone a Git repository
 */
export async function cloneRepo(
  projectName: string,
  alias: string,
  cloneUrl: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName || !alias || !cloneUrl) {
    log.error("Project name, container alias, and clone URL are required");
    process.exit(1);
  }

  const appDir = await getAppDir(projectName, alias, config);

  // Check if it's already a git repository
  const gitExists = await sshExecQuiet(`[ -d "${appDir}/.git" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (gitExists.success) {
    log.warn(`Git repository already exists on VPS: ${appDir}`);
    log.info("If you want to re-clone, remove the directory first");
    process.exit(1);
  }

  // If directory exists but isn't a git repo, remove it
  const dirExists = await sshExecQuiet(`[ -d "${appDir}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (dirExists.success) {
    log.info(`Removing existing non-git directory: ${appDir}`);
    await sshExec(`rm -rf "${appDir}"`, {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    });
  }

  log.info(`Cloning repository into ${appDir} on VPS`);

  // Ensure GitHub host key is in known_hosts (if using GitHub)
  if (cloneUrl.includes("github.com")) {
    await sshExec(
      "ssh-keyscan -H github.com >> ~/.ssh/known_hosts 2>/dev/null || true",
      {
        host: config.vpsHost,
        user: config.vpsUser,
        agentForward: true,
      }
    );
  }

  // Create parent directories and clone
  await sshExec(`mkdir -p "$(dirname "${appDir}")"`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  await sshExec(`git clone "${cloneUrl}" "${appDir}"`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  log.ok(`Repository cloned successfully to: ${appDir}`);
}

/**
 * Pull latest changes from git repository
 */
export async function pullRepo(
  projectName: string,
  alias: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName || !alias) {
    log.error("Project name and container alias are required");
    process.exit(1);
  }

  try {
    const appDir = await getAppDir(projectName, alias, config);
    await ensureGitRepo(appDir, config);

    log.info(`Pulling latest changes from ${appDir} on VPS`);

    const result = await sshExec(`cd "${appDir}" && git pull`, {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    });

    if (result.stdout) {
      log.raw(result.stdout);
    }
    if (result.stderr) {
      log.raw(result.stderr);
    }

    if (!result.success) {
      log.error(`Failed to pull from repository`);
      process.exit(1);
    }

    log.ok(`Repository pulled successfully`);
  } catch (error) {
    log.error(
      `Failed to pull from repository: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}

/**
 * List or show current branch
 */
export async function branchRepo(
  projectName: string,
  alias: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName || !alias) {
    log.error("Project name and container alias are required");
    process.exit(1);
  }

  try {
    const appDir = await getAppDir(projectName, alias, config);
    await ensureGitRepo(appDir, config);

    log.info(`Getting branch information from ${appDir} on VPS`);

    const result = await sshExec(`cd "${appDir}" && git branch -a`, {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    });

    if (result.stdout) {
      log.raw(result.stdout);
    }
    if (result.stderr) {
      log.raw(result.stderr);
    }

    if (!result.success) {
      log.error(`Failed to get branch information`);
      process.exit(1);
    }

    // Show current branch
    const currentBranchResult = await sshExecStdout(
      `cd "${appDir}" && git branch --show-current`,
      {
        host: config.vpsHost,
        user: config.vpsUser,
        agentForward: true,
      }
    );

    if (currentBranchResult) {
      log.info(`Current branch: ${currentBranchResult.trim()}`);
    } else {
      log.warn("Could not determine current branch");
    }
  } catch (error) {
    log.error(
      `Failed to get branch information: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}

/**
 * Checkout a branch or commit
 */
export async function checkoutRepo(
  projectName: string,
  alias: string,
  ref: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName || !alias || !ref) {
    log.error("Project name, container alias, and branch/commit are required");
    process.exit(1);
  }

  const appDir = await getAppDir(projectName, alias, config);
  await ensureGitRepo(appDir, config);

  log.info(`Checking out ${ref} in ${appDir} on VPS`);

  // First, fetch to ensure we have the latest refs
  await sshExec(`cd "${appDir}" && git fetch`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  const result = await sshExec(`cd "${appDir}" && git checkout "${ref}"`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (result.stdout) {
    log.raw(result.stdout);
  }
  if (result.stderr) {
    log.raw(result.stderr);
  }

  if (!result.success) {
    log.error(`Failed to checkout ${ref}`);
    process.exit(1);
  }

  log.ok(`Checked out ${ref} successfully`);
}
/**
 * Print usage information
 */
function usage(): void {
  log.raw(`Usage: bin/git <command> [arguments]

Environment Variables:
  VPS_HOST          VPS hostname or IP (required)
  VPS_USER          VPS username (required)

Commands:
  clone <project> <alias> <url>  Clone a Git repository into ~/<project>/apps/<alias>
  pull <project> <alias>         Pull latest changes from git repository
  branch <project> <alias>       List branches and show current branch
  checkout <project> <alias> <ref>  Checkout a branch or commit

Examples:
  export VPS_HOST=192.168.1.100
  bin/git clone myapp app https://github.com/user/repo.git
  bin/git pull myapp app
  bin/git branch myapp app
  bin/git checkout myapp app main`);
  process.exit(1);
}

/**
 * Main git function
 */
async function git(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    usage();
    return;
  }

  try {
    const config = await loadAndValidateVPSConfig(["vpsHost", "vpsUser"]);

    const command = args[0];
    const commandArgs = args.slice(1);

    switch (command) {
      case "clone":
        if (commandArgs.length < 3) {
          log.error("Project name, container alias, and clone URL required");
          usage();
        }
        await cloneRepo(commandArgs[0], commandArgs[1], commandArgs[2], config);
        break;

      case "pull":
        if (commandArgs.length < 2) {
          log.error("Project name and container alias required");
          usage();
        }
        await pullRepo(commandArgs[0], commandArgs[1], config);
        break;

      case "branch":
        if (commandArgs.length < 2) {
          log.error("Project name and container alias required");
          usage();
        }
        await branchRepo(commandArgs[0], commandArgs[1], config);
        break;

      case "checkout":
        if (commandArgs.length < 3) {
          log.error(
            "Project name, container alias, and branch/commit required"
          );
          usage();
        }
        await checkoutRepo(
          commandArgs[0],
          commandArgs[1],
          commandArgs[2],
          config
        );
        break;

      default:
        log.error(`Unknown command: ${command}`);
        usage();
    }
  } catch (error) {
    log.error(
      `Command failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (error instanceof Error && error.stack) {
      log.raw(error.stack);
    }
    process.exit(1);
  }
}

// Run git command
git().catch((error) => {
  log.error(
    `Git command failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
});
