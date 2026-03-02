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

import { parseGhosttyConfig, GhosttyConfig } from './src/ghostty-config';
import { GhosttySettingTab, GhosttyTerminalSettings, DEFAULT_SETTINGS } from './src/settings';

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
        // Nothing to detach as leaves should persist across reloads
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
    private resizePipe: NodeJS.WritableStream | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private charWidth = 9;
    private charHeight = 18;
    private termEl: HTMLElement | null = null;
    private ptyAlive = false;
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

        // Try to rely on the FitAddon rather than calculating char dimensions manually
        this.fitAddon.fit();

        // Re-measure now that font is applied (canvas measurement is more accurate)
        this.measureCharDimensions();
    }

    // ── PTY spawn / recovery (Python-based, no native addons) ─────────────────

    private spawnPty() {
        // Kill previous process
        if (this.ptyProcess) {
            try { this.ptyProcess.kill(); } catch { /* ignore */ }
            this.ptyProcess = null;
            this.resizePipe = null;
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

            const stdioArr = this.ptyProcess.stdio as unknown as NodeJS.WritableStream[];
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
        let measure = document.getElementById(CHAR_MEASURE_ID);
        if (!measure) {
            measure = document.createElement('canvas');
            measure.id = CHAR_MEASURE_ID;
            measure.className = 'ghostty-char-measure';
            document.body.appendChild(measure);
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

    onClose(): Promise<void> {
        this.resizeObserver?.disconnect();
        if (this.ptyAlive) {
            try { this.ptyProcess?.kill(); } catch { /* ignore */ }
        }
        this.terminal?.dispose?.();
        this.fitAddon?.dispose?.();
        this.ptyProcess = null;
        this.terminal = null;
        this.fitAddon = null;
        return Promise.resolve();
    }
}