#!/usr/bin/env bun

/**
 * Main CLI entry point for vps.js
 * Routes subcommands to their respective command handlers
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: vps <command> [arguments]");
    console.error("\nAvailable commands:");
    console.error("  git        Git repository management");
    console.error("  audit      Security audit");
    console.error("  compose    Docker Compose management");
    console.error("  provision  Provision a new VPS");
    process.exit(1);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  const originalArgv = process.argv;
  process.argv = [process.argv[0], process.argv[1], ...commandArgs];

  try {
    switch (command) {
      case "git":
        await import("./src/commands/git.js");
        break;
      case "audit":
        await import("./src/commands/audit.js");
        break;
      case "compose":
        await import("./src/commands/compose.js");
        break;
      case "provision":
        await import("./src/commands/provision.js");
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error("Available commands: git, audit, compose, provision");
        process.exit(1);
    }
  } catch (error) {
    console.error(
      `Command failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    process.argv = originalArgv;
  }
}

main().catch((error) => {
  console.error(
    `CLI failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
