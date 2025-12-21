import { sshExecStdout, filterMOTDFromOutput } from "./ssh.js";

// Cache for remote HOME directory
let composeHomeCache: string | null = null;

/**
 * Get remote HOME directory (cached after first call)
 */
export async function getComposeHome(config: {
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
