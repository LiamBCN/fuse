// Electron main process. Boots the Next.js server inside the app and opens a
// native window pointing at it — so the user just launches Fuse.app, no
// terminal required.
const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const HOST = "127.0.0.1";
const isDev = !app.isPackaged;

const dataDir = () => path.join(app.getPath("userData"), "data");
const portFile = () => path.join(dataDir(), "port.json");

// Port/URL are resolved at startup: a fixed 3030 in dev (matches `next dev`),
// or an OS-assigned free port when packaged so we never clash with whatever
// else is running (e.g. a leftover dev server).
let port = Number(process.env.FUSE_PORT || 3030);
let appUrl = `http://${HOST}:${port}`;

let serverProc = null;
let win = null;

// Ask the OS for an available port by binding to 0 and reading it back.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function isFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(p, HOST, () => srv.close(() => resolve(true)));
  });
}

// Reuse the same port across launches so the window's origin stays stable
// (localStorage is per-origin). Fall back to a fresh free port if the saved
// one is taken, and remember it.
async function resolvePort() {
  try {
    const saved = JSON.parse(fs.readFileSync(portFile(), "utf8")).port;
    if (saved && (await isFree(saved))) return saved;
  } catch {
    /* no saved port yet */
  }
  const p = await getFreePort();
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(portFile(), JSON.stringify({ port: p }));
  } catch {
    /* best-effort */
  }
  return p;
}

// Wait until the Next server answers on the port (poll, with a timeout).
function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(appUrl, () => resolve()).on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("Server did not start in time"));
        else setTimeout(tryOnce, 300);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce();
  });
}

// In the packaged app, run the standalone server bundled under resources/app.
// In dev we assume `next dev` is already running (started by the npm script).
function startServer() {
  if (isDev) return Promise.resolve();

  const appDir = path.join(process.resourcesPath, "app");
  const serverJs = path.join(appDir, "server.js");

  serverProc = spawn(process.execPath, [serverJs], {
    cwd: appDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // run server.js as plain Node, not Electron UI
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: HOST,
      // Keep all chat history / usage in a writable per-user folder.
      FUSE_DATA_DIR: path.join(app.getPath("userData"), "data"),
    },
    stdio: "inherit",
  });
  serverProc.on("error", (e) => console.error("Failed to start server:", e));
  return waitForServer();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: "Fuse",
    backgroundColor: "#000000",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadURL(appUrl);

  // Open external links (anything off-origin) in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(appUrl)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.on("closed", () => {
    win = null;
  });
}

// Native folder picker for the "working folder" setting.
ipcMain.handle("fuse:choose-folder", async () => {
  const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  // Pick a stable port for the packaged app (dev keeps the fixed 3030).
  if (!isDev && !process.env.FUSE_PORT) {
    try {
      port = await resolvePort();
      appUrl = `http://${HOST}:${port}`;
    } catch (e) {
      console.error("Could not resolve a port, falling back to", port, e);
    }
  }
  try {
    await startServer();
  } catch (e) {
    console.error(e);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
});

// Minimal native menu so standard shortcuts (copy/paste, reload, quit) work.
function menuTemplate() {
  const mac = process.platform === "darwin";
  return [
    ...(mac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
