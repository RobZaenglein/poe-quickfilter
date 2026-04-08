import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, clipboard } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import Store from 'electron-store'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import activeWin from 'active-win'

type Settings = {
  lootFilterPath: string
}

const store = new Store<Settings>({
  defaults: {
    lootFilterPath: '',
  },
})

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function isDev() {
  return !app.isPackaged
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const url = process.env.VITE_DEV_SERVER_URL
  if (isDev() && url) {
    void mainWindow.loadURL(url)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets/icon.png'))

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Poe Quickhide Filter',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setToolTip('Poe Quickhide Filter')
  tray.setContextMenu(menu)
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

async function browseForLootFilter() {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Loot Filter', extensions: ['filter', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const selected = result.filePaths[0]
  store.set('lootFilterPath', selected)
  return selected
}

function isPoeFocusedTitle(win: Awaited<ReturnType<typeof activeWin>>) {
  if (!win) return false
  const owner = win.owner?.name?.toLowerCase() ?? ''
  const title = win.title?.toLowerCase() ?? ''
  return owner.includes('pathofexile') || title.includes('path of exile')
}

function isPoeItemText(text: string) {
  return [
    'Item Class: ',
    'Rarity: ',
  ].some((prefix) => text.includes(prefix))
}

async function pollClipboardForItemText(timeoutMs = 600) {
  const started = Date.now()
  const before = clipboard.readText()
  if (isPoeItemText(before)) {
    clipboard.writeText('')
  }

  return await new Promise<string>((resolve, reject) => {
    const poll = () => {
      const text = clipboard.readText()
      if (isPoeItemText(text)) {
        resolve(text)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('Timed out waiting for PoE item text in clipboard'))
        return
      }
      setTimeout(poll, 50)
    }
    setTimeout(poll, 50)
  })
}

function pressCtrlC() {
  uIOhook.keyToggle(UiohookKey.Ctrl, 'down')
  uIOhook.keyTap(UiohookKey.C)
  uIOhook.keyToggle(UiohookKey.Ctrl, 'up')
}

function extractBaseType(itemText: string) {
  const lines = itemText.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
  const rarityIndex = lines.findIndex(line => line.startsWith('Rarity:'))
  if (rarityIndex >= 0 && lines[rarityIndex + 2]) {
    return lines[rarityIndex + 2]
  }
  return lines[0] ?? 'Unknown Item'
}

function buildHideRule(itemText: string) {
  const baseType = extractBaseType(itemText).replace(/"/g, '\\"')
  return `\n# Added by Poe Quickhide Filter\nHide\n    BaseType \"${baseType}\"\n`
}

async function appendHideRuleFromHoveredItem() {
  const lootFilterPath = store.get('lootFilterPath')
  if (!lootFilterPath) {
    throw new Error('Loot filter path is not set')
  }

  const focused = await activeWin()
  if (!isPoeFocusedTitle(focused)) {
    throw new Error('Path of Exile is not focused')
  }

  pressCtrlC()
  const itemText = await pollClipboardForItemText()
  const rule = buildHideRule(itemText)
  await fs.appendFile(lootFilterPath, rule, 'utf8')

  mainWindow?.webContents.send('quickhide:appended', {
    itemText,
    rule,
    path: lootFilterPath,
  })

  return { itemText, rule, path: lootFilterPath }
}

function registerHotkey() {
  uIOhook.on('keydown', async (event) => {
    if (event.ctrlKey && event.keycode === UiohookKey.H) {
      try {
        await appendHideRuleFromHoveredItem()
      } catch (error) {
        mainWindow?.webContents.send('quickhide:error', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })
  uIOhook.start()
}

ipcMain.handle('settings:get', async () => ({
  lootFilterPath: store.get('lootFilterPath'),
}))

ipcMain.handle('settings:browseLootFilter', async () => ({
  lootFilterPath: await browseForLootFilter(),
}))

ipcMain.handle('settings:setLootFilterPath', async (_event, value: string) => {
  store.set('lootFilterPath', value)
  return { lootFilterPath: value }
})

ipcMain.handle('quickhide:testAppend', async () => {
  return await appendHideRuleFromHoveredItem()
})

app.whenReady().then(() => {
  createWindow()
  createTray()
  registerHotkey()
})

app.on('before-quit', () => {
  isQuitting = true
  try {
    uIOhook.stop()
  } catch {
    // ignore
  }
})
