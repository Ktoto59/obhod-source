// Screenshot fixture only. Never connects to a service or reads a user profile.
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['loadProfile', 'saveProfile', 'status', 'connectionInfo', 'publicIp',
  'presets', 'appVersion', 'updateStatus', 'engineVersion', 'installedApplications', 'runningApplications'];
contextBridge.exposeInMainWorld('obhod', Object.fromEntries([
  ...methods.map(method => [method, (...args) => ipcRenderer.invoke('docs:fixture', method, ...args)]),
  ['onEngineEvent', () => () => {}], ['onUpdateEvent', () => () => {}]
]));
