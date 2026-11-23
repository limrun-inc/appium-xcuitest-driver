import path from 'node:path';

import {Ios, type LogLevel} from '@limrun/api';
import {startTcpTunnel, type Tunnel} from '@limrun/api/tunnel';
import {parseAsciiPlist} from 'appium-ios-simulator';
import {registerLimrunClient, unregisterLimrunClient} from 'appium-xcode';
import {errors} from 'appium/driver.js';
import {fs, tempDir} from 'appium/support.js';

import {UDID_AUTO} from './constants.js';
import type {XCUITestDriver} from './driver.js';
import type {AppInfoMapping} from './types.js';

/** The port WebDriverAgent listens on inside the simulator. */
const WDA_PORT = 8100;

/**
 * Connects the session to its Limrun iOS instance before device discovery.
 *
 * It registers the instance client under the simulator udid, so the forked
 * simulator and Xcode packages reach the remote host, and it points
 * WebDriverAgent at the instance's authenticated port gateway unless the
 * session names its own URL.
 *
 * @throws {Error} If the session asks for something a Limrun instance cannot do
 */
export async function startLimrunSession(driver: XCUITestDriver): Promise<void> {
  const {limInstanceApiUrl, limInstanceToken, limLogLevel} = driver.opts;
  if (!limInstanceApiUrl || !limInstanceToken) {
    throw new Error(`The 'appium:limInstanceApiUrl' and 'appium:limInstanceToken' capabilities are required`);
  }
  if (driver.opts.fullReset) {
    throw new Error(
      `'appium:fullReset' is not supported on Limrun simulators, because it erases the simulator. ` +
        `Create a new Limrun iOS instance for a clean simulator.`,
    );
  }

  const client = await Ios.createInstanceClient({
    apiUrl: limInstanceApiUrl,
    token: limInstanceToken,
    logLevel: (limLogLevel?.toLowerCase() as LogLevel | undefined) ?? 'info',
  });
  const instanceUdid = client.deviceInfo.udid;
  driver.limClient = client;
  registerLimrunClient(instanceUdid, client);

  const {udid} = driver.opts;
  if (!udid || udid.toLowerCase() === UDID_AUTO) {
    driver.opts.udid = instanceUdid;
    driver.log.info(`Using the Limrun instance simulator '${instanceUdid}'`);
  } else if (udid.toLowerCase() !== instanceUdid.toLowerCase()) {
    throw new Error(
      `'appium:udid' is '${udid}', but the Limrun instance serves the simulator '${instanceUdid}'. ` +
        `Omit 'appium:udid' or set it to the instance simulator.`,
    );
  }

  if (!driver.opts.webDriverAgentUrl) {
    driver.opts.webDriverAgentUrl = client.targetHttpPortUrl(WDA_PORT);
    driver.log.info(`Using the WebDriverAgent of the Limrun instance at '${driver.opts.webDriverAgentUrl}'`);
  }
  // The port gateway authenticates every request with the instance token.
  const opts = driver.opts as typeof driver.opts & {extraRequestHeaders?: Record<string, string>};
  opts.extraRequestHeaders = {
    Authorization: `Bearer ${limInstanceToken}`,
    ...(driver.opts.wdaRequestHeaders as Record<string, string> | undefined),
    ...opts.extraRequestHeaders,
  };
}

// The Web Inspector tunnel of each session, so the session can close it with its debugger.
const webInspectorTunnels = new WeakMap<XCUITestDriver, Tunnel>();

/**
 * Opens a local TCP port that reaches the simulator's Web Inspector socket on
 * the Limrun host, through the instance's port-forward endpoint.
 *
 * @param socketPath The Web Inspector socket path on the Limrun host
 * @returns The local address the remote debugger connects to
 */
export async function openWebInspectorTunnel(
  driver: XCUITestDriver,
  socketPath: string,
): Promise<{host: string; port: number}> {
  closeWebInspectorTunnel(driver);
  const {limInstanceApiUrl, limInstanceToken, limLogLevel} = driver.opts;
  const url = `${limInstanceApiUrl}/port-forward?socketPath=${encodeURIComponent(socketPath)}`;
  const tunnel = await startTcpTunnel(url, limInstanceToken as string, '127.0.0.1', 0, {
    mode: 'multiplexed',
    logLevel: (limLogLevel?.toLowerCase() as LogLevel | undefined) ?? 'info',
  });
  webInspectorTunnels.set(driver, tunnel);
  driver.log.debug(`Reaching the Web Inspector at '${socketPath}' through 127.0.0.1:${tunnel.address.port}`);
  return {host: tunnel.address.address, port: tunnel.address.port};
}

/** Closes the session's Web Inspector tunnel, if one is open. */
export function closeWebInspectorTunnel(driver: XCUITestDriver): void {
  webInspectorTunnels.get(driver)?.close();
  webInspectorTunnels.delete(driver);
}

/** Disconnects the session's instance client and forgets its udid. */
export function stopLimrunSession(driver: XCUITestDriver): void {
  closeWebInspectorTunnel(driver);
  const client = driver.limClient;
  if (!client) {
    return;
  }
  unregisterLimrunClient(client.deviceInfo.udid);
  client.disconnect();
  driver.limClient = null;
}

/** A file inside an app container on the Limrun simulator. */
export interface LimrunContainerFile {
  bundleId: string;
  containerType: string | null;
  /** The path relative to the container root. */
  relativePath: string;
}

function containerTarget(file: LimrunContainerFile): Ios.ContainerTargetOptions {
  const normalized = path.posix.normalize(file.relativePath);
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    throw new errors.InvalidArgumentError(
      `'${file.relativePath}' must stay inside the container of '${file.bundleId}'`,
    );
  }
  return {bundleId: file.bundleId, ...(file.containerType && {containerType: file.containerType})};
}

/** Writes a file into an app container on the Limrun host. */
export async function pushContainerFile(
  driver: XCUITestDriver,
  file: LimrunContainerFile,
  data: Buffer,
): Promise<void> {
  const target = containerTarget(file);
  const dir = await tempDir.openDir();
  const localPath = path.join(dir, path.posix.basename(file.relativePath));
  try {
    await fs.writeFile(localPath, data);
    await limClientOf(driver).pushFile(localPath, path.posix.normalize(file.relativePath), target);
  } finally {
    await fs.rimraf(dir);
  }
}

/** Reads a file from an app container on the Limrun host, as base64. */
export async function pullContainerFile(driver: XCUITestDriver, file: LimrunContainerFile): Promise<string> {
  const data = await limClientOf(driver).pullFile(path.posix.normalize(file.relativePath), containerTarget(file));
  return data.toString('base64');
}

/** Deletes a file from an app container on the Limrun host. */
export async function deleteContainerFile(driver: XCUITestDriver, file: LimrunContainerFile): Promise<void> {
  await limClientOf(driver).deleteFile(path.posix.normalize(file.relativePath), containerTarget(file));
}

/** The error for simulator file access outside an app container, which Limrun does not expose. */
export function unsupportedSimulatorPath(remotePath: string): Error {
  return new errors.InvalidArgumentError(
    `'${remotePath}' is outside an app container, which Limrun simulators do not expose. ` +
      `Use the '@<bundleId>[:<containerType>]/<path>' form.`,
  );
}

/**
 * Lists the simulator's apps of one type with `simctl listapps`, keyed by bundle id, the shape a
 * real device's installation proxy returns. Values are the strings simctl prints.
 */
export async function listLimrunApps(
  driver: XCUITestDriver,
  applicationType: 'User' | 'System',
  returnAttributes?: string[],
): Promise<AppInfoMapping> {
  const udid = driver.opts.udid as string;
  const {code, stdout, stderr} = await limClientOf(driver).simctl(['listapps', udid]).wait();
  if (code !== 0) {
    throw new Error(`simctl listapps failed: ${(stderr || stdout).trim()}`);
  }
  const apps = parseAsciiPlist(stdout) as Record<string, Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(apps)
      .filter(([, info]) => info.ApplicationType === applicationType)
      .map(([bundleId, info]) => [
        bundleId,
        returnAttributes
          ? Object.fromEntries(returnAttributes.filter((a) => a in info).map((a) => [a, info[a]]))
          : info,
      ]),
  ) as AppInfoMapping;
}

/**
 * Records the screen with the instance's own encoder, the one that feeds its WebRTC stream,
 * instead of ffmpeg reading WebDriverAgent's MJPEG port, which the instance does not expose.
 * It has the same lifecycle as the ffmpeg recorder.
 */
export class LimrunScreenRecorder {
  private recordingId: string | null = null;
  private stopping: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: Ios.InstanceClient,
    private readonly log: XCUITestDriver['log'],
    private readonly videoPath: string,
  ) {}

  async start(timeoutMs: number): Promise<void> {
    // Touch indicators are off, so the video matches what the app shows.
    this.recordingId = await this.client.startRecordingSession({touchIndicators: false});
    this.timer = setTimeout(() => {
      this.stop().catch((err) => this.log.warn(`Cannot stop the screen recording at its time limit: ${err.message}`));
    }, timeoutMs);
  }

  async interrupt(force = false): Promise<boolean> {
    try {
      await this.stop();
    } catch (err) {
      this.log.warn(`Cannot stop the screen recording: ${(err as Error).message}`);
      return force;
    }
    return true;
  }

  async finish(): Promise<string> {
    await this.stop();
    return this.videoPath;
  }

  async cleanup(): Promise<void> {
    this.clearTimer();
    if (await fs.exists(this.videoPath)) {
      await fs.rimraf(this.videoPath);
    }
  }

  /** Stops the recording once and downloads it; later calls wait for the same stop. */
  private stop(): Promise<void> {
    const recordingId = this.recordingId;
    if (!recordingId) {
      return Promise.resolve();
    }
    this.stopping ??= (async () => {
      this.clearTimer();
      await this.client.stopRecordingSession(recordingId, {localPath: this.videoPath});
    })();
    return this.stopping;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function limClientOf(driver: XCUITestDriver): Ios.InstanceClient {
  if (!driver.limClient) {
    throw new Error('The session is not connected to a Limrun instance');
  }
  return driver.limClient;
}
