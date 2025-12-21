import chalk from "chalk";

/**
 * Logger utility matching bash script output patterns
 * Uses chalk for colored terminal output
 */
export const log = {
  /**
   * [INFO] - Informational messages
   */
  info: (message: string): void => {
    console.log(chalk.cyan("[INFO]"), message);
  },

  /**
   * [ERROR] - Error messages
   */
  error: (message: string): void => {
    console.error(chalk.red("[ERROR]"), message);
  },

  /**
   * [WARN] - Warning messages
   */
  warn: (message: string): void => {
    console.warn(chalk.yellow("[WARN]"), message);
  },

  /**
   * [OK] - Success/passed messages
   */
  ok: (message: string): void => {
    console.log(chalk.green("[OK]"), message);
  },

  /**
   * [FAIL] - Failure messages
   */
  fail: (message: string): void => {
    console.error(chalk.red("[FAIL]"), message);
  },

  /**
   * [ALERT] - Alert messages (critical)
   */
  alert: (message: string): void => {
    console.error(chalk.red.bold("[ALERT]"), message);
  },

  /**
   * [SUMMARY] - Summary section header
   */
  summary: (message: string): void => {
    console.log(chalk.bold("[SUMMARY]"), message);
  },

  /**
   * [SUCCESS] - Success message (bold green)
   */
  success: (message: string): void => {
    console.log(chalk.green.bold("[SUCCESS]"), message);
  },

  /**
   * [PASSED] - Passed section header
   */
  passed: (): void => {
    console.log(chalk.green("[PASSED]"));
  },

  /**
   * [FAILURES] - Failures section header
   */
  failures: (): void => {
    console.log(chalk.red("[FAILURES]"));
  },

  /**
   * [WARNINGS] - Warnings section header
   */
  warnings: (): void => {
    console.log(chalk.yellow("[WARNINGS]"));
  },

  /**
   * Print a checkmark item (for audit results)
   */
  checkmark: (message: string): void => {
    console.log("  ", chalk.green("✔"), message);
  },

  /**
   * Print a cross item (for audit failures)
   */
  cross: (message: string): void => {
    console.log("  ", chalk.red("✗"), message);
  },

  /**
   * Print a warning item (for audit warnings)
   */
  warningMark: (message: string): void => {
    console.log("  ", chalk.yellow("⚠"), message);
  },

  /**
   * Print a separator line (for audit summary)
   */
  separator: (char: string = "="): void => {
    console.log(char.repeat(42));
  },

  /**
   * Print a blank line
   */
  blank: (): void => {
    console.log();
  },

  /**
   * Print raw output (for SSH command results, etc.)
   */
  raw: (message: string): void => {
    console.log(message);
  },
};

/**
 * Export default logger object
 */
export default log;
