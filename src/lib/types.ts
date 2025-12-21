/**
 * VPS Configuration loaded from .env file
 */
export interface VPSConfig {
  vpsHost: string;
  vpsUser: string;
  vpsHostname?: string;
  vpsTimezone?: string;
  vpsSshPubkey?: string;
}

/**
 * SSH execution options
 */
export interface SSHOptions {
  host: string;
  user: string;
  agentForward?: boolean;
  quiet?: boolean;
  batchMode?: boolean;
  connectTimeout?: number;
  additionalOpts?: string[];
}

/**
 * SSH command result
 */
export interface SSHResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Audit check result types
 */
export type AuditCheckType = "pass" | "fail" | "warn";

/**
 * Individual audit check item
 */
export interface AuditCheck {
  type: AuditCheckType;
  message: string;
}

/**
 * Complete audit results
 */
export interface AuditResults {
  passed: number;
  failed: number;
  warnings: number;
  passedItems: string[];
  failedItems: string[];
  warnedItems: string[];
}

/**
 * SSH configuration values (from sshd -T)
 */
export interface SSHConfig {
  permitRootLogin: string;
  passwordAuthentication: string;
  challengeResponseAuthentication: string;
  allowUsers: string;
  useDNS: string;
}

/**
 * Docker Compose service types
 */
export type ServiceType = "bun" | "mysql";

/**
 * Docker Compose service configuration
 */
export interface ComposeService {
  alias: string;
  type: ServiceType;
  projectName: string;
}

/**
 * Docker Compose project information
 */
export interface ComposeProject {
  name: string;
  directory: string;
  composeFile: string;
}

/**
 * Provisioning configuration
 */
export interface ProvisionConfig {
  username: string;
  hostname: string;
  timezone: string;
}

/**
 * Exposed port information (from audit)
 */
export interface ExposedPort {
  protocol: "TCP" | "UDP";
  port: number;
  process?: string;
  bindAddress: string;
}
