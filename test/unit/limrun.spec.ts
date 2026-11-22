import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it, mock} from 'node:test';

import {limrunClientFor} from 'appium-xcode';

const UDID = 'D768CB90-CBB4-4557-82F6-B89E1CD0E80B';
const API_URL = 'https://eu.limrun.net/v1/ios_eu_x/api';

let disconnected = 0;
let createOptions: unknown[] = [];

// A Limrun instance client as the SDK returns it after connecting.
const fakeClient = {
  deviceInfo: {udid: UDID},
  targetHttpPortUrl: (port: number) => `https://eu.limrun.net/v1/ios_eu_x/targetHttpPort${port}`,
  disconnect: () => {
    disconnected++;
  },
};

mock.module('@limrun/api', {
  namedExports: {
    Ios: {
      createInstanceClient: async (options: unknown) => {
        createOptions.push(options);
        return fakeClient;
      },
    },
  },
});

const {startLimrunSession, stopLimrunSession} = await import('../../lib/limrun.js');
const {isStrictHostUtilityMode} = await import('../../lib/device/wda-host-ops.js');

function fakeDriver(opts: Record<string, unknown>): any {
  return {
    opts: {limInstanceApiUrl: API_URL, limInstanceToken: 'lim_token', ...opts},
    log: {info: () => {}, debug: () => {}},
    limClient: null,
  };
}

describe('Limrun session', function () {
  beforeEach(function () {
    disconnected = 0;
    createOptions = [];
  });

  afterEach(function () {
    stopLimrunSession({limClient: fakeClient, log: {debug: () => {}}} as any);
  });

  it('connects to the instance and fills the simulator and WebDriverAgent defaults', async function () {
    const driver = fakeDriver({});
    await startLimrunSession(driver);

    assert.deepEqual(createOptions, [{apiUrl: API_URL, token: 'lim_token', logLevel: 'info'}]);
    assert.equal(driver.limClient, fakeClient);
    assert.equal(driver.opts.udid, UDID);
    assert.equal(driver.opts.webDriverAgentUrl, 'https://eu.limrun.net/v1/ios_eu_x/targetHttpPort8100');
    assert.deepEqual(driver.opts.extraRequestHeaders, {Authorization: 'Bearer lim_token'});
    assert.equal(limrunClientFor(UDID.toLowerCase()), fakeClient);
  });

  it('keeps the WebDriverAgent URL and headers a session written for the 10.x fork sets', async function () {
    const driver = fakeDriver({
      udid: UDID.toLowerCase(),
      webDriverAgentUrl: 'https://eu.limrun.net:443/v1/ios_eu_x/targetHttpPort8100',
      wdaRequestHeaders: {Authorization: 'Bearer lim_token', 'X-Trace': '1'},
    });
    await startLimrunSession(driver);

    assert.equal(driver.opts.udid, UDID.toLowerCase());
    assert.equal(driver.opts.webDriverAgentUrl, 'https://eu.limrun.net:443/v1/ios_eu_x/targetHttpPort8100');
    assert.deepEqual(driver.opts.extraRequestHeaders, {Authorization: 'Bearer lim_token', 'X-Trace': '1'});
  });

  it('rejects a udid of another simulator', async function () {
    await assert.rejects(
      startLimrunSession(fakeDriver({udid: 'OTHER'})),
      /'appium:udid' is 'OTHER', but the Limrun instance serves the simulator/,
    );
  });

  it('rejects fullReset before connecting', async function () {
    await assert.rejects(startLimrunSession(fakeDriver({fullReset: true})), /fullReset' is not supported/);
    assert.deepEqual(createOptions, []);
  });

  it('disconnects and forgets the instance when the session stops', async function () {
    const driver = fakeDriver({});
    await startLimrunSession(driver);
    stopLimrunSession(driver);

    assert.equal(disconnected, 1);
    assert.equal(driver.limClient, null);
    assert.throws(() => limrunClientFor(UDID), /No Limrun instance serves/);
  });

  it('keeps Limrun sessions on the simulator path off macOS', function () {
    const opts = {webDriverAgentUrl: 'https://eu.limrun.net/x', udid: UDID};
    assert.equal(isStrictHostUtilityMode(opts, 'linux'), true);
    assert.equal(isStrictHostUtilityMode({...opts, limInstanceApiUrl: API_URL}, 'linux'), false);
  });
});
