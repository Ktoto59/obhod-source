const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('online', () => ipcRenderer.send('network:status-changed', true));
window.addEventListener('offline', () => ipcRenderer.send('network:status-changed', false));

contextBridge.exposeInMainWorld('obhod', {
  loadProfile: () => ipcRenderer.invoke('profile:load'),
  saveProfile: (profile) => ipcRenderer.invoke('profile:save', profile),
  exportBackup: (options) => ipcRenderer.invoke('backup:export', options),
  chooseBackup: () => ipcRenderer.invoke('backup:choose'),
  previewBackup: (password) => ipcRenderer.invoke('backup:preview', password),
  importBackup: (mode) => ipcRenderer.invoke('backup:import', mode),
  cancelBackup: () => ipcRenderer.invoke('backup:cancel'),
  status: () => ipcRenderer.invoke('engine:status'),
  start: (profile) => ipcRenderer.invoke('engine:start', profile),
  applyProfile: (profile) => ipcRenderer.invoke('engine:apply', profile),
  stop: () => ipcRenderer.invoke('engine:stop'),
  connectionInfo: (profile) => ipcRenderer.invoke('engine:connection-info', profile),
  publicIp: () => ipcRenderer.invoke('network:public-ip'),
  testDns: (settings) => ipcRenderer.invoke('dns:test', settings),
  parseTunnel: (text, name) => ipcRenderer.invoke('tunnel:parse', text, name),
  parseProxy: (text, name) => ipcRenderer.invoke('proxy:parse', text, name),
  importSubscription: (text, existing) => ipcRenderer.invoke('subscription:import', text, existing),
  testTunnel: (tunnel) => ipcRenderer.invoke('tunnel:test', tunnel),
  presets: () => ipcRenderer.invoke('catalog:presets'),
  selectApplications: () => ipcRenderer.invoke('applications:select'),
  installedApplications: () => ipcRenderer.invoke('applications:installed'),
  runningApplications: () => ipcRenderer.invoke('applications:running'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  updateStatus: () => ipcRenderer.invoke('updater:status'),
  copyDiagnostics: (text) => ipcRenderer.invoke('diagnostics:copy', text),
  exportDiagnostics: (text) => ipcRenderer.invoke('diagnostics:export', text),
  engineVersion: () => ipcRenderer.invoke('diagnostics:engine-version'),
  onUpdateEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('updater:event', wrapped);
    return () => ipcRenderer.removeListener('updater:event', wrapped);
  },
  onEngineEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('engine:event', wrapped);
    return () => ipcRenderer.removeListener('engine:event', wrapped);
  }
});
