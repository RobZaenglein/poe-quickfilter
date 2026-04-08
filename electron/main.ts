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
let hotkeyInFlight = false
let physicalCtrlHeld = false

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

function isPoeFocusedTitle(win: Awaited<ReturnType<typeof activeWin>> | null) {
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
  gemLevel: number | null
  itemLevel: number | null
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

  const levelLine = nonEmpty.find(line => line.startsWith('Level: ')) ?? ''
  const gemLevelMatch = levelLine.match(/Level:\s*(\d+)/)
  const gemLevel = gemLevelMatch ? Number(gemLevelMatch[1]) : null

  const itemLevelLine = nonEmpty.find(line => line.startsWith('Item Level: ')) ?? ''
  const itemLevelMatch = itemLevelLine.match(/Item Level:\s*(\d+)/)
  const itemLevel = itemLevelMatch ? Number(itemLevelMatch[1]) : null

  return { itemClass, rarity, nameLine, secondLine, stackSize, gemLevel, itemLevel }
}

function q(value: string) {
  return value.replace(/"/g, '\\"')
}

type RuleShape = {
  className?: string
  rarity?: string
  stackSizeLte?: number
  gemLevelLte?: number
  itemLevelLte?: number
  baseTypes: string[]
}

function buildRuleShape(itemText: string): RuleShape {
  const parsed = parseItemText(itemText)

  if (parsed.itemClass === 'Stackable Currency') {
    return {
      className: 'Stackable Currency',
      stackSizeLte: parsed.stackSize ?? undefined,
      baseTypes: [parsed.nameLine || 'Unknown Item'],
    }
  }

  if (parsed.itemClass === 'Wombgifts') {
    return {
      className: 'Wombgifts',
      baseTypes: [parsed.nameLine || 'Unknown Item'],
    }
  }

  const gemClasses = new Set(['Skill Gems', 'Support Gems'])
  const exactNameClasses = new Set([
    'Divination Cards',
    'Map Fragments',
    ...gemClasses,
  ])

  if (parsed.rarity === 'Unique') {
    return {
      rarity: 'Unique',
      baseTypes: [parsed.secondLine || parsed.nameLine || 'Unknown Item'],
    }
  }

  let target = parsed.nameLine
  if (exactNameClasses.has(parsed.itemClass) || parsed.rarity === 'Gem' || parsed.rarity === 'Divination Card') {
    target = parsed.nameLine
  } else {
    target = parsed.secondLine || parsed.nameLine
  }

  if (gemClasses.has(parsed.itemClass)) {
    return {
      className: parsed.itemClass || undefined,
      gemLevelLte: parsed.gemLevel ?? undefined,
      baseTypes: [target || 'Unknown Item'],
    }
  }

  return {
    className: parsed.itemClass || undefined,
    itemLevelLte: parsed.itemLevel ?? undefined,
    baseTypes: [target || 'Unknown Item'],
  }
}

function ruleKey(rule: RuleShape) {
  if (rule.className === 'Stackable Currency') {
    return `currency:${rule.stackSizeLte ?? ''}`
  }
  if (rule.rarity === 'Unique') {
    return 'unique'
  }
  if (rule.className === 'Wombgifts') {
    return 'wombgifts'
  }
  if (rule.className === 'Skill Gems' || rule.className === 'Support Gems') {
    return `gems:${rule.className}:${rule.gemLevelLte ?? ''}`
  }
  return `class:${rule.className ?? ''}:ilvl:${rule.itemLevelLte ?? ''}`
}

function renderRule(rule: RuleShape) {
  const baseTypes = [...new Set(rule.baseTypes)].sort().map(v => `\"${q(v)}\"`).join(' ')
  const lines = ['Hide']
  if (rule.stackSizeLte != null) lines.push(`    StackSize <= ${rule.stackSizeLte}`)
  if (rule.gemLevelLte != null) lines.push(`    GemLevel <= ${rule.gemLevelLte}`)
  if (rule.itemLevelLte != null) lines.push(`    ItemLevel <= ${rule.itemLevelLte}`)
  if (rule.className) lines.push(`    Class == \"${q(rule.className)}\"`)
  if (rule.rarity) lines.push(`    Rarity == \"${q(rule.rarity)}\"`)
  lines.push(`    BaseType == ${baseTypes}`)
  return `${lines.join('\n')}\n`
}

const MANAGED_START = '# >>> Poe Quickhide Filter START'
const MANAGED_END = '# <<< Poe Quickhide Filter END'

function parseManagedSection(text: string): { rules: RuleShape[]; rest: string } {
  const startIdx = text.indexOf(MANAGED_START)
  const endIdx = text.indexOf(MANAGED_END)

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { rules: [], rest: text }
  }

  const managed = text.slice(startIdx + MANAGED_START.length, endIdx).trim()
  const restBefore = text.slice(0, startIdx)
  const restAfter = text.slice(endIdx + MANAGED_END.length)
  const blockTexts = managed.split(/\n\s*\n(?=Hide\b)/).map(x => x.trim()).filter(Boolean)

  const rules: RuleShape[] = blockTexts.map((joined) => {
    const classMatch = joined.match(/Class == \"([^\"]+)\"/)
    const stackMatch = joined.match(/StackSize <= (\d+)/)
    const gemLevelMatch = joined.match(/GemLevel <= (\d+)/)
    const itemLevelMatch = joined.match(/ItemLevel <= (\d+)/)
    const baseTypeMatch = joined.match(/BaseType == ([^\n]+)/)
    const baseTypes = baseTypeMatch
      ? [...baseTypeMatch[1].matchAll(/\"([^\"]+)\"/g)].map(m => m[1])
      : []

    const rarityMatch = joined.match(/Rarity == \"([^\"]+)\"/)
    return {
      className: classMatch?.[1],
      rarity: rarityMatch?.[1],
      stackSizeLte: stackMatch ? Number(stackMatch[1]) : undefined,
      gemLevelLte: gemLevelMatch ? Number(gemLevelMatch[1]) : undefined,
      itemLevelLte: itemLevelMatch ? Number(itemLevelMatch[1]) : undefined,
      baseTypes,
    }
  })

  return { rules, rest: `${restBefore}${restAfter}` }
}

function mergeRuleIntoFilter(existingText: string, newRule: RuleShape) {
  const { rules, rest } = parseManagedSection(existingText)
  const map = new Map<string, RuleShape>()

  for (const rule of rules) {
    map.set(ruleKey(rule), { ...rule, baseTypes: [...rule.baseTypes] })
  }

  const key = ruleKey(newRule)
  const current = map.get(key)
  if (current) {
    current.baseTypes = [...new Set([...current.baseTypes, ...newRule.baseTypes])]
    map.set(key, current)
  } else {
    map.set(key, { ...newRule, baseTypes: [...newRule.baseTypes] })
  }

  const rendered = [...map.values()]
    .sort((a, b) => ruleKey(a).localeCompare(ruleKey(b)))
    .map(renderRule)
    .join('\n')
  const managedSection = `${MANAGED_START}\n${rendered}\n${MANAGED_END}\n\n`
  const cleanRest = rest.replace(/^\s+/, '')
  return `${managedSection}${cleanRest}`
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
  const ruleShape = buildRuleShape(itemText)
  const existing = await fs.readFile(lootFilterPath, 'utf8').catch(() => '')
  const nextText = mergeRuleIntoFilter(existing, ruleShape)
  const renderedRule = renderRule(ruleShape)
  log('writing merged rule set', { renderedRule })
  await fs.writeFile(lootFilterPath, nextText, 'utf8')

  mainWindow?.webContents.send('quickhide:appended', {
    itemText,
    rule: renderedRule,
    path: lootFilterPath,
  })

  return { itemText, rule: renderedRule, path: lootFilterPath }
}

function registerHotkey() {
  log('registering uIOhook hotkey listener')

  uIOhook.on('keydown', async (event) => {
    if (event.keycode === UiohookKey.Ctrl) {
      physicalCtrlHeld = true
    }

    const focused = await activeWin().catch(() => null)
    const poeFocused = isPoeFocusedTitle(focused)

    if (poeFocused) {
      log('keydown', {
        keycode: event.keycode,
        ctrlKey: event.ctrlKey,
        physicalCtrlHeld,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: (event as unknown as { metaKey?: boolean }).metaKey,
        expectedH: UiohookKey.H,
      })
    }

    if (poeFocused && physicalCtrlHeld && event.keycode === UiohookKey.H) {
      if (hotkeyInFlight) {
        log('Ctrl+H ignored because handler already running')
        return
      }
      hotkeyInFlight = true
      log('Ctrl+H detected')
      try {
        await appendHideRuleFromHoveredItem()
      } catch (error) {
        log('Ctrl+H handler error', error)
        mainWindow?.webContents.send('quickhide:error', {
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setTimeout(() => {
          hotkeyInFlight = false
        }, 150)
      }
    }
  })

  uIOhook.on('keyup', (event) => {
    if (event.keycode === UiohookKey.Ctrl) {
      physicalCtrlHeld = false
      log('physical Ctrl released')
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
