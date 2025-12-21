#!/usr/bin/env bun
import { loadProvisionConfig } from "../lib/config.js";
import { log } from "../lib/logger.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { existsSync } from "fs";

/**
 * Main provisioning function
 */
async function provision(): Promise<void> {
  const config = await loadProvisionConfig();

  if (!config.vpsSshPubkey) {
    log.error("VPS_SSH_PUBKEY is required. Set VPS_SSH_PUBKEY in .env file.");
    process.exit(1);
  }

  log.info(`Connecting to VPS: ${config.vpsHost}`);
  log.info("Executing provisioning script on VPS...");

  // Find provision-remote.sh script in the same directory
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const remoteScriptPath = join(__dirname, "provision-remote.sh");

  // Check if remote script exists
  const remoteScriptFile = Bun.file(remoteScriptPath);
  if (!(await remoteScriptFile.exists())) {
    log.error(`Provisioning script not found: ${remoteScriptPath}`);
    process.exit(1);
  }

  // Read the remote script
  const remoteScript = await remoteScriptFile.text();

  // Copy SSH key to root
  log.info("Copying SSH key to root...");

  // Expand ~ to home directory
  let sshKeyPath = config.vpsSshPubkey;
  if (sshKeyPath.startsWith("~/")) {
    sshKeyPath = join(homedir(), sshKeyPath.slice(2));
  } else if (sshKeyPath === "~") {
    sshKeyPath = homedir();
  }

  // Check if the SSH key file exists
  if (!existsSync(sshKeyPath)) {
    log.error(`SSH public key file not found: ${sshKeyPath}`);
    log.error(`Original path from config: ${config.vpsSshPubkey}`);
    process.exit(1);
  }

  const sshCopyId = Bun.spawn(
    ["ssh-copy-id", "-i", sshKeyPath, `root@${config.vpsHost}`],
    {
      stdout: "inherit",
      stderr: "inherit",
    }
  );

  const sshCopyIdExitCode = await sshCopyId.exited;
  if (sshCopyIdExitCode !== 0) {
    log.error("Failed to copy SSH key to root");
    process.exit(1);
  }

  // Execute remote script with environment variables
  const envVars = `VPS_USER=${config.username} VPS_HOSTNAME=${config.hostname} VPS_TIMEZONE=${config.timezone}`;
  const sshCommand = `${envVars} bash -s`;

  log.info("Executing provisioning script on remote server...");

  const ssh = Bun.spawn(["ssh", `root@${config.vpsHost}`, sshCommand], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });

  ssh.stdin.write(remoteScript);
  ssh.stdin.end();

  const exitCode = await ssh.exited;
  if (exitCode !== 0) {
    log.error("Provisioning failed");
    process.exit(1);
  }
}

// Run provisioning
provision().catch((error) => {
  log.error(
    `Provisioning failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
});
