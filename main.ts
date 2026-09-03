import {
    ItemView,
    Menu,
    Notice,
    Plugin,
    TAbstractFile,
    TFile,
    WorkspaceLeaf,
    ViewStateResult,
} from 'obsidian';
import { init as initGhosttyWasm, Terminal, FitAddon } from 'ghostty-web';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';

import { parseGhosttyConfig, GhosttyConfig, GhosttyKeybind } from './src/ghostty-config';
import { GhosttySettingTab, GhosttyTerminalSettings, DEFAULT_SETTINGS } from './src/settings';

import ptyHelperCode from './pty_helper.py';

const VIEW_TYPE_GHOSTTY = 'ghostty-terminal';

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class GhosttyTerminalPlugin extends Plugin {
    settings: GhosttyTerminalSettings;
    ghosttyConfig: GhosttyConfig;
    private wasmReady = false;

    async onload() {
        // 1. Load settings
        await this.loadSettings();

        // 2. Parse Ghostty config once at boot
        this.ghosttyConfig = parseGhosttyConfig(this.settings.ghosttyConfigPath || undefined);

        // 3. Boot Ghostty WASM
        try {
            await initGhosttyWasm();
            this.wasmReady = true;
        } catch (e) {
            console.error('[GhosttyTerminal] Failed to init WASM:', e);
            new Notice('Wasm failed to load. Check console.', 8000);
        }

        // 4. Register view
        this.registerView(VIEW_TYPE_GHOSTTY, (leaf) => new GhosttyTerminalView(leaf, this));

        // 5. Ribbon icon
        this.addRibbonIcon('terminal', 'Open terminal', () => this.activateView());

        // 6. Commands
        this.addCommand({
            id: 'open',
            name: 'Open terminal',
            callback: () => this.activateView(),
        });

        this.addCommand({
            id: 'open-split',
            name: 'Open terminal in new split',
            callback: () => this.activateView(true, 'split'),
        });

        // 7. Context menu on file explorer
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
                const targetPath = file instanceof TFile
                    ? path.dirname(file.path)
                    : file.path; // TFolder

                menu.addItem((item) =>
                    item
                        .setTitle('Open terminal here')
                        .setIcon('terminal')
                        .onClick(() => this.activateViewAt(targetPath))
                );
            })
        );

        // 8. Settings tab
        this.addSettingTab(new GhosttySettingTab(this.app, this));
    }

    onunload() {
        // Kill all pty processes in active terminal views
        this.app.workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY).forEach((leaf) => {
            const view = leaf.view as GhosttyTerminalView;
            view.killPty();
        });
    }

    async loadSettings() {
        const data = await this.loadData() as Partial<GhosttyTerminalSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private getNewLeaf(location: string): WorkspaceLeaf {
        switch (location) {
            case 'left':
                return this.app.workspace.getLeftLeaf(false)!;
            case 'tab':
                return this.app.workspace.getLeaf('tab');
            case 'split':
                return this.app.workspace.getLeaf('split');
            case 'window':
                return this.app.workspace.getLeaf('window');
            case 'right':
            default:
                return this.app.workspace.getRightLeaf(false)!;
        }
    }

    /** Open (or focus) a terminal. */
    async activateView(forceNew = false, locationOverride?: string) {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY);

        if (!forceNew && existing.length > 0) {
            void this.app.workspace.revealLeaf(existing[0]);
            return;
        }

        const location = locationOverride || this.settings.defaultLocation;
        const leaf = this.getNewLeaf(location);
        await leaf.setViewState({ type: VIEW_TYPE_GHOSTTY, active: true });
        void this.app.workspace.revealLeaf(leaf);
    }

    /** Open a terminal seeded with a specific vault-relative cwd. */
    async activateViewAt(vaultRelativePath: string) {
        const leaf = this.getNewLeaf(this.settings.defaultLocation);
        await leaf.setViewState({
            type: VIEW_TYPE_GHOSTTY,
            active: true,
            state: { cwd: vaultRelativePath },
        });
        void this.app.workspace.revealLeaf(leaf);
    }
}

// ─── View ─────────────────────────────────────────────────────────────────────

const CHAR_MEASURE_ID = 'ghostty-char-measure';

class GhosttyTerminalView extends ItemView {
    private terminal: Terminal | null = null;
    private fitAddon: FitAddon | null = null;
    private ptyProcess: child_process.ChildProcess | null = null;
    private resizePipe: import('stream').Writable | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private charWidth = 9;
    private charHeight = 18;
    private termEl: HTMLElement | null = null;
    private ptyAlive = false;
    private wheelDelta = 0;
    private restartBtn: HTMLElement | null = null;
    private cwdOverride: string | null = null;

    constructor(leaf: WorkspaceLeaf, private plugin: GhosttyTerminalPlugin) {
        super(leaf);
    }

    getViewType(): string { return VIEW_TYPE_GHOSTTY; }
    getDisplayText(): string { return 'Ghostty'; }
    getIcon(): string { return 'terminal'; }

    /** Called by Obsidian when this view is re-opened with saved state */
    setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
        if (state && typeof state.cwd === 'string') {
            this.cwdOverride = state.cwd;
        }
        return super.setState(state, result);
    }

    async onOpen() {
        await Promise.resolve();
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('ghostty-container');

        // Build a wrapper that fills the pane
        const wrapper = container.createDiv({ cls: 'ghostty-wrapper' });

        // Status bar for errors/restart
        wrapper.createDiv({ cls: 'ghostty-status-bar ghostty-hidden' });
        this.restartBtn = wrapper.createDiv({ cls: 'ghostty-restart-btn ghostty-hidden' });
        this.restartBtn.setText('Restart shell');
        this.restartBtn.onclick = () => this.spawnPty();

        this.termEl = wrapper.createDiv({ cls: 'ghostty-term' });

        // Measure char dimensions first so we pass correct cols/rows to PTY
        this.measureCharDimensions();

        this.initTerminal();
        this.spawnPty();

        this.resizeObserver = new ResizeObserver(() => this.handleResize());
        this.resizeObserver.observe(this.termEl);
    }

    // ── Terminal init ──────────────────────────────────────────────────────────

    private initTerminal() {
        const gc = this.plugin.ghosttyConfig;
        const s = this.plugin.settings;

        const fontFamily = s.fontFamilyOverride || gc.fontFamily || 'Menlo, Monaco, "Courier New", monospace';
        const fontSize = s.fontSizeOverride > 0 ? s.fontSizeOverride : (gc.fontSize ?? 13);
        const scrollback = gc.scrollback ?? s.scrollbackLines;

        const theme: Record<string, string> = {
            background: gc.colors.background ?? '#1e1e2e',
            foreground: gc.colors.foreground ?? '#cdd6f4',
            cursor: gc.colors.cursor ?? '#f5e0dc',
            black: gc.colors.black ?? '#45475a',
            red: gc.colors.red ?? '#f38ba8',
            green: gc.colors.green ?? '#a6e3a1',
            yellow: gc.colors.yellow ?? '#f9e2af',
            blue: gc.colors.blue ?? '#89b4fa',
            magenta: gc.colors.magenta ?? '#f5c2e7',
            cyan: gc.colors.cyan ?? '#94e2d5',
            white: gc.colors.white ?? '#bac2de',
            brightBlack: gc.colors.brightBlack ?? '#585b70',
            brightRed: gc.colors.brightRed ?? '#f38ba8',
            brightGreen: gc.colors.brightGreen ?? '#a6e3a1',
            brightYellow: gc.colors.brightYellow ?? '#f9e2af',
            brightBlue: gc.colors.brightBlue ?? '#89b4fa',
            brightMagenta: gc.colors.brightMagenta ?? '#f5c2e7',
            brightCyan: gc.colors.brightCyan ?? '#94e2d5',
            brightWhite: gc.colors.brightWhite ?? '#a6adc8',
        };

        this.terminal = new Terminal({
            fontSize,
            fontFamily,
            theme,
            scrollback,
            cursorStyle: gc.cursorStyle ?? 'block',
            cursorBlink: gc.cursorBlink ?? false,
        });

        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);

        this.terminal.open(this.termEl!);

        // When the foreground app has enabled mouse tracking (Claude Code,
        // htop, vim, ...), report wheel events to it as SGR mouse sequences,
        // like a real terminal would. Without this, ghostty-web falls back to
        // faking arrow keys on the alternate screen, which mouse-aware TUIs
        // interpret as cursor/history movement instead of scrolling.
        // Returning false keeps ghostty-web's normal scrollback handling
        // whenever mouse tracking is off.
        this.terminal.attachCustomWheelEventHandler((event: WheelEvent) => {
            const term = this.terminal;
            if (!term || !term.hasMouseTracking() || !term.getMode(1006)) {
                this.wheelDelta = 0;
                return false;
            }

            const deltaLines = event.deltaMode === WheelEvent.DOM_DELTA_LINE
                ? event.deltaY
                : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                    ? event.deltaY * term.rows
                    : event.deltaY / Math.max(1, this.charHeight);
            if (!deltaLines) return true;

            if (this.wheelDelta && Math.sign(this.wheelDelta) !== Math.sign(deltaLines)) {
                this.wheelDelta = 0;
            }
            this.wheelDelta += deltaLines;

            const steps = Math.max(-5, Math.min(5, Math.trunc(this.wheelDelta)));
            if (!steps) return true;
            this.wheelDelta -= steps;

            const rect = this.termEl!.getBoundingClientRect();
            const col = Math.min(term.cols, Math.max(1,
                Math.floor((event.clientX - rect.left) / this.charWidth) + 1));
            const row = Math.min(term.rows, Math.max(1,
                Math.floor((event.clientY - rect.top) / this.charHeight) + 1));

            const modifiers =
                (event.shiftKey ? 4 : 0) |
                (event.altKey ? 8 : 0) |
                (event.ctrlKey ? 16 : 0);
            const button = (steps < 0 ? 64 : 65) + modifiers;

            for (let i = 0; i < Math.abs(steps); i++) {
                term.input(`\x1b[<${button};${col};${row}M`, true);
            }
            return true;
        });

        // Build the full keybind list: Ghostty defaults + user config.
        // User config entries override defaults for the same key combo.
        const effectiveKeybinds = buildEffectiveKeybinds(this.plugin.ghosttyConfig.keybinds);

        // Intercept keybinds in capture phase so Obsidian's global handlers
        // never see the key events meant for the terminal.
        this.termEl!.addEventListener('keydown', (e: KeyboardEvent) => {
            const match = findKeybind(e, effectiveKeybinds);
            if (!match) return;

            const action = match.action;

            if (action === 'copy_to_clipboard') {
                e.preventDefault();
                e.stopImmediatePropagation();
                const text = window.getSelection()?.toString() ?? '';
                if (text) navigator.clipboard.writeText(text).catch(() => {/* ignore */});

            } else if (action === 'paste_from_clipboard') {
                e.preventDefault();
                e.stopImmediatePropagation();
                navigator.clipboard.readText().then(text => {
                    if (this.ptyAlive && this.ptyProcess?.stdin && text) {
                        this.ptyProcess.stdin.write(text, 'utf8');
                    }
                }).catch(() => {/* ignore */});

            } else if (action.startsWith('text:')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const raw = action.slice(5);
                const text = unescapeGhosttyText(raw);
                if (this.ptyAlive && this.ptyProcess?.stdin) {
                    this.ptyProcess.stdin.write(text, 'utf8');
                }

            } else {
                // Action we can't implement (new_tab, new_window, etc.) —
                // block Obsidian from stealing the key but let ghostty-web handle it.
                e.stopPropagation();
            }
        }, { capture: true });

        // Try to rely on the FitAddon rather than calculating char dimensions manually
        this.fitAddon.fit();

        // Re-measure now that font is applied (canvas measurement is more accurate)
        this.measureCharDimensions();
    }

    // ── PTY spawn / recovery (Python-based, no native addons) ─────────────────

    private spawnPty() {
        // Kill previous process
        if (this.ptyProcess) {
            this.killPty();
        }

        const gc = this.plugin.ghosttyConfig;
        const s = this.plugin.settings;

        const shell =
            s.defaultShell ||
            gc.shell ||
            process.env.SHELL ||
            (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

        // Resolve cwd
        const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string, getFullPath?: (p: string) => string };
        const vaultRoot = adapter.getBasePath?.() ?? os.homedir();
        const cwd = this.cwdOverride ? path.join(vaultRoot, this.cwdOverride) : vaultRoot;

        // Locate our bundled Python helper
        // manifest.dir is vault-relative (e.g. ".obsidian/plugins/ghostty-terminal")
        const pluginVaultDir: string | undefined = this.plugin.manifest.dir;
        const helperPath = pluginVaultDir
            ? adapter.getFullPath?.(`${pluginVaultDir}/pty_helper.py`) ??
            path.join(vaultRoot, pluginVaultDir, 'pty_helper.py')
            : path.join(__dirname, 'pty_helper.py');

        // Write the bundled python helper to the helper path if it is missing or different
        try {
            if (!fs.existsSync(helperPath) || fs.readFileSync(helperPath, 'utf8') !== ptyHelperCode) {
                fs.writeFileSync(helperPath, ptyHelperCode, { encoding: 'utf8', mode: 0o755 });
            }
        } catch (e: unknown) {
            const msg = `Failed to write pty_helper.py to ${helperPath} - ${e instanceof Error ? e.message : String(e)}`;
            this.terminal?.write(`\x1b[31m${msg}\x1b[0m\r\n`);
            this.restartBtn?.removeClass('ghostty-hidden');
            new Notice(`Ghostty: ${msg}`, 8000);
            return;
        }

        // Verify the helper exists
        if (!fs.existsSync(helperPath)) {
            const msg = `pty_helper.py not found at: ${helperPath}`;
            this.terminal?.write(`\x1b[31m${msg}\x1b[0m\r\n`);
            this.restartBtn?.removeClass('ghostty-hidden');
            new Notice(`Ghostty: ${msg}`, 8000);
            return;
        }

        const { cols, rows } = this.terminalDimensions();
        const python = process.platform === 'darwin' ? 'python3' : 'python3';

        try {
            this.ptyProcess = child_process.spawn(
                python,
                [helperPath, shell],
                {
                    cwd,
                    env: {
                        ...process.env as Record<string, string>,
                        TERM: 'xterm-256color',
                        TERM_PROGRAM: 'obsidian-ghostty',
                        COLORTERM: 'truecolor',
                        COLUMNS: String(cols),
                        LINES: String(rows),
                    },
                    // stdio[3] is our resize control pipe (write-only from JS side)
                    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                }
            );

            const stdioArr = this.ptyProcess.stdio as unknown as import('stream').Writable[];
            this.resizePipe = stdioArr[3];

            this.ptyAlive = true;
            this.restartBtn?.addClass('ghostty-hidden');

            // PTY output → terminal display
            // No encoding set — receive raw Buffers so UTF-8 multi-byte
            // sequences are preserved and decoded correctly by the VT parser.
            this.ptyProcess.stdout?.on('data', (data: Buffer) => {
                this.terminal?.write(
                    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                    () => {
                        this.terminal?.scrollToBottom();
                    }
                );
            });

            // Terminal input → PTY stdin
            this.terminal?.onData((data: string) => {
                if (this.ptyAlive && this.ptyProcess?.stdin) {
                    // onData gives a JS string; write as UTF-8 bytes to the PTY
                    this.ptyProcess.stdin.write(data, 'utf8');
                }
            });

            this.ptyProcess.on('close', (code: number | null) => {
                this.ptyAlive = false;
                this.terminal?.write(
                    `\r\n\x1b[31m[Process exited with code ${code ?? 0}]\x1b[0m\r\n`
                );
                this.restartBtn?.removeClass('ghostty-hidden');
            });

            this.ptyProcess.on('error', (err: Error) => {
                this.ptyAlive = false;
                this.terminal?.write(`\x1b[31m[PTY error: ${err.message}]\x1b[0m\r\n`);
                this.restartBtn?.removeClass('ghostty-hidden');
            });

            new Notice(`Ghostty ready — ${path.basename(shell)} @ ${path.basename(cwd)}`, 3000);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[GhosttyTerminal] Python PTY spawn failed:', e);
            this.terminal?.write(`\x1b[31mFailed to start shell: ${msg}\x1b[0m\r\n`);
            this.restartBtn?.removeClass('ghostty-hidden');
            new Notice(`Ghostty: failed to start shell — ${msg}`, 8000);
        }
    }

    // ── Resize (pixel-perfect) ─────────────────────────────────────────────────

    /**
     * Measures exact monospace character dimensions using a hidden canvas.
     * This mirrors what xterm.js Fit addon does, giving pixel-perfect cols/rows.
     */
    private measureCharDimensions() {
        // Reuse or create measurement element
        let measure = activeDocument.getElementById(CHAR_MEASURE_ID);
        if (!measure) {
            measure = activeDocument.createElement('canvas');
            measure.id = CHAR_MEASURE_ID;
            measure.className = 'ghostty-char-measure';
            activeDocument.body.appendChild(measure);
        }

        const canvas = measure as HTMLCanvasElement;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const gc = this.plugin.ghosttyConfig;
        const s = this.plugin.settings;
        const fontFamily = s.fontFamilyOverride || gc.fontFamily || 'Menlo, Monaco, "Courier New", monospace';
        const fontSize = s.fontSizeOverride > 0 ? s.fontSizeOverride : (gc.fontSize ?? 13);

        ctx.font = `${fontSize}px ${fontFamily}`;
        const measured = ctx.measureText('W');

        this.charWidth = Math.ceil(measured.width);
        // actualBoundingBoxAscent + Descent gives accurate line height if available
        const ascent = measured.actualBoundingBoxAscent ?? fontSize * 0.8;
        const descent = measured.actualBoundingBoxDescent ?? fontSize * 0.2;
        this.charHeight = Math.ceil((ascent + descent) * 1.2); // ≈ line-height
    }

    private terminalDimensions(): { cols: number; rows: number } {
        const el = this.termEl;
        if (!el) return { cols: 80, rows: 24 };

        const rect = el.getBoundingClientRect();
        const cols = Math.max(10, Math.floor(rect.width / this.charWidth));
        const rows = Math.max(5, Math.floor(rect.height / this.charHeight));
        return { cols, rows };
    }

    private handleResize() {
        if (!this.terminal || !this.fitAddon) return;

        // Let the addon do the layout fitting
        this.fitAddon.fit();

        // PTY dimensions are kept in sync natively by terminal resize, but we need
        // to re-calculate columns/rows to pass to the PTY explicitly via our pipe
        const { cols, rows } = this.terminal;

        if (this.ptyAlive && this.resizePipe) {
            // Send 4-byte big-endian resize frame (rows uint16, cols uint16)
            // Python's pty_helper.py reads this on fd 3 and calls TIOCSWINSZ
            const frame = Buffer.alloc(4);
            frame.writeUInt16BE(rows, 0);
            frame.writeUInt16BE(cols, 2);
            this.resizePipe.write(frame);
        }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    killPty() {
        const proc = this.ptyProcess;
        if (proc) {
            // Close all stdio pipes first — this triggers stdin-EOF in pty_helper.py
            // which causes it to self-terminate even if SIGTERM is missed.
            try { proc.stdin?.destroy(); } catch { /* ignore */ }
            try { proc.stdout?.destroy(); } catch { /* ignore */ }
            try { proc.stderr?.destroy(); } catch { /* ignore */ }
            try { this.resizePipe?.destroy(); } catch { /* ignore */ }

            // Send SIGTERM
            try { proc.kill('SIGTERM'); } catch { /* ignore */ }

            // Fallback: SIGKILL after a short delay in case SIGTERM is not handled
            const pid = proc.pid;
            if (pid) {
                window.setTimeout(() => {
                    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
                }, 500);
            }

            this.ptyProcess = null;
        }
        this.resizePipe = null;
        this.ptyAlive = false;
    }

    onClose(): Promise<void> {
        this.resizeObserver?.disconnect();
        this.killPty();
        this.terminal?.dispose?.();
        this.fitAddon?.dispose?.();
        this.terminal = null;
        this.fitAddon = null;
        this.wheelDelta = 0;
        return Promise.resolve();
    }
}

// ─── Keybind helpers ──────────────────────────────────────────────────────────

// Ghostty's built-in defaults that we always enforce.
const GHOSTTY_BUILTIN_KEYBINDS: GhosttyKeybind[] = [
    { mods: new Set(['super']), key: 'c',     action: 'copy_to_clipboard' },
    { mods: new Set(['super']), key: 'v',     action: 'paste_from_clipboard' },
    // shift+enter / cmd+enter → kitty keyboard protocol newlines (used by Claude etc.)
    { mods: new Set(['shift']), key: 'enter', action: 'text:\x1b[13;2u' },
    { mods: new Set(['super']), key: 'enter', action: 'text:\x1b[13;9u' },
];

/**
 * Merge built-in defaults with user config keybinds.
 * User entries win when they share the same key combo.
 */
function buildEffectiveKeybinds(userKeybinds: GhosttyKeybind[]): GhosttyKeybind[] {
    const result: GhosttyKeybind[] = [...GHOSTTY_BUILTIN_KEYBINDS];
    for (const kb of userKeybinds) {
        const idx = result.findIndex(r => r.key === kb.key && setsEqual(r.mods, kb.mods));
        if (idx !== -1) result[idx] = kb;
        else result.push(kb);
    }
    return result;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

/** Map DOM KeyboardEvent → Ghostty key name */
function domKeyToGhostty(domKey: string): string {
    const map: Record<string, string> = {
        'Enter':      'enter',
        'Tab':        'tab',
        'Backspace':  'backspace',
        'Escape':     'escape',
        'Delete':     'delete',
        'Insert':     'insert',
        'Home':       'home',
        'End':        'end',
        'PageUp':     'page_up',
        'PageDown':   'page_down',
        'ArrowUp':    'up',
        'ArrowDown':  'down',
        'ArrowLeft':  'left',
        'ArrowRight': 'right',
        ' ':          'space',
    };
    if (map[domKey]) return map[domKey];
    if (/^F\d+$/.test(domKey)) return domKey.toLowerCase();  // F1–F12
    if (domKey.length === 1) return domKey.toLowerCase();
    return domKey.toLowerCase();
}

function findKeybind(e: KeyboardEvent, keybinds: GhosttyKeybind[]): GhosttyKeybind | undefined {
    const eventMods = new Set<string>();
    if (e.metaKey)  eventMods.add('super');
    if (e.ctrlKey)  eventMods.add('ctrl');
    if (e.shiftKey) eventMods.add('shift');
    if (e.altKey)   eventMods.add('alt');

    const ghosttyKey = domKeyToGhostty(e.key);
    return keybinds.find(kb => kb.key === ghosttyKey && setsEqual(kb.mods, eventMods));
}

/** Unescape Ghostty text: action escape sequences like \e, \n, \r, \t */
function unescapeGhosttyText(s: string): string {
    return s
        .replace(/\\e/g, '\x1b')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');
}