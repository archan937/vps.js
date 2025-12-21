#!/usr/bin/env bun
import { loadAndValidateVPSConfig } from "../lib/config.js";
import { log } from "../lib/logger.js";
import {
  sshExec,
  sshExecQuiet,
  sshExecStdout,
  filterMOTDFromOutput,
} from "../lib/ssh.js";
import type { ServiceType } from "../lib/types.js";

// Cache for remote HOME directory
let composeHomeCache: string | null = null;

/**
 * Get remote HOME directory (cached after first call)
 */
async function getComposeHome(config: {
  vpsHost: string;
  vpsUser: string;
}): Promise<string> {
  if (!composeHomeCache) {
    const result = await sshExecStdout("echo $HOME", {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    });
    composeHomeCache = filterMOTDFromOutput(result);
  }
  return composeHomeCache;
}

/**
 * Print usage information
 */
function usage(): void {
  log.raw(`Usage: bin/compose <command> [arguments]

Environment Variables:
  VPS_HOST          VPS hostname or IP (required)
  VPS_USER          VPS username (required)

Commands:
  init <name>                    Initialize a new docker-compose project
  add <project> <type> <alias>   Add a container to a project
                                 Types: bun, mysql
  clone <project> <alias> <url>  Clone a Git repository into ~/apps/<project>/apps/<alias>
  up <project>                   Start a docker-compose project
  down <project>                 Stop and remove a docker-compose project
  restart <project>              Restart a docker-compose project

Examples:
  export VPS_HOST=192.168.1.100
  bin/compose init myapp
  bin/compose add myapp bun app
  bin/compose add myapp mysql db
  bin/compose clone myapp app https://github.com/user/repo.git
  bin/compose up myapp
  bin/compose down myapp
  bin/compose restart myapp`);
  process.exit(1);
}

/**
 * Get Bun service configuration
 */
function getBunService(
  projectName: string,
  alias: string,
  composeHome: string
): string {
  const appDir = `${composeHome}/${projectName}/apps/${alias}`;
  return `  ${alias}:
    image: oven/bun:latest
    container_name: ${alias}
    working_dir: /app
    volumes:
      - ${appDir}:/app
    command: bun run --watch src/index.ts
    networks:
      - default
    restart: unless-stopped
    environment:
      - NODE_ENV=development`;
}

/**
 * Get MySQL service configuration
 */
function getMysqlService(alias: string): string {
  const dbName = `${alias}_db`;
  const rootPassword = "root_password_change_me";
  const user = `${alias}_user`;
  const password = "user_password_change_me";

  return `  ${alias}:
    image: mysql:8.0
    container_name: ${alias}
    environment:
      MYSQL_ROOT_PASSWORD: ${rootPassword}
      MYSQL_DATABASE: ${dbName}
      MYSQL_USER: ${user}
      MYSQL_PASSWORD: ${password}
    volumes:
      - ${alias}_data:/var/lib/mysql
    networks:
      - default
    restart: unless-stopped
    ports:
      - "127.0.0.1:3306:3306"
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5`;
}

/**
 * Initialize a new docker-compose project
 */
async function initProject(
  projectName: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName) {
    log.error("Project name is required");
    usage();
  }

  const composeHome = await getComposeHome(config);
  const projectDir = `${composeHome}/${projectName}`;

  // Check if directory exists on VPS
  const dirExists = await sshExecQuiet(`[ -d "${projectDir}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (dirExists.success) {
    log.warn(`Project directory already exists on VPS: ${projectDir}`);
    process.exit(1);
  }

  log.info(`Initializing docker-compose project on VPS: ${projectName}`);

  // Create directory
  await sshExec(`mkdir -p "${projectDir}"`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  // Create docker-compose.yml
  const composeContent = `services:
  # Add your services here using: bin/compose add ${projectName} <type> <alias>

networks:
  default:
    name: ${projectName}_network
`;

  await sshExec(
    `cat > "${projectDir}/docker-compose.yml"`,
    {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    },
    composeContent
  );

  log.ok(`Project initialized on VPS at: ${projectDir}`);
  log.info(
    `You can now add services using: bin/compose add ${projectName} <type> <alias>`
  );
}

/**
 * Add a service to a docker-compose project
 */
async function addService(
  projectName: string,
  serviceType: string,
  alias: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName || !serviceType || !alias) {
    log.error("Project name, service type, and alias are required");
    usage();
  }

  const composeHome = await getComposeHome(config);
  const projectDir = `${composeHome}/${projectName}`;
  const composeFile = `${projectDir}/docker-compose.yml`;

  // Check if project exists
  const dirExists = await sshExecQuiet(`[ -d "${projectDir}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (!dirExists.success) {
    log.error(`Project directory does not exist on VPS: ${projectDir}`);
    log.info(`Initialize it first with: bin/compose init ${projectName}`);
    process.exit(1);
  }

  const fileExists = await sshExecQuiet(`[ -f "${composeFile}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (!fileExists.success) {
    log.error(`docker-compose.yml not found on VPS: ${composeFile}`);
    process.exit(1);
  }

  // Check if service already exists
  const serviceExists = await sshExec(
    `grep -q "^  ${alias}:" "${composeFile}"`,
    {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    }
  );

  if (serviceExists.success) {
    log.warn(`Service '${alias}' already exists in docker-compose.yml`);
    process.exit(1);
  }

  log.info(
    `Adding ${serviceType} service '${alias}' to project '${projectName}' on VPS`
  );

  const serviceTypeLower = serviceType.toLowerCase();
  let serviceConfig = "";

  if (serviceTypeLower === "bun") {
    const appDir = `${composeHome}/${projectName}/apps/${alias}`;
    await sshExec(`mkdir -p "${appDir}"`, {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    });
    log.info(`Created app directory on VPS: ${appDir}`);
    serviceConfig = getBunService(projectName, alias, composeHome);
  } else if (serviceTypeLower === "mysql") {
    serviceConfig = getMysqlService(alias);
  } else {
    log.error(`Unknown service type: ${serviceType}`);
    log.info("Supported types: bun, mysql");
    process.exit(1);
  }

  // Download compose file
  const composeContent = await sshExecStdout(`cat "${composeFile}"`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  // Create backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const backupFile = `/tmp/docker-compose.backup.${timestamp}.yml`;
  await sshExec(`cp "${composeFile}" "${backupFile}"`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });
  log.info(`Backup created on VPS at: ${backupFile}`);

  // Parse and modify YAML
  const lines = composeContent.split("\n");
  const newLines: string[] = [];
  let inServices = false;
  let servicesEnded = false;
  let currentIndent = 0;
  let lastServiceEndIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const lineIndent = line.length - line.trimStart().length;

    // Track when we're in the services section
    if (trimmed === "services:") {
      inServices = true;
      newLines.push(line);
      continue;
    }

    // Check if we've left the services section (top-level key with no indent)
    if (inServices && lineIndent === 0 && trimmed && !trimmed.startsWith("#")) {
      // This is a top-level key after services, insert our service before it
      if (!servicesEnded) {
        newLines.push(serviceConfig);
        newLines.push("");
        servicesEnded = true;
      }
      inServices = false;
    }

    // Track the end of the last service (before top-level sections)
    if (inServices && trimmed && lineIndent === 0 && !servicesEnded) {
      lastServiceEndIndex = i;
    }

    newLines.push(line);
  }

  // If we're still in services section or no top-level sections found
  if (!servicesEnded) {
    if (lastServiceEndIndex !== -1) {
      // Insert after the last service
      newLines.splice(lastServiceEndIndex + 1, 0, serviceConfig, "");
    } else {
      // Find services: line and insert after it
      const servicesIndex = newLines.findIndex((l) => l.trim() === "services:");
      if (servicesIndex !== -1) {
        // Find first non-comment, non-empty line after services:
        let insertIndex = servicesIndex + 1;
        while (
          insertIndex < newLines.length &&
          (newLines[insertIndex]?.trim() === "" ||
            newLines[insertIndex]?.trim().startsWith("#"))
        ) {
          insertIndex++;
        }
        newLines.splice(insertIndex, 0, serviceConfig, "");
      }
    }
  }

  // Add volumes section for MySQL if needed
  if (serviceTypeLower === "mysql") {
    const volumeName = `  ${alias}_data:`;
    const hasVolumes = newLines.some((l) => l.trim() === "volumes:");
    const hasVolume = newLines.some((l) => l.trim() === volumeName);

    if (!hasVolumes) {
      // Find networks section and insert volumes before it
      const networksIndex = newLines.findIndex((l) => l.trim() === "networks:");
      if (networksIndex !== -1) {
        newLines.splice(networksIndex, 0, "", "volumes:", volumeName);
      } else {
        newLines.push("", "volumes:", volumeName);
      }
    } else if (!hasVolume) {
      // Find volumes section and add volume
      const volumesIndex = newLines.findIndex((l) => l.trim() === "volumes:");
      if (volumesIndex !== -1) {
        newLines.splice(volumesIndex + 1, 0, volumeName);
      }
    }
  }

  const newContent = newLines.join("\n");

  // Upload modified file
  await sshExec(
    `cat > "${composeFile}"`,
    {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    },
    newContent
  );

  log.ok(`Service '${alias}' added successfully on VPS`);
  log.info(`Review and customize on VPS: ${composeFile}`);

  if (serviceTypeLower === "mysql") {
    log.warn("Remember to change MySQL passwords in docker-compose.yml on VPS");
  }
}

/**
 * Clone a Git repository
 */
async function cloneRepo(
  projectName: string,
  alias: string,
  cloneUrl: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName || !alias || !cloneUrl) {
    log.error("Project name, container alias, and clone URL are required");
    usage();
  }

  const composeHome = await getComposeHome(config);
  const appDir = `${composeHome}/${projectName}/apps/${alias}`;

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
 * Restart a docker-compose project
 */
async function restartProject(
  projectName: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName) {
    log.error("Project name is required");
    usage();
  }

  const composeHome = await getComposeHome(config);
  const projectDir = `${composeHome}/${projectName}`;
  const composeFile = `${projectDir}/docker-compose.yml`;

  // Check if project exists
  const dirExists = await sshExecQuiet(`[ -d "${projectDir}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (!dirExists.success) {
    log.error(`Project directory does not exist on VPS: ${projectDir}`);
    log.info(`Initialize it first with: bin/compose init ${projectName}`);
    process.exit(1);
  }

  const fileExists = await sshExecQuiet(`[ -f "${composeFile}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (!fileExists.success) {
    log.error(`docker-compose.yml not found on VPS: ${composeFile}`);
    process.exit(1);
  }

  log.info(`Restarting docker-compose project '${projectName}' on VPS`);

  const result = await sshExec(`cd "${projectDir}" && docker compose restart`, {
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
    log.error(`Failed to restart project '${projectName}'`);
    process.exit(1);
  }

  log.ok(`Project '${projectName}' restarted successfully`);
}

/**
 * Start a docker-compose project
 */
async function upProject(
  projectName: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName) {
    log.error("Project name is required");
    usage();
  }

  const composeHome = await getComposeHome(config);
  const projectDir = `${composeHome}/${projectName}`;
  const composeFile = `${projectDir}/docker-compose.yml`;

  // Check if project exists
  const dirExists = await sshExecQuiet(`[ -d "${projectDir}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (!dirExists.success) {
    log.error(`Project directory does not exist on VPS: ${projectDir}`);
    log.info(`Initialize it first with: bin/compose init ${projectName}`);
    process.exit(1);
  }

  const fileExists = await sshExecQuiet(`[ -f "${composeFile}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (!fileExists.success) {
    log.error(`docker-compose.yml not found on VPS: ${composeFile}`);
    process.exit(1);
  }

  log.info(`Starting docker-compose project '${projectName}' on VPS`);

  const result = await sshExec(`cd "${projectDir}" && docker compose up -d`, {
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
    log.error(`Failed to start project '${projectName}'`);
    process.exit(1);
  }

  log.ok(`Project '${projectName}' started successfully`);
}

/**
 * Stop a docker-compose project
 */
async function downProject(
  projectName: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName) {
    log.error("Project name is required");
    usage();
  }

  const composeHome = await getComposeHome(config);
  const projectDir = `${composeHome}/${projectName}`;
  const composeFile = `${projectDir}/docker-compose.yml`;

  // Check if project exists
  const dirExists = await sshExecQuiet(`[ -d "${projectDir}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (!dirExists.success) {
    log.error(`Project directory does not exist on VPS: ${projectDir}`);
    log.info(`Initialize it first with: bin/compose init ${projectName}`);
    process.exit(1);
  }

  const fileExists = await sshExecQuiet(`[ -f "${composeFile}" ]`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  if (!fileExists.success) {
    log.error(`docker-compose.yml not found on VPS: ${composeFile}`);
    process.exit(1);
  }

  log.info(`Stopping docker-compose project '${projectName}' on VPS`);
  log.info('Note: Volumes will persist and can be reused on next "up"');

  const result = await sshExec(`cd "${projectDir}" && docker compose down`, {
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
    log.error(`Failed to stop project '${projectName}'`);
    process.exit(1);
  }

  log.ok(`Project '${projectName}' stopped successfully`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    usage();
  }

  const config = await loadAndValidateVPSConfig(["vpsHost", "vpsUser"]);

  const command = args[0];
  const commandArgs = args.slice(1);

  try {
    switch (command) {
      case "init":
        if (commandArgs.length < 1) {
          log.error("Project name required");
          usage();
        }
        await initProject(commandArgs[0], config);
        break;

      case "add":
        if (commandArgs.length < 3) {
          log.error("Project name, service type, and alias required");
          usage();
        }
        await addService(
          commandArgs[0],
          commandArgs[1],
          commandArgs[2],
          config
        );
        break;

      case "clone":
        if (commandArgs.length < 3) {
          log.error("Project name, container alias, and clone URL required");
          usage();
        }
        await cloneRepo(commandArgs[0], commandArgs[1], commandArgs[2], config);
        break;

      case "up":
        if (commandArgs.length < 1) {
          log.error("Project name required");
          usage();
        }
        await upProject(commandArgs[0], config);
        break;

      case "down":
        if (commandArgs.length < 1) {
          log.error("Project name required");
          usage();
        }
        await downProject(commandArgs[0], config);
        break;

      case "restart":
        if (commandArgs.length < 1) {
          log.error("Project name required");
          usage();
        }
        await restartProject(commandArgs[0], config);
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
    process.exit(1);
  }
}

main();
