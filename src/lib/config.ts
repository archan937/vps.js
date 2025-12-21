import { type VPSConfig, type ProvisionConfig } from "./types.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Load and parse .env file
 */
async function loadEnvFile(envPath: string): Promise<Record<string, string>> {
  try {
    const file = Bun.file(envPath);
    if (!(await file.exists())) {
      return {};
    }

    const content = await file.text();
    const env: Record<string, string> = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      // Parse KEY=VALUE format
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match?.[1] && match?.[2]) {
        const key = match[1].trim();
        let value = match[2].trim();

        // Remove quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        env[key] = value;
      }
    }

    return env;
  } catch (error) {
    // If file doesn't exist or can't be read, return empty object
    return {};
  }
}

/**
 * Find .env file in common locations
 */
function findEnvFile(): string {
  // Try to find .env relative to the bin directory (where executables are)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // If we're in src/lib/, go up to project root, then to bin/
  const projectRoot = join(__dirname, "..", "..");
  const binEnvPath = join(projectRoot, "bin", ".env");

  return binEnvPath;
}

/**
 * Load VPS configuration from .env file and environment variables
 * Environment variables take precedence over .env file values
 */
export async function loadVPSConfig(): Promise<VPSConfig> {
  const envFile = findEnvFile();
  const fileEnv = await loadEnvFile(envFile);

  // Merge: file env first, then process.env (process.env takes precedence)
  const env = {
    ...fileEnv,
    ...process.env,
  };

  const config: VPSConfig = {
    vpsHost: env.VPS_HOST || "",
    vpsUser: env.VPS_USER || "",
    vpsHostname: env.VPS_HOSTNAME,
    vpsTimezone: env.VPS_TIMEZONE,
    vpsSshPubkey: env.VPS_SSH_PUBKEY,
  };

  return config;
}

/**
 * Validate that required VPS config fields are present
 */
export function validateVPSConfig(
  config: VPSConfig,
  required: Array<keyof VPSConfig> = ["vpsHost", "vpsUser"]
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const field of required) {
    const value = config[field];
    if (!value || (typeof value === "string" && value.trim() === "")) {
      missing.push(field);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Load and validate VPS config, throwing if required fields are missing
 */
export async function loadAndValidateVPSConfig(
  required: Array<keyof VPSConfig> = ["vpsHost", "vpsUser"]
): Promise<VPSConfig> {
  const config = await loadVPSConfig();
  const validation = validateVPSConfig(config, required);

  if (!validation.valid) {
    const envVarNames = validation.missing.map((field) => {
      // Convert camelCase to UPPER_SNAKE_CASE
      return field
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase()
        .replace(/^_/, "");
    });

    throw new Error(
      `Missing required configuration: ${envVarNames.join(", ")}. ` +
        `Set them in bin/.env or as environment variables.`
    );
  }

  return config;
}

/**
 * Load provisioning-specific configuration
 */
export async function loadProvisionConfig(): Promise<
  ProvisionConfig & { vpsHost: string; vpsSshPubkey: string }
> {
  const config = await loadAndValidateVPSConfig([
    "vpsHost",
    "vpsUser",
    "vpsHostname",
    "vpsTimezone",
  ]);

  if (!config.vpsHostname || !config.vpsTimezone) {
    throw new Error(
      "VPS_HOSTNAME and VPS_TIMEZONE are required for provisioning. " +
        "Set them in bin/.env or as environment variables."
    );
  }

  if (!config.vpsSshPubkey) {
    throw new Error(
      "VPS_SSH_PUBKEY is required for provisioning. " +
        "Set it in bin/.env or as environment variables."
    );
  }

  return {
    vpsHost: config.vpsHost,
    username: config.vpsUser,
    hostname: config.vpsHostname,
    timezone: config.vpsTimezone,
    vpsSshPubkey: config.vpsSshPubkey,
  };
}

/**
 * Get config with optional overrides (useful for audit command)
 */
export function getConfigWithOverrides(
  config: VPSConfig,
  overrides: Partial<Pick<VPSConfig, "vpsHost" | "vpsUser">>
): VPSConfig {
  return {
    ...config,
    ...overrides,
  };
}
