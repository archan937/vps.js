#!/usr/bin/env bun
import { loadAndValidateVPSConfig } from "../lib/config.js";
import { log } from "../lib/logger.js";
import {
  sshExec,
  sshExecQuiet,
  sshExecStdout,
  filterMOTDFromOutput,
} from "../lib/ssh.js";
import { getComposeHome } from "../lib/compose.js";
import type {
  DockerComposeConfig,
  DockerComposeService,
} from "../lib/types.js";
import yaml from "yaml";

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
  up <project>                   Start a docker-compose project
  down <project>                 Stop and remove a docker-compose project
  restart <project>              Restart a docker-compose project
  exec <project> <alias> <cmd>   Execute a command in a container

Examples:
  export VPS_HOST=192.168.1.100
  bin/compose init myapp
  bin/compose add myapp bun app
  bin/compose add myapp mysql db
  bin/compose up myapp
  bin/compose exec myapp app bun install
  bin/compose down myapp
  bin/compose restart myapp`);
  process.exit(1);
}

/**
 * Get Bun service configuration as an object
 */
async function getBunService(
  projectName: string,
  alias: string,
  composeHome: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<DockerComposeService> {
  const appDir = `${composeHome}/${projectName}/apps/${alias}`;

  return {
    image: "oven/bun:latest",
    container_name: alias,
    userns_mode: "host",
    working_dir: "/app",
    volumes: [`${appDir}:/app`, `/app/node_modules`],
    command: ["bun", "run", "--watch", "src/index.ts"],
    networks: ["default"],
    restart: "unless-stopped",
    environment: {
      NODE_ENV: "development",
    },
  };
}

/**
 * Get MySQL service configuration as an object
 */
function getMysqlService(alias: string): DockerComposeService {
  const dbName = `${alias}_db`;
  const rootPassword = "root_password_change_me";
  const user = `${alias}_user`;
  const password = "user_password_change_me";

  return {
    image: "mysql:8.0",
    container_name: alias,
    environment: {
      MYSQL_ROOT_PASSWORD: rootPassword,
      MYSQL_DATABASE: dbName,
      MYSQL_USER: user,
      MYSQL_PASSWORD: password,
    },
    volumes: [`${alias}_data:/var/lib/mysql`],
    networks: ["default"],
    restart: "unless-stopped",
    ports: ["127.0.0.1:3306:3306"],
    healthcheck: {
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
    },
  };
}

/**
 * Add this helper to prepare the config for YAML output with inline arrays
 */
function prepareConfigForYaml(
  config: DockerComposeConfig
): DockerComposeConfig {
  // Deep clone to avoid mutating original
  const prepared = JSON.parse(JSON.stringify(config)) as DockerComposeConfig;

  // Recursively process services to mark arrays for inline formatting
  if (prepared.services) {
    for (const serviceName in prepared.services) {
      const service = prepared.services[serviceName];
      if (service) {
        // Ensure command is an array (already is, but ensure it's marked)
        if (service.command && Array.isArray(service.command)) {
          // Keep as array - yaml.stringify will handle it
        }
        // Ensure healthcheck.test is an array
        if (
          service.healthcheck?.test &&
          Array.isArray(service.healthcheck.test)
        ) {
          // Keep as array
        }
      }
    }
  }

  // Ensure all volumes are empty objects
  if (prepared.volumes) {
    for (const volumeName in prepared.volumes) {
      if (
        prepared.volumes[volumeName] === null ||
        prepared.volumes[volumeName] === undefined
      ) {
        prepared.volumes[volumeName] = {};
      }
    }
  }

  return prepared;
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

  // Build docker-compose object
  const composeConfig: DockerComposeConfig = {
    services: {},
    networks: {
      default: {
        name: `${projectName}_network`,
      },
    },
  };

  const preparedConfig = prepareConfigForYaml(composeConfig);

  // Convert to YAML - use custom formatting
  let composeContent = yaml.stringify(preparedConfig, {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    simpleKeys: false,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });

  // Post-process to make command and healthcheck.test arrays inline
  // This is the ONLY string manipulation we need - just for formatting preference
  composeContent = composeContent.replace(
    /^(\s+command:\s*\n)((?:\s+- [^\n]+\n)+)/gm,
    (match, before, items) => {
      const itemLines = items
        .split("\n")
        .filter((l: string) => l.trim().startsWith("-"))
        .map((l: string) => {
          let item = l.trim().substring(1).trim();
          if (item.startsWith('"') && item.endsWith('"')) return item;
          if (item.includes(" ") || item.includes(":")) return `"${item}"`;
          return item;
        });
      const indent = before.match(/(\s+)command:/)?.[1] || "      ";
      return `${indent}command: [${itemLines.join(", ")}]\n`;
    }
  );

  composeContent = composeContent.replace(
    /^(\s+healthcheck:\s*\n(?:\s+[^\s:]+:[^\n]*\n)*)\s+test:\s*\n((?:\s+- [^\n]+\n)+)/gm,
    (match, before, items) => {
      const itemLines = items
        .split("\n")
        .filter((l: string) => l.trim().startsWith("-"))
        .map((l: string) => {
          let item = l.trim().substring(1).trim();
          if (item.startsWith('"') && item.endsWith('"')) return item;
          if (item.includes(" ") || item.includes(":")) return `"${item}"`;
          return item;
        });
      return `${before}      test: [${itemLines.join(", ")}]\n`;
    }
  );

  // Ensure volumes are {} not null
  composeContent = composeContent.replace(/^(\s+\w+):\s*null\s*$/gm, "$1:");

  // Remove empty object syntax (: {}) and replace with just colon
  composeContent = composeContent.replace(/^(\s+\w+):\s*\{\}\s*$/gm, "$1:");

  // Add blank lines between services (only in services section, not volumes/networks)
  const lines = composeContent.split("\n");
  let inServicesSection = false;
  let firstService = true;
  const processedLines = lines.map((line, index) => {
    if (line.trim() === "services:") {
      inServicesSection = true;
      firstService = true;
      return line;
    }
    if (line.trim() === "volumes:" || line.trim() === "networks:") {
      inServicesSection = false;
      return line;
    }
    if (inServicesSection && /^  \w+:\s*$/.test(line)) {
      if (firstService) {
        firstService = false;
        return line;
      }
      return `\n${line}`;
    }
    return line;
  });
  composeContent = processedLines.join("\n");

  // Add blank lines between major sections
  composeContent = composeContent.replace(/^volumes:\s*$/gm, "\nvolumes:");
  composeContent = composeContent.replace(/^networks:\s*$/gm, "\nnetworks:");

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

  // Download compose file
  const composeContent = await sshExecStdout(`cat "${composeFile}"`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });

  // Parse YAML to object
  let composeConfig: DockerComposeConfig;
  try {
    composeConfig = yaml.parse(composeContent) as DockerComposeConfig;
    if (!composeConfig || typeof composeConfig !== "object") {
      throw new Error("Invalid docker-compose.yml structure");
    }
  } catch (error) {
    log.error(
      `Failed to parse docker-compose.yml: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }

  // Ensure services object exists
  if (!composeConfig.services) {
    composeConfig.services = {};
  }

  // Check if service already exists
  if (composeConfig.services[alias]) {
    log.warn(`Service '${alias}' already exists in docker-compose.yml`);
    process.exit(1);
  }

  log.info(
    `Adding ${serviceType} service '${alias}' to project '${projectName}' on VPS`
  );

  const serviceTypeLower = serviceType.toLowerCase();
  let serviceConfig: DockerComposeService;

  if (serviceTypeLower === "bun") {
    const appDir = `${composeHome}/${projectName}/apps/${alias}`;
    await sshExec(`mkdir -p "${appDir}"`, {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    });
    log.info(`Created app directory on VPS: ${appDir}`);
    serviceConfig = await getBunService(
      projectName,
      alias,
      composeHome,
      config
    );
  } else if (serviceTypeLower === "mysql") {
    serviceConfig = getMysqlService(alias);
  } else {
    log.error(`Unknown service type: ${serviceType}`);
    log.info("Supported types: bun, mysql");
    process.exit(1);
  }

  // Add service to config
  composeConfig.services[alias] = serviceConfig;

  // Ensure volumes section exists
  if (!composeConfig.volumes) {
    composeConfig.volumes = {};
  }

  // Ensure all existing volumes are empty objects, not null
  for (const volumeName in composeConfig.volumes) {
    if (
      composeConfig.volumes[volumeName] === null ||
      composeConfig.volumes[volumeName] === undefined
    ) {
      composeConfig.volumes[volumeName] = {};
    }
  }

  // Add volumes for MySQL if needed
  if (serviceTypeLower === "mysql") {
    composeConfig.volumes[`${alias}_data`] = {};
  }

  // Ensure networks section exists
  if (!composeConfig.networks) {
    composeConfig.networks = {
      default: {
        name: `${projectName}_network`,
      },
    };
  }

  // Create backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const backupFile = `/tmp/docker-compose.backup.${timestamp}.yml`;
  await sshExec(`cp "${composeFile}" "${backupFile}"`, {
    host: config.vpsHost,
    user: config.vpsUser,
    agentForward: true,
  });
  log.info(`Backup created on VPS at: ${backupFile}`);

  // Convert object back to YAML
  const preparedConfig = prepareConfigForYaml(composeConfig);

  let newContent = yaml.stringify(preparedConfig, {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    simpleKeys: false,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });

  // Same post-processing as initProject
  newContent = newContent.replace(
    /^(\s+command:\s*\n)((?:\s+- [^\n]+\n)+)/gm,
    (match, before, items) => {
      const itemLines = items
        .split("\n")
        .filter((l: string) => l.trim().startsWith("-"))
        .map((l: string) => {
          let item = l.trim().substring(1).trim();
          if (item.startsWith('"') && item.endsWith('"')) return item;
          if (item.includes(" ") || item.includes(":")) return `"${item}"`;
          return item;
        });
      const indent = before.match(/(\s+)command:/)?.[1] || "      ";
      return `${indent}command: [${itemLines.join(", ")}]\n`;
    }
  );

  newContent = newContent.replace(
    /^(\s+healthcheck:\s*\n(?:\s+[^\s:]+:[^\n]*\n)*)\s+test:\s*\n((?:\s+- [^\n]+\n)+)/gm,
    (match, before, items) => {
      const itemLines = items
        .split("\n")
        .filter((l: string) => l.trim().startsWith("-"))
        .map((l: string) => {
          let item = l.trim().substring(1).trim();
          if (item.startsWith('"') && item.endsWith('"')) return item;
          if (item.includes(" ") || item.includes(":")) return `"${item}"`;
          return item;
        });
      return `${before}      test: [${itemLines.join(", ")}]\n`;
    }
  );

  newContent = newContent.replace(/^(\s+\w+):\s*null\s*$/gm, "$1: {}");

  // Remove empty object syntax (: {}) and replace with just colon
  newContent = newContent.replace(/^(\s+\w+):\s*\{\}\s*$/gm, "$1:");

  // Add blank lines between services (only in services section, not volumes/networks)
  const lines = newContent.split("\n");
  let inServicesSection = false;
  let firstService = true;
  const processedLines = lines.map((line, index) => {
    if (line.trim() === "services:") {
      inServicesSection = true;
      firstService = true;
      return line;
    }
    if (line.trim() === "volumes:" || line.trim() === "networks:") {
      inServicesSection = false;
      return line;
    }
    if (inServicesSection && /^  \w+:\s*$/.test(line)) {
      if (firstService) {
        firstService = false;
        return line;
      }
      return `\n${line}`;
    }
    return line;
  });
  newContent = processedLines.join("\n");

  // Add blank lines between major sections
  newContent = newContent.replace(/^volumes:\s*$/gm, "\nvolumes:");
  newContent = newContent.replace(/^networks:\s*$/gm, "\nnetworks:");

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
 * Execute a command in a container
 */
async function execProject(
  projectName: string,
  alias: string,
  command: string,
  config: { vpsHost: string; vpsUser: string }
): Promise<void> {
  if (!projectName || !alias || !command) {
    log.error("Project name, container alias, and command are required");
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

  // Check if container is running
  const containerRunning = await sshExecQuiet(
    `cd "${projectDir}" && docker compose ps -q ${alias} | grep -q .`,
    {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    }
  );

  if (!containerRunning.success) {
    log.error(`Container '${alias}' is not running`);
    log.info(`Start it first with: bin/compose up ${projectName}`);
    process.exit(1);
  }

  // Try to fix permissions for Bun services before executing
  const isBunService = await sshExec(
    `grep -A 5 "^  ${alias}:" "${composeFile}" | grep -q "oven/bun"`,
    {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    }
  );

  log.info(
    `Executing command in container '${alias}' of project '${projectName}'`
  );

  // Execute command
  const result = await sshExec(
    `cd "${projectDir}" && docker compose exec -T ${alias} ${command}`,
    {
      host: config.vpsHost,
      user: config.vpsUser,
      agentForward: true,
    }
  );

  if (result.stdout) {
    log.raw(result.stdout);
  }
  if (result.stderr) {
    log.raw(result.stderr);
  }

  // Exit with the same code as the command
  if (!result.success) {
    process.exit(result.exitCode ?? 1);
  }
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
 * Main compose function
 */
async function compose(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    usage();
    return;
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

      case "exec":
        if (commandArgs.length < 3) {
          log.error("Project name, container alias, and command required");
          usage();
        }
        // Join all remaining args as the command to execute
        const execCommand = commandArgs.slice(2).join(" ");
        await execProject(commandArgs[0], commandArgs[1], execCommand, config);
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

// Run compose command
compose().catch((error) => {
  log.error(
    `Compose command failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
});
