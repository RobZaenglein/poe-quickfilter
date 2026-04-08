import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, clipboard } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function log(...args: unknown[]) {
  console.log('[quickhide]', ...args)
}

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
  try {
    const trayIconPath = path.join(__dirname, 'assets/icon.png')
    log('creating tray', { trayIconPath })
    tray = new Tray(trayIconPath)
  } catch (error) {
    log('tray creation failed', error)
    return
  }

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
  log('clipboard before copy', before?.slice(0, 120))
  if (isPoeItemText(before)) {
    clipboard.writeText('')
  }

  return await new Promise<string>((resolve, reject) => {
    const poll = () => {
      const text = clipboard.readText()
      if (isPoeItemText(text)) {
        log('clipboard item text detected')
        resolve(text)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        log('clipboard poll timed out', { timeoutMs, lastText: text?.slice(0, 120) })
        reject(new Error('Timed out waiting for PoE item text in clipboard'))
        return
      }
      setTimeout(poll, 50)
    }
    setTimeout(poll, 50)
  })
}

function tapKey(key: number) {
  uIOhook.keyTap(key)
}

function copyItemTextLikeApt() {
  // Match Awakened PoE Trade behavior more closely:
  // release trigger keys first, then press merged copy combo (Ctrl + Alt + C)
  uIOhook.keyToggle(UiohookKey.H, 'up')
  uIOhook.keyToggle(UiohookKey.Ctrl, 'up')

  setTimeout(() => {
    uIOhook.keyToggle(UiohookKey.Ctrl, 'down')
    uIOhook.keyToggle(UiohookKey.Alt, 'down')
    setTimeout(() => {
      tapKey(UiohookKey.C)
      setTimeout(() => {
        uIOhook.keyToggle(UiohookKey.Alt, 'up')
        uIOhook.keyToggle(UiohookKey.Ctrl, 'up')
      }, 20)
    }, 20)
  }, 40)
}

type ParsedItem = {
  itemClass: string
  rarity: string
  nameLine: string
  secondLine: string
  stackSize: number | null
}

function parseItemText(itemText: string): ParsedItem {
  const lines = itemText.split(/\r?\n/).map(x => x.trim())
  const nonEmpty = lines.filter(Boolean)
  const itemClass = nonEmpty.find(line => line.startsWith('Item Class: '))?.replace('Item Class: ', '') ?? ''
  const rarity = nonEmpty.find(line => line.startsWith('Rarity: '))?.replace('Rarity: ', '') ?? ''

  const rarityIndex = nonEmpty.findIndex(line => line.startsWith('Rarity: '))
  const nameLine = rarityIndex >= 0 ? (nonEmpty[rarityIndex + 1] ?? '') : ''
  const secondLine = rarityIndex >= 0 ? (nonEmpty[rarityIndex + 2] ?? '') : ''

  const stackLine = nonEmpty.find(line => line.startsWith('Stack Size: ')) ?? ''
  const match = stackLine.match(/Stack Size:\s*(\d+)\//)
  const stackSize = match ? Number(match[1]) : null

  return { itemClass, rarity, nameLine, secondLine, stackSize }
}

function q(value: string) {
  return value.replace(/"/g, '\\"')
}

function buildHideRule(itemText: string) {
  const parsed = parseItemText(itemText)

  if (parsed.itemClass === 'Stackable Currency') {
    const baseType = q(parsed.nameLine)
    const stackLine = parsed.stackSize != null ? `\n    StackSize <= ${parsed.stackSize}` : ''
    return `\n# Added by Poe Quickhide Filter\nHide\n    Class \"Stackable Currency\"\n    BaseType \"${baseType}\"${stackLine}\n`
  }

  const exactNameClasses = new Set([
    'Divination Cards',
    'Map Fragments',
    'Skill Gems',
    'Support Gems',
  ])

  let target = parsed.nameLine

  if (parsed.rarity === 'Unique') {
    target = parsed.nameLine
  } else if (exactNameClasses.has(parsed.itemClass) || parsed.rarity === 'Gem' || parsed.rarity === 'Divination Card') {
    target = parsed.nameLine
  } else {
    target = parsed.secondLine || parsed.nameLine
  }

  target = q(target || 'Unknown Item')
  return `\n# Added by Poe Quickhide Filter\nHide\n    BaseType \"${target}\"\n`
}

async function appendHideRuleFromHoveredItem() {
  const lootFilterPath = store.get('lootFilterPath')
  log('append requested', { lootFilterPath })
  if (!lootFilterPath) {
    throw new Error('Loot filter path is not set')
  }

  const focused = await activeWin()
  log('active window', focused ? { title: focused.title, owner: focused.owner?.name, path: focused.owner?.path } : null)
  if (!isPoeFocusedTitle(focused)) {
    throw new Error('Path of Exile is not focused')
  }

  log('sending Ctrl+Alt+C to PoE (APT-style)')
  copyItemTextLikeApt()
  const itemText = await pollClipboardForItemText(900)
  const rule = buildHideRule(itemText)
  log('appending rule', { rule })
  await fs.appendFile(lootFilterPath, rule, 'utf8')

  mainWindow?.webContents.send('quickhide:appended', {
    itemText,
    rule,
    path: lootFilterPath,
  })

  return { itemText, rule, path: lootFilterPath }
}

function registerHotkey() {
  log('registering uIOhook hotkey listener')
  uIOhook.on('keydown', async (event) => {
    const focused = await activeWin().catch(() => null)
    const poeFocused = isPoeFocusedTitle(focused)

    if (poeFocused) {
      log('keydown', {
        keycode: event.keycode,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: (event as unknown as { metaKey?: boolean }).metaKey,
        expectedH: UiohookKey.H,
      })
    }

    if (poeFocused && event.ctrlKey && event.keycode === UiohookKey.H) {
      log('Ctrl+H detected')
      try {
        await appendHideRuleFromHoveredItem()
      } catch (error) {
        log('Ctrl+H handler error', error)
        mainWindow?.webContents.send('quickhide:error', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })
  uIOhook.start()
  log('uIOhook started')
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
