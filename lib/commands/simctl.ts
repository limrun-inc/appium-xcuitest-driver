import {errors} from 'appium/driver.js';
import {exec} from 'teen_process';

import type {XCUITestDriver} from '../driver.js';
import {requireSimulator} from './helpers/index.js';

/**
 * List of subcommands for `simctl` we provide as mobile simctl command.
 * They accept 'device' target.
 */
const SUBCOMMANDS_HAS_DEVICE = [
  'appinfo',
  'boot',
  'get_app_container',
  'getenv',
  'icloud_sync',
  'install',
  'install_app_data',
  'io',
  'keychain',
  'launch',
  'listapps',
  'location',
  'logverbose',
  'openurl',
  'pbcopy',
  'pbpaste',
  'privacy',
  'push',
  'shutdown',
  'spawn',
  'status_bar',
  'terminate',
  'ui',
  'uninstall',
] as const;

export interface SimctlExecResponse {
  /** The output of standard out. */
  stdout: string;
  /** The output of standard error. */
  stderr: string;
  /** Return code. */
  code: number;
}

/**
 * Run the given command with arguments as `xcrun simctl` subcommand.
 *
 * @param command - Subcommand to run with `xcrun simctl`. Must be one of the supported commands.
 * @param args - Arguments for the subcommand. The arguments should be after <device> in the help.
 * @param timeout - The maximum number of milliseconds
 * @returns The execution result with stdout, stderr, and return code
 * @throws If the simctl subcommand command returns non-zero return code, or the given subcommand was invalid.
 */
export async function mobileSimctl(
  this: XCUITestDriver,
  command: string,
  args: string[] = [],
  timeout?: number,
): Promise<SimctlExecResponse> {
  const simulator = requireSimulator(this, 'simctl command');

  if (!this.opts.udid) {
    throw new errors.InvalidArgumentError(`Unknown simulator UDID: '${this.opts.udid}'`);
  }

  if (!(SUBCOMMANDS_HAS_DEVICE as readonly string[]).includes(command)) {
    throw new errors.InvalidArgumentError(
      `The given command '${command}' is not supported. ` +
        `Available subcommands are ${SUBCOMMANDS_HAS_DEVICE.join(',')}`,
    );
  }

  if (this.limClient) {
    // simctl runs on the Limrun host, which allows only some subcommands.
    const execution = this.limClient.simctl([command, this.opts.udid, ...args]);
    const result = await (timeout ? withTimeout(execution.wait(), timeout, command) : execution.wait());
    if (result.code !== 0) {
      throw new Error(
        `simctl ${command} failed with exit code ${result.code}: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    return {stdout: result.stdout, stderr: result.stderr, code: result.code};
  }
  const setArgs = simulator.devicesSetPath ? ['--set', simulator.devicesSetPath] : [];
  const result = await exec('xcrun', ['simctl', ...setArgs, command, this.opts.udid, ...args], {timeout});
  return {
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
    code: result?.code ?? 0,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeout: number, command: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`simctl ${command} timed out after ${timeout}ms`)), timeout);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
