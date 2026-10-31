class RecoveryController {
  constructor({
    service,
    loadProfile,
    onEvent = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    recoveryDelay = 1500,
    crashDelays = [2000, 5000, 15000],
    stabilityDelay = 60000
  }) {
    this.service = service;
    this.loadProfile = loadProfile;
    this.onEvent = onEvent;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.recoveryDelay = recoveryDelay;
    this.crashDelays = crashDelays;
    this.stabilityDelay = stabilityDelay;
    this.desiredRunning = false;
    this.lastOnline = null;
    this.crashAttempts = 0;
    this.timer = null;
    this.stabilityTimer = null;
    this.recoveryPromise = null;
    this.pendingUnexpectedExit = false;
  }

  async start(profile) {
    this.cancelScheduledRecovery();
    this.cancelStabilityTimer();
    this.desiredRunning = true;
    this.crashAttempts = 0;
    try {
      return await this.service.start(profile);
    } catch (error) {
      this.desiredRunning = false;
      this.cancelScheduledRecovery();
      this.pendingUnexpectedExit = false;
      throw error;
    }
  }

  async stop() {
    this.desiredRunning = false;
    this.crashAttempts = 0;
    this.cancelScheduledRecovery();
    this.cancelStabilityTimer();
    this.pendingUnexpectedExit = false;
    if (this.recoveryPromise) await this.recoveryPromise.catch(() => {});
    return this.service.stop();
  }

  async apply(profile) {
    const restarted = this.service.isRunning();
    if (!restarted) return { status: this.service.status(), restarted: false };
    this.desiredRunning = true;
    const status = await this.service.restart(profile);
    return { status, restarted: true };
  }

  handleUnexpectedExit() {
    if (!this.desiredRunning || this.timer) return;
    this.cancelStabilityTimer();
    if (this.recoveryPromise) {
      this.pendingUnexpectedExit = true;
      return;
    }
    if (this.crashAttempts >= this.crashDelays.length) {
      this.desiredRunning = false;
      this.onEvent({
        type: 'error',
        message: 'Автоматическое восстановление остановлено после нескольких сбоев. Проверьте диагностику и включите Обход вручную.',
        timestamp: new Date().toISOString()
      });
      return;
    }
    const delay = this.crashDelays[this.crashAttempts];
    this.crashAttempts += 1;
    this.scheduleRecovery('аварийного завершения ядра', delay);
  }

  handleResume() {
    this.crashAttempts = 0;
    this.scheduleRecovery('выхода Windows из сна', this.recoveryDelay);
  }

  handleNetworkChange(online) {
    const normalized = online === true;
    const wasOnline = this.lastOnline;
    this.lastOnline = normalized;
    if (normalized && wasOnline === false) {
      this.crashAttempts = 0;
      this.scheduleRecovery('восстановления сети', this.recoveryDelay);
    }
  }

  scheduleRecovery(reason, delay) {
    if (!this.desiredRunning || this.timer || this.recoveryPromise) return;
    this.onEvent({
      type: 'status',
      message: `Переподключение после ${reason}…`,
      timestamp: new Date().toISOString()
    });
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.recoveryPromise = this.runRecovery(reason).finally(() => {
        this.recoveryPromise = null;
        if (this.pendingUnexpectedExit) {
          this.pendingUnexpectedExit = false;
          this.handleUnexpectedExit();
        }
      });
    }, delay);
    this.timer?.unref?.();
  }

  async runRecovery(reason) {
    if (!this.desiredRunning) return this.service.status();
    try {
      const profile = this.loadProfile();
      const status = this.service.isRunning()
        ? await this.service.restart(profile)
        : await this.service.start(profile);
      if (!this.desiredRunning) return status;
      this.onEvent({
        type: 'status',
        message: `Подключение восстановлено после ${reason}.`,
        timestamp: new Date().toISOString()
      });
      this.armStabilityTimer();
      return status;
    } catch (error) {
      // Validation, spawn and readiness failures need not emit an exit event.
      // Retry through the same bounded backoff after recoveryPromise settles.
      if (this.desiredRunning) this.pendingUnexpectedExit = true;
      this.onEvent({
        type: 'error',
        message: `Не удалось восстановить подключение после ${reason}: ${error.message}`,
        timestamp: new Date().toISOString()
      });
      return this.service.status();
    }
  }

  cancelScheduledRecovery() {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  armStabilityTimer() {
    this.cancelStabilityTimer();
    if (!this.stabilityDelay) return;
    this.stabilityTimer = this.setTimer(() => {
      this.stabilityTimer = null;
      this.crashAttempts = 0;
    }, this.stabilityDelay);
    this.stabilityTimer?.unref?.();
  }

  cancelStabilityTimer() {
    if (!this.stabilityTimer) return;
    this.clearTimer(this.stabilityTimer);
    this.stabilityTimer = null;
  }
}

module.exports = { RecoveryController };
