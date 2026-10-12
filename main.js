import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import fs from 'node:fs';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const isPackaged = app.isPackaged;
const envPath = isPackaged 
  ? path.join(process.resourcesPath, '.env') 
  : path.join(__dirname, '.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.warn(`Could not find .env file at ${envPath}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let mainWindow;

async function createWindow() {
  try {
    const port = await getFreePort();
    process.env.PORT = port.toString();
    console.log(`Starting server on port ${port}...`);
    
    // Start backend server
    await import('./server.js');
    
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      title: "Safety Inspection Admin",
      icon: path.join(__dirname, 'public', 'favicon.ico'), // Fallback if no icon
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    // Remove the menu to feel like an app
    mainWindow.setMenu(null);
    
    mainWindow.loadURL(`http://localhost:${port}`);
    
    // Open external links in default browser instead of the electron app
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      import('electron').then(e => e.shell.openExternal(url));
      return { action: 'deny' };
    });
    
  } catch (err) {
    console.error("Failed to start application:", err);
    import('electron').then(e => {
      e.dialog.showErrorBox("Startup Error", `The application failed to start.\n\nError Details:\n${err.message}\n${err.stack}`);
    });
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
