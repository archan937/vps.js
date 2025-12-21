import type { SSHOptions, SSHResult } from "./types.js";

/**
 * Build SSH command arguments from options
 */
function buildSSHArgs(options: SSHOptions): string[] {
  const args: string[] = [];

  // Base SSH options (matching audit script defaults)
  args.push("-o", "LogLevel=ERROR");
  args.push("-o", "StrictHostKeyChecking=no");
  args.push("-o", "UserKnownHostsFile=/dev/null");

  // Disable pseudo-terminal allocation to suppress MOTD and interactive prompts
  args.push("-T");

  // Quiet mode - suppresses MOTD, banners, and most informational messages
  // This is the standard SSH way to run non-interactive commands cleanly
  args.push("-q");

  // Agent forwarding (for compose script)
  if (options.agentForward) {
    args.push("-A");
  }

  // Batch mode (non-interactive, no password prompts)
  if (options.batchMode) {
    args.push("-o", "BatchMode=yes");
  }

  // Connect timeout
  if (options.connectTimeout) {
    args.push("-o", `ConnectTimeout=${options.connectTimeout}`);
  }

  // Additional options
  if (options.additionalOpts) {
    args.push(...options.additionalOpts);
  }

  // Target host
  args.push(`${options.user}@${options.host}`);

  return args;
}

/**
 * Execute SSH command on remote host
 *
 * @param command - Command to execute (can be a string or array of strings for shell script)
 * @param options - SSH connection options
 * @returns Promise resolving to SSHResult with stdout, stderr, exitCode, and success
 */
export async function sshExec(
  command: string | string[],
  options: SSHOptions,
  stdinContent?: string
): Promise<SSHResult> {
  const sshArgs = buildSSHArgs(options);

  // If command is an array, join with newlines (for multi-line scripts)
  const commandStr = Array.isArray(command) ? command.join("\n") : command;

  try {
    // Always pass command as argument to SSH
    const proc = Bun.spawn(["ssh", ...sshArgs, commandStr], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Write content to stdin if provided
    if (stdinContent !== undefined) {
      proc.stdin.write(stdinContent);
    }
    proc.stdin.end();

    // Wait for process to complete
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
      success: exitCode === 0,
    };
  } catch (error) {
    // Handle spawn errors
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      success: false,
    };
  }
}

/**
 * Execute SSH command quietly (suppress output)
 * Useful for checking if something exists or succeeds without output
 */
export async function sshExecQuiet(
  command: string | string[],
  options: SSHOptions
): Promise<SSHResult> {
  const quietOptions = { ...options, quiet: true };
  return sshExec(command, quietOptions);
}

/**
 * Execute SSH command and return only stdout (throw on error)
 * Useful when you need the output and want to fail fast on errors
 */
export async function sshExecStdout(
  command: string | string[],
  options: SSHOptions
): Promise<string> {
  const result = await sshExec(command, options);
  if (!result.success) {
    throw new Error(`SSH command failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Check if SSH connection is possible
 */
export async function sshTestConnection(options: SSHOptions): Promise<boolean> {
  const result = await sshExec("echo OK", {
    ...options,
    batchMode: true,
    connectTimeout: 5,
    quiet: true,
  });
  return result.success && result.stdout.trim() === "OK";
}

/**
 * Filter MOTD from SSH output by finding where actual command output starts
 * For simple commands like "echo $HOME", take the last line that looks like output
 */
export function filterMOTDFromOutput(
  output: string,
  outputMarker?: string
): string {
  if (outputMarker) {
    // If we know what the output should start with (like "Status:"), find it
    const markerIndex = output.indexOf(outputMarker);
    if (markerIndex !== -1) {
      return output.slice(markerIndex);
    }
  }

  // For simple outputs, take the last non-empty line (command output comes after MOTD)
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l);
  if (lines.length > 0) {
    // Return the last line (actual command output)
    return lines[lines.length - 1] ?? "";
  }

  return output.trim();
}
