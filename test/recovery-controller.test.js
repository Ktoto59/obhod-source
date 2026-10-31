const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryController } = require('../windows/src/main/recovery-controller');

function createHarness(running = true) {
  const calls = [];
  const timers = [];
  const profile = { routing: { activeTunnelId: 'awg-main' } };
  const service = {
    running,
    isRunning() { return this.running; },
    status() { return { running: this.running }; },
    async start(value) { calls.push(['start', value]); this.running = true; return this.status(); },
    async restart(value) { calls.push(['restart', value]); this.running = true; return this.status(); },
    async stop() { calls.push(['stop']); this.running = false; return this.status(); }
  };
  const controller = new RecoveryController({
    service,
    loadProfile: () => profile,
    onEvent: (event) => calls.push(['event', event.type, event.message]),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    recoveryDelay: 25,
    crashDelays: [10, 20],
    stabilityDelay: 0
  });
  return { controller, service, calls, timers, profile };
}

async function runTimer(harness) {
  const timer = harness.timers.shift();
  assert.ok(timer);
  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
}

test('restarts an enabled AWG connection after Windows resumes', async () => {
  const harness = createHarness(true);
  await harness.controller.start(harness.profile);
  harness.calls.length = 0;

  harness.controller.handleResume();
  assert.equal(harness.timers[0].delay, 25);
  await runTimer(harness);

  assert.deepEqual(harness.calls.filter(([name]) => name === 'restart'), [['restart', harness.profile]]);
  assert.match(harness.calls.at(-1)[2], /восстановлено после выхода Windows из сна/);
});

test('restarts only after the network returns', async () => {
  const harness = createHarness(true);
  await harness.controller.start(harness.profile);
  harness.calls.length = 0;

  harness.controller.handleNetworkChange(true);
  harness.controller.handleNetworkChange(false);
  assert.equal(harness.timers.length, 0);
  harness.controller.handleNetworkChange(true);
  await runTimer(harness);

  assert.deepEqual(harness.calls.filter(([name]) => name === 'restart'), [['restart', harness.profile]]);
});

test('recovers an unexpectedly terminated engine with bounded retries', async () => {
  const harness = createHarness(false);
  await harness.controller.start(harness.profile);
  harness.calls.length = 0;
  harness.service.running = false;

  harness.controller.handleUnexpectedExit();
  assert.equal(harness.timers[0].delay, 10);
  await runTimer(harness);
  assert.deepEqual(harness.calls.filter(([name]) => name === 'start'), [['start', harness.profile]]);

  harness.service.running = false;
  harness.controller.handleUnexpectedExit();
  await runTimer(harness);
  harness.service.running = false;
  harness.controller.handleUnexpectedExit();

  assert.equal(harness.timers.length, 0);
  assert.equal(harness.controller.desiredRunning, false);
  assert.match(harness.calls.at(-1)[2], /остановлено после нескольких сбоев/);
});

test('manual stop cancels a pending recovery', async () => {
  const harness = createHarness(true);
  await harness.controller.start(harness.profile);
  harness.controller.handleResume();
  assert.equal(harness.timers.length, 1);

  await harness.controller.stop();

  assert.equal(harness.timers.length, 0);
  assert.equal(harness.controller.desiredRunning, false);
  assert.deepEqual(harness.calls.at(-1), ['stop']);
});

test('queues another bounded attempt when the engine exits during recovery', async () => {
  const harness = createHarness(false);
  await harness.controller.start(harness.profile);
  harness.service.running = false;
  harness.service.start = async () => {
    harness.calls.push(['start-failed']);
    harness.controller.handleUnexpectedExit();
    throw new Error('core exited');
  };

  harness.controller.handleUnexpectedExit();
  await runTimer(harness);

  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 20);
});

test('readiness failures without exit events retry and stop at the limit', async () => {
  const harness = createHarness(false);
  await harness.controller.start(harness.profile);
  harness.service.running = false;
  let attempts = 0;
  harness.service.start = async () => { attempts++; throw new Error('readiness timeout'); };
  harness.controller.handleUnexpectedExit();
  await runTimer(harness);
  assert.equal(harness.timers[0].delay, 20);
  await runTimer(harness);
  assert.equal(attempts, 2);
  assert.equal(harness.timers.length, 0);
  assert.equal(harness.controller.desiredRunning, false);
});

test('manual stop during recovery suppresses success and further retries', async () => {
  const harness = createHarness(false);
  await harness.controller.start(harness.profile);
  harness.service.running = false;
  let finish;
  harness.service.start = () => new Promise((resolve) => { finish = resolve; });
  harness.controller.handleUnexpectedExit();
  await runTimer(harness);
  const stopping = harness.controller.stop();
  finish({ running: true });
  await stopping;
  assert.equal(harness.timers.length, 0);
  assert.equal(harness.service.running, false);
  assert.ok(!harness.calls.some((call) => String(call[2]).includes('Подключение восстановлено')));
});
