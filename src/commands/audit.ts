#!/usr/bin/env bun
import { loadVPSConfig, getConfigWithOverrides } from "../lib/config";
import { log } from "../lib/logger";
import { sshExec, filterMOTDFromOutput } from "../lib/ssh";
import type { AuditResults, SSHConfig, ExposedPort } from "../lib/types";

/**
 * Parse SSH configuration from remote script output
 * The remote script outputs lines like "PERMIT_ROOT=no"
 */
function parseSSHConfig(output: string): SSHConfig {
  const config: Partial<SSHConfig> = {};

  // Parse lines like "PERMIT_ROOT=no"
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("PERMIT_ROOT=")) {
      config.permitRootLogin = trimmed.split("=")[1] || "unknown";
    } else if (trimmed.startsWith("PASSWORD_AUTH=")) {
      config.passwordAuthentication = trimmed.split("=")[1] || "unknown";
    } else if (trimmed.startsWith("CHALLENGE_RESP=")) {
      // Handle empty string - if value is empty, treat as "no" (disabled)
      const value = trimmed.split("=")[1] || "";
      config.challengeResponseAuthentication = value === "" ? "no" : value;
    } else if (trimmed.startsWith("ALLOW_USERS=")) {
      config.allowUsers = trimmed.split("=").slice(1).join("=") || "not set";
    } else if (trimmed.startsWith("USE_DNS=")) {
      config.useDNS = trimmed.split("=")[1] || "unknown";
    }
  }

  return {
    permitRootLogin: config.permitRootLogin || "unknown",
    passwordAuthentication: config.passwordAuthentication || "unknown",
    challengeResponseAuthentication:
      config.challengeResponseAuthentication || "no",
    allowUsers: config.allowUsers || "not set",
    useDNS: config.useDNS || "unknown",
  };
}

/**
 * Parse listening ports from ss output
 */
function parseListeningPorts(ssOutput: string): {
  allPorts: Array<{
    protocol: string;
    port: string;
    process?: string;
    bind: string;
  }>;
  exposedPorts: ExposedPort[];
} {
  const lines = ssOutput.split("\n");
  const allPorts: Array<{
    protocol: string;
    port: string;
    process?: string;
    bind: string;
  }> = [];
  const exposedPorts: ExposedPort[] = [];
  const exposedMap = new Map<string, ExposedPort>();

  for (const line of lines) {
    if (!line.includes("LISTEN")) continue;

    // Extract protocol (usually first field)
    const parts = line.trim().split(/\s+/);
    let protocol = "TCP";
    if (parts[0]?.toLowerCase().startsWith("tcp")) {
      protocol = "TCP";
    } else if (parts[0]?.toLowerCase().startsWith("udp")) {
      protocol = "UDP";
    }

    // Find address:port pattern
    const addrPortMatch = line.match(
      /(?:^|\s)([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+|\[?::\]?:[0-9]+|\[::1\]:[0-9]+|::1:[0-9]+|\*:[0-9]+)/
    );
    if (!addrPortMatch) continue;

    const addrPort = addrPortMatch[1] ?? "";
    let bindAddr = "";
    let port = "";

    // Parse IPv4
    if (addrPort.match(/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$/)) {
      const [addr, p] = addrPort.split(":");
      bindAddr = addr ?? "";
      port = p ?? "";
    }
    // Parse IPv6 [::]:port or :::port
    else if (addrPort.match(/^\[::\]:[0-9]+$/)) {
      bindAddr = "::";
      port = addrPort.slice(5);
    } else if (addrPort.match(/^:::[0-9]+$/)) {
      bindAddr = "::";
      port = addrPort.slice(3);
    }
    // Parse IPv6 [::1]:port or ::1:port (localhost)
    else if (addrPort.match(/^\[::1\]:[0-9]+$/)) {
      bindAddr = "::1";
      port = addrPort.slice(6);
    } else if (addrPort.match(/^::1:[0-9]+$/)) {
      bindAddr = "::1";
      port = addrPort.slice(5);
    }
    // Parse wildcard *:port
    else if (addrPort.match(/^\*:[0-9]+$/)) {
      bindAddr = "*";
      port = addrPort.slice(2);
    }

    if (!port) continue;

    // Extract process name
    const processMatch = line.match(/users:\(\("([^"]+)"/);
    const process = processMatch ? processMatch[1] : undefined;

    const portInfo = {
      protocol,
      port,
      process,
      bind: bindAddr,
    };

    allPorts.push(portInfo);

    // Check if exposed (not localhost-only)
    const isExposed =
      bindAddr === "0.0.0.0" || bindAddr === "::" || bindAddr === "*";
    const isLocalhost = bindAddr === "127.0.0.1" || bindAddr === "::1";
    const portNum = parseInt(port, 10);
    const isExpectedPort = portNum === 22 || portNum === 53 || portNum === 123;

    if (isExposed && !isLocalhost && !isExpectedPort) {
      const key = `${protocol}:${port}`;
      if (!exposedMap.has(key)) {
        exposedMap.set(key, {
          protocol: protocol as "TCP" | "UDP",
          port: portNum,
          process,
          bindAddress: bindAddr,
        });
      }
    }
  }

  return {
    allPorts,
    exposedPorts: Array.from(exposedMap.values()),
  };
}

/**
 * Main audit function
 */
async function runAudit(user?: string, host?: string): Promise<void> {
  // Load config and allow command-line overrides
  const baseConfig = await loadVPSConfig();
  const config = getConfigWithOverrides(baseConfig, {
    vpsUser: user || baseConfig.vpsUser,
    vpsHost: host || baseConfig.vpsHost,
  });

  if (!config.vpsUser || !config.vpsHost) {
    log.error(
      "SSH user and host are required. Set VPS_USER and VPS_HOST in .env or pass as arguments."
    );
    process.exit(1);
  }

  const results: AuditResults = {
    passed: 0,
    failed: 0,
    warnings: 0,
    passedItems: [],
    failedItems: [],
    warnedItems: [],
  };

  const checkPass = (message: string) => {
    log.ok(message);
    results.passed++;
    results.passedItems.push(message);
  };

  const checkFail = (message: string) => {
    log.fail(message);
    results.failed++;
    results.failedItems.push(message);
  };

  const checkWarn = (message: string) => {
    log.warn(message);
    results.warnings++;
    results.warnedItems.push(message);
  };

  log.info(`Auditing ${config.vpsUser}@${config.vpsHost}`);
  log.blank();

  // ======================
  // SSH CONNECTIVITY
  // ======================
  log.info("Testing SSH connectivity...");
  try {
    const testResult = await sshExec("echo OK", {
      host: config.vpsHost,
      user: config.vpsUser,
      batchMode: true,
      connectTimeout: 5,
      quiet: true,
    });

    if (testResult.success) {
      checkPass("SSH connection successful");
    } else {
      checkFail(`Cannot SSH into ${config.vpsUser}@${config.vpsHost}`);
      process.exit(1);
    }
  } catch (error) {
    checkFail(`Cannot SSH into ${config.vpsUser}@${config.vpsHost}`);
    process.exit(1);
  }
  log.blank();

  // ======================
  // SSH HARDENING CHECK
  // ======================
  log.info("Checking SSH hardening...");
  const sshCheckScript = `
set -e
SSHD_CONF=$(sudo sshd -T 2>/dev/null || echo "")

if [ -z "$SSHD_CONF" ]; then
  echo "ERROR: Could not get SSH config"
  exit 1
fi

PERMIT_ROOT=$(echo "$SSHD_CONF" | grep -i "^permitrootlogin" | awk '{print $2}' || echo "unknown")
PASSWORD_AUTH=$(echo "$SSHD_CONF" | grep -i "^passwordauthentication" | awk '{print $2}' || echo "unknown")
CHALLENGE_RESP=$(echo "$SSHD_CONF" | grep -i "^challengeresponseauthentication" | awk '{print $2}' || echo "unknown")
ALLOW_USERS=$(echo "$SSHD_CONF" | grep -i "^allowusers" | awk '{print $2}' || echo "not set")
USE_DNS=$(echo "$SSHD_CONF" | grep -i "^usedns" | awk '{print $2}' || echo "unknown")

echo "PERMIT_ROOT=$PERMIT_ROOT"
echo "PASSWORD_AUTH=$PASSWORD_AUTH"
echo "CHALLENGE_RESP=$CHALLENGE_RESP"
echo "ALLOW_USERS=$ALLOW_USERS"
echo "USE_DNS=$USE_DNS"
`;

  try {
    const sshCheckResult = await sshExec(sshCheckScript, {
      host: config.vpsHost,
      user: config.vpsUser,
    });

    if (!sshCheckResult.success) {
      checkFail("Could not retrieve SSH configuration");
      log.blank();
    } else {
      const sshConfig = parseSSHConfig(sshCheckResult.stdout);

      log.raw(`PermitRootLogin: ${sshConfig.permitRootLogin}`);
      if (sshConfig.permitRootLogin.toLowerCase() === "no") {
        checkPass("Root login disabled");
      } else {
        checkFail("Root login is enabled (should be 'no')");
      }

      log.raw(`PasswordAuthentication: ${sshConfig.passwordAuthentication}`);
      if (sshConfig.passwordAuthentication.toLowerCase() === "no") {
        checkPass("Password authentication disabled");
      } else {
        checkFail("Password authentication enabled (should be 'no')");
      }

      log.raw(
        `ChallengeResponseAuthentication: ${
          sshConfig.challengeResponseAuthentication || "(empty/disabled)"
        }`
      );
      if (
        sshConfig.challengeResponseAuthentication.toLowerCase() === "no" ||
        sshConfig.challengeResponseAuthentication === ""
      ) {
        checkPass("Challenge-response authentication disabled");
      } else {
        checkWarn("Challenge-response authentication enabled (should be 'no')");
      }

      log.raw(`AllowUsers: ${sshConfig.allowUsers}`);
      if (sshConfig.allowUsers === config.vpsUser) {
        checkPass(`AllowUsers restricts access to ${config.vpsUser}`);
      } else if (sshConfig.allowUsers === "not set") {
        checkWarn("AllowUsers not configured");
      } else {
        checkWarn(`AllowUsers set to: ${sshConfig.allowUsers}`);
      }

      log.raw(`UseDNS: ${sshConfig.useDNS}`);
      if (sshConfig.useDNS.toLowerCase() === "no") {
        checkPass("UseDNS disabled (faster connections)");
      } else {
        checkWarn("UseDNS enabled (may slow connections)");
      }
    }
  } catch (error) {
    checkFail("Could not retrieve SSH configuration");
  }
  log.blank();

  // ======================
  // FIREWALL STATUS
  // ======================
  log.info("Checking firewall (ufw)...");
  try {
    const ufwResult = await sshExec(
      'sudo ufw status verbose 2>/dev/null || echo ""',
      {
        host: config.vpsHost,
        user: config.vpsUser,
      }
    );

    let ufwStatus = ufwResult.stdout;

    // Filter MOTD: find where actual UFW output starts (look for "Status:")
    const originalOutput = ufwStatus;
    ufwStatus = filterMOTDFromOutput(ufwStatus, "Status:");

    // Always show UFW status output for debugging
    if (ufwStatus.trim()) {
      log.raw(ufwStatus);
    } else {
      log.warn("UFW command returned no output");
      // Show raw output for debugging
      if (originalOutput.trim()) {
        log.raw("Raw output (before filtering):");
        log.raw(originalOutput);
      }
    }

    // Additional diagnostic: check if UFW is installed and service status
    const ufwServiceResult = await sshExec(
      'systemctl is-active ufw 2>/dev/null || echo "inactive"',
      {
        host: config.vpsHost,
        user: config.vpsUser,
      }
    );
    const ufwEnabledResult = await sshExec(
      'systemctl is-enabled ufw 2>/dev/null || echo "disabled"',
      {
        host: config.vpsHost,
        user: config.vpsUser,
      }
    );

    log.raw(`UFW service status: ${ufwServiceResult.stdout.trim()}`);
    log.raw(`UFW enabled on boot: ${ufwEnabledResult.stdout.trim()}`);

    // More robust check: case-insensitive and handle whitespace
    const ufwStatusLower = ufwStatus.toLowerCase();
    const isActive =
      ufwStatusLower.includes("status: active") ||
      ufwStatusLower.includes("status:active") ||
      ufwStatusLower.match(/status:\s*active/i);

    if (isActive) {
      checkPass("UFW firewall is active");
      if (ufwStatusLower.includes("openssh")) {
        checkPass("OpenSSH allowed in firewall");
      } else {
        checkFail("OpenSSH not explicitly allowed in firewall");
      }
    } else {
      checkFail("UFW firewall is NOT active");
      // Show helpful message about how to enable it
      log.info("To enable UFW, run on the VPS: sudo ufw enable");
      log.info("Make sure to allow SSH first: sudo ufw allow OpenSSH");
      // Debug: show what we're checking
      log.raw(`Debug: Checking for "Status: active" in output`);
      log.raw(`Debug: Filtered output length: ${ufwStatus.length}`);
      log.raw(`Debug: First 100 chars: ${ufwStatus.substring(0, 100)}`);
    }
  } catch (error) {
    checkFail("Could not check firewall status");
  }
  log.blank();

  // ======================
  // FAIL2BAN STATUS
  // ======================
  log.info("Checking Fail2Ban...");
  const fail2banScript = `
if systemctl is-active --quiet fail2ban 2>/dev/null; then
  echo "ACTIVE"
  echo "===FAIL2BAN_OUTPUT_START==="
  sudo fail2ban-client status sshd 2>/dev/null || echo "NO_JAIL"
  echo "===FAIL2BAN_OUTPUT_END==="
else
  echo "INACTIVE"
fi
`;

  try {
    const fail2banResult = await sshExec(fail2banScript, {
      host: config.vpsHost,
      user: config.vpsUser,
    });

    const fail2banStatus = fail2banResult.stdout;
    if (fail2banStatus.includes("ACTIVE")) {
      checkPass("Fail2Ban is running");
      // Extract output between markers
      const startMarker = "===FAIL2BAN_OUTPUT_START===";
      const endMarker = "===FAIL2BAN_OUTPUT_END===";
      const startIdx = fail2banStatus.indexOf(startMarker);
      const endIdx = fail2banStatus.indexOf(endMarker);
      if (startIdx !== -1 && endIdx !== -1) {
        const output = fail2banStatus
          .slice(startIdx + startMarker.length, endIdx)
          .split("\n")
          .filter((line) => line.trim() && !line.includes("==="))
          .join("\n");
        if (output) log.raw(output);
      }
      if (fail2banStatus.includes("NO_JAIL")) {
        checkWarn("Fail2Ban active but sshd jail not configured");
      }
    } else {
      checkFail("Fail2Ban is NOT running");
    }
  } catch (error) {
    checkFail("Could not check Fail2Ban status");
  }
  log.blank();

  // ======================
  // UNATTENDED UPGRADES
  // ======================
  log.info("Checking unattended upgrades...");
  const unattendedScript = `
if systemctl is-enabled --quiet unattended-upgrades 2>/dev/null; then
  echo "ENABLED"
  if systemctl is-active --quiet unattended-upgrades 2>/dev/null; then
    echo "ACTIVE"
  fi
else
  echo "DISABLED"
fi
`;

  try {
    const unattendedResult = await sshExec(unattendedScript, {
      host: config.vpsHost,
      user: config.vpsUser,
    });

    const unattendedStatus = unattendedResult.stdout;
    if (unattendedStatus.includes("ENABLED")) {
      checkPass("Unattended upgrades enabled");
      if (unattendedStatus.includes("ACTIVE")) {
        checkPass("Unattended upgrades service active");
      } else {
        checkWarn("Unattended upgrades enabled but service not active");
      }
    } else {
      checkFail("Unattended upgrades NOT enabled");
    }
  } catch (error) {
    checkFail("Could not check unattended upgrades status");
  }
  log.blank();

  // ======================
  // SYSTEM UPDATES
  // ======================
  log.info("Checking for available security updates...");
  try {
    const updateResult = await sshExec(
      'apt list --upgradable 2>/dev/null | grep -c "security" || echo "0"',
      {
        host: config.vpsHost,
        user: config.vpsUser,
      }
    );

    // The output should be just a number (line count from grep -c)
    // Extract only the first number found, ignoring any other text
    const output = updateResult.stdout.trim();
    const numberMatch = output.match(/^\d+/);
    const updateCount = numberMatch ? parseInt(numberMatch[0], 10) : 0;

    if (updateCount === 0) {
      checkPass("No pending security updates");
    } else {
      checkWarn(`${updateCount} security update(s) available`);
    }
  } catch (error) {
    checkWarn("Could not check for security updates");
  }
  log.blank();

  // ======================
  // DOCKER SECURITY
  // ======================
  log.info("Checking Docker security...");
  const dockerScript = `
if command -v docker >/dev/null 2>&1; then
  echo "INSTALLED"
  docker version --format '{{.Server.Version}}' 2>/dev/null | head -1 || echo "ERROR"
  
  if [ -f /etc/docker/daemon.json ]; then
    echo "DAEMON_JSON_EXISTS"
    cat /etc/docker/daemon.json
  else
    echo "NO_DAEMON_JSON"
  fi
  
  if docker info 2>/dev/null | grep -q "userns"; then
    echo "USERNS_ENABLED"
  else
    echo "USERNS_DISABLED"
  fi
else
  echo "NOT_INSTALLED"
fi
`;

  try {
    const dockerResult = await sshExec(dockerScript, {
      host: config.vpsHost,
      user: config.vpsUser,
    });

    const dockerOutput = dockerResult.stdout;
    if (dockerOutput.includes("INSTALLED")) {
      // Extract Docker version
      const versionMatch = dockerOutput.match(/^(\d+\.\d+\.\d+)/m);
      if (versionMatch && versionMatch[1] !== "ERROR") {
        checkPass(`Docker installed (version: ${versionMatch[1]})`);
      } else {
        checkPass("Docker installed");
      }

      if (dockerOutput.includes("DAEMON_JSON_EXISTS")) {
        checkPass("Docker daemon.json exists");
        const daemonJsonStart = dockerOutput.indexOf("DAEMON_JSON_EXISTS");
        const daemonJsonEnd = dockerOutput.indexOf(
          "NO_DAEMON_JSON",
          daemonJsonStart
        );
        const daemonJson = dockerOutput
          .slice(
            daemonJsonStart + "DAEMON_JSON_EXISTS".length,
            daemonJsonEnd !== -1 ? daemonJsonEnd : undefined
          )
          .split("\n")
          .slice(0, 5)
          .join("\n")
          .trim();
        if (daemonJson) log.raw(daemonJson);

        if (dockerOutput.includes("userns-remap")) {
          checkPass("Docker user namespace remap configured");
        } else {
          checkWarn(
            "Docker user namespace remap not configured in daemon.json"
          );
        }

        if (dockerOutput.includes("log-driver")) {
          checkPass("Docker log driver configured");
        } else {
          checkWarn("Docker log driver not configured");
        }
      } else {
        checkWarn("Docker daemon.json not found");
      }

      if (dockerOutput.includes("USERNS_ENABLED")) {
        checkPass("Docker user namespace remap active");
      } else if (dockerOutput.includes("USERNS_DISABLED")) {
        checkWarn("Docker user namespace remap not active");
      }

      // Check if user is in docker group
      const groupsResult = await sshExec("groups", {
        host: config.vpsHost,
        user: config.vpsUser,
        quiet: true,
      });

      if (groupsResult.stdout.includes("docker")) {
        checkPass(`User ${config.vpsUser} is in docker group`);
      } else {
        checkWarn(`User ${config.vpsUser} is NOT in docker group`);
      }
    } else {
      checkWarn("Docker not installed");
    }
  } catch (error) {
    checkWarn("Could not check Docker status");
  }
  log.blank();

  // ======================
  // TIMEZONE & NTP
  // ======================
  log.info("Checking timezone and NTP...");
  const timezoneScript = `
timedatectl show --property=Timezone --value 2>/dev/null || echo "unknown"
systemctl is-active --quiet ntp 2>/dev/null && echo "NTP_ACTIVE" || echo "NTP_INACTIVE"
`;

  try {
    const timezoneResult = await sshExec(timezoneScript, {
      host: config.vpsHost,
      user: config.vpsUser,
    });

    const timezoneOutput = timezoneResult.stdout;
    const timezoneMatch = timezoneOutput.match(/^([A-Za-z]+\/[A-Za-z_]+)$/m);
    const timezone = timezoneMatch ? timezoneMatch[1] : "unknown";

    if (timezone !== "unknown" && timezone) {
      checkPass(`Timezone configured: ${timezone}`);
    } else {
      checkWarn("Timezone not configured");
    }

    if (timezoneOutput.includes("NTP_ACTIVE")) {
      checkPass("NTP service active");
    } else {
      checkWarn("NTP service not active");
    }
  } catch (error) {
    checkWarn("Could not check timezone and NTP status");
  }
  log.blank();

  // ======================
  // SYSTEM EXPOSURE CHECKS
  // ======================
  log.info("Checking for listening services...");
  try {
    const listeningResult = await sshExec(
      'sudo ss -tlnpen 2>/dev/null || echo ""',
      {
        host: config.vpsHost,
        user: config.vpsUser,
      }
    );

    const listening = listeningResult.stdout;
    if (listening.trim()) {
      const { allPorts, exposedPorts } = parseListeningPorts(listening);

      log.info("Open ports:");
      if (allPorts.length > 0) {
        // Sort by port number
        const sorted = allPorts.sort(
          (a, b) => parseInt(a.port, 10) - parseInt(b.port, 10)
        );
        for (const portInfo of sorted) {
          const processStr = portInfo.process ? ` (${portInfo.process})` : "";
          log.raw(
            `  ${portInfo.protocol}:${portInfo.port}${processStr} [bind:${portInfo.bind}]`
          );
        }
      } else {
        log.raw("  (none found)");
      }
      log.blank();

      if (exposedPorts.length === 0) {
        checkPass(
          "Only SSH and essential system services (DNS, NTP) are exposed to all interfaces"
        );
      } else {
        const exposedList = exposedPorts
          .map((p) => {
            const processStr = p.process ? ` (${p.process})` : "";
            return `    - ${p.protocol}:${p.port}${processStr}`;
          })
          .join("\n");
        checkWarn(
          `${exposedPorts.length} internet-accessible service(s) listening on ports:\n${exposedList}`
        );
      }
    } else {
      checkWarn("Could not retrieve listening services");
    }
  } catch (error) {
    checkWarn("Could not retrieve listening services");
  }
  log.blank();

  // ======================
  // SUMMARY
  // ======================
  log.separator();
  log.summary("Security audit completed");
  log.separator();
  log.raw(`✔ Passed:  ${results.passed}`);
  log.raw(`✗ Failed:  ${results.failed}`);
  log.raw(`⚠ Warnings: ${results.warnings}`);
  log.blank();

  if (results.passed > 0) {
    log.passed();
    for (const item of results.passedItems) {
      log.checkmark(item);
    }
    log.blank();
  }

  if (results.failed > 0) {
    log.failures();
    for (const item of results.failedItems) {
      log.cross(item);
    }
    log.blank();
  }

  if (results.warnings > 0) {
    log.warnings();
    for (const item of results.warnedItems) {
      log.warningMark(item);
    }
    log.blank();
  }

  if (results.failed === 0 && results.warnings === 0) {
    log.success("All security checks passed!");
    process.exit(0);
  } else if (results.failed === 0) {
    log.info("All critical checks passed, but some warnings to review.");
    process.exit(0);
  } else {
    log.alert("Some security checks failed. Please review and fix.");
    process.exit(1);
  }
}

// Main entry point
const args = process.argv.slice(2);
const user = args[0];
const host = args[1];

runAudit(user, host).catch((error) => {
  log.error(`Audit failed: ${error.message}`);
  process.exit(1);
});
