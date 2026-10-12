const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Empty for now, but ready for future native communication if needed
});
