import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface GhosttyThemeColors {
    background?: string;
    foreground?: string;
    cursor?: string;
    cursorText?: string;
    selectionBackground?: string;
    selectionForeground?: string;
    // 16 ANSI colors
    black?: string;
    red?: string;
    green?: string;
    yellow?: string;
    blue?: string;
    magenta?: string;
    cyan?: string;
    white?: string;
    brightBlack?: string;
    brightRed?: string;
    brightGreen?: string;
    brightYellow?: string;
    brightBlue?: string;
    brightMagenta?: string;
    brightCyan?: string;
    brightWhite?: string;
}

export interface GhosttyKeybind {
    mods: Set<string>;  // 'super' | 'ctrl' | 'shift' | 'alt'
    key: string;        // ghostty key name, lowercased
    action: string;     // e.g. 'copy_to_clipboard', 'paste_from_clipboard', 'text:\n'
}

export interface GhosttyConfig {
    fontFamily?: string;
    fontSize?: number;
    fontStyle?: string;
    lineHeight?: number;
    letterSpacing?: number;
    cursorStyle?: 'block' | 'bar' | 'underline';
    cursorBlink?: boolean;
    theme?: string;
    colors: GhosttyThemeColors;
    scrollback?: number;
    shell?: string;
    ligatures?: boolean;
    keybinds: GhosttyKeybind[];
}

/** Returns candidate config file paths in priority order */
function getCandidatePaths(overridePaths?: string[]): string[] {
    if (overridePaths && overridePaths.length > 0) return overridePaths;

    const candidates: string[] = [];

    // XDG / Linux / newer macOS Ghostty
    const xdgConfig = process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, 'ghostty', 'config')
        : path.join(os.homedir(), '.config', 'ghostty', 'config');
    candidates.push(xdgConfig);

    // macOS Application Support fallback
    if (process.platform === 'darwin') {
        candidates.push(
            path.join(os.homedir(), 'Library', 'Application Support', 'com.mitchellh.ghostty', 'config')
        );
    }

    return candidates;
}

/** Expand $HOME / ~ in string values */
function expandHome(val: string): string {
    if (val.startsWith('~')) return path.join(os.homedir(), val.slice(1));
    return val;
}

/** Normalize a color value: convert rgb(...) or named colors Ghostty may output */
function normalizeColor(val: string): string {
    val = val.trim();
    // Ghostty uses hex (with or without #)
    if (/^[0-9a-fA-F]{6}$/.test(val)) return '#' + val;
    if (/^#[0-9a-fA-F]{3,8}$/.test(val)) return val;
    return val;
}

/**
 * Parse a Ghostty config file.
 * Ghostty config is line-delimited key = value (comments with #).
 */
export function parseGhosttyConfig(overridePaths?: string[]): GhosttyConfig {
    const config: GhosttyConfig = { colors: {}, keybinds: [] };

    const candidates = getCandidatePaths(overridePaths).filter(p => p.trim().length > 0);
    let rawContent: string | null = null;

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                rawContent = fs.readFileSync(candidate, 'utf8');
                console.debug(`[GhosttyTerminal] Loaded config from: ${candidate}`);
                break;
            }
        } catch {
            // skip unreadable paths
        }
    }

    if (!rawContent) {
        console.debug('[GhosttyTerminal] No Ghostty config found; using defaults.');
        return config;
    }

    const lines = rawContent.split('\n');
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.length === 0 || trimmedLine.startsWith('#')) {
            continue; // Skip empty lines and comments
        }

        // Section header (Ghostty uses [section] for some sub-configs)
        const sectionMatch = line.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            continue;
        }

        // Key = value
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;

        const key = line.slice(0, eqIdx).trim().toLowerCase();
        const value = line.slice(eqIdx + 1).trim();

        // Strip inline comments
        const commentIdx = value.indexOf(' #');
        const cleanValue = commentIdx !== -1 ? value.slice(0, commentIdx).trim() : value;

        applyConfigKey(config, key, cleanValue);
    }

    // Resolve theme: load colors from theme file, letting explicit config values win
    if (config.theme) {
        const themeColors = loadThemeColors(config.theme);
        if (themeColors) {
            config.colors = { ...themeColors, ...config.colors };
        }
    }

    return config;
}

/**
 * Locate and parse a Ghostty theme file by name.
 * Search order: user themes → system themes → Flatpak host system themes.
 */
function loadThemeColors(themeName: string): GhosttyThemeColors | null {
    const candidates = [
        path.join(os.homedir(), '.config', 'ghostty', 'themes', themeName),
        '/usr/share/ghostty/themes/' + themeName,
        '/run/host/usr/share/ghostty/themes/' + themeName,
        // macOS: Ghostty app bundle (system-wide and user Applications)
        `/Applications/Ghostty.app/Contents/Resources/ghostty/themes/${themeName}`,
        path.join(os.homedir(), 'Applications', 'Ghostty.app', 'Contents', 'Resources', 'ghostty', 'themes', themeName),
    ];

    for (const themePath of candidates) {
        try {
            if (!fs.existsSync(themePath)) continue;
            const content = fs.readFileSync(themePath, 'utf8');
            const tempConfig: GhosttyConfig = { colors: {}, keybinds: [] };
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = line.indexOf('=');
                if (eqIdx === -1) continue;
                const key = line.slice(0, eqIdx).trim().toLowerCase();
                const value = line.slice(eqIdx + 1).trim();
                const commentIdx = value.indexOf(' #');
                const cleanValue = commentIdx !== -1 ? value.slice(0, commentIdx).trim() : value;
                applyConfigKey(tempConfig, key, cleanValue);
            }
            console.debug(`[GhosttyTerminal] Loaded theme colors from: ${themePath}`);
            return tempConfig.colors;
        } catch {
            // skip unreadable paths
        }
    }
    return null;
}

function applyConfigKey(config: GhosttyConfig, key: string, value: string) {
    switch (key) {
        // Font
        case 'font-family':
            config.fontFamily = value;
            break;
        case 'font-size':
            config.fontSize = parseFloat(value) || undefined;
            break;
        case 'font-style':
            config.fontStyle = value;
            break;
        case 'adjust-cell-height':
            // Ghostty uses percentage offsets; map roughly to lineHeight
            config.lineHeight = 1.0 + (parseFloat(value) / 100) || 1.0;
            break;
        case 'font-feature':
            // ligatures: if calt is listed (enabled), treat as ligatures on
            if (value.toLowerCase().includes('calt')) config.ligatures = true;
            if (value.startsWith('-')) config.ligatures = false; // negative features disable
            break;

        // Cursor
        case 'cursor-style':
            if (['block', 'bar', 'underline'].includes(value)) {
                config.cursorStyle = value as 'block' | 'bar' | 'underline';
            }
            break;
        case 'cursor-style-blink':
            config.cursorBlink = value === 'true';
            break;

        // Theme
        case 'theme':
            config.theme = value;
            break;

        // Colors (Ghostty format: palette = N=#rrggbb or named)
        case 'background':
            config.colors.background = normalizeColor(value);
            break;
        case 'foreground':
            config.colors.foreground = normalizeColor(value);
            break;
        case 'cursor-color':
            config.colors.cursor = normalizeColor(value);
            break;
        case 'cursor-text':
            config.colors.cursorText = normalizeColor(value);
            break;
        case 'selection-background':
            config.colors.selectionBackground = normalizeColor(value);
            break;
        case 'selection-foreground':
            config.colors.selectionForeground = normalizeColor(value);
            break;
        case 'palette': {
            // palette = 0=#rrggbb
            const [idxStr, colorStr] = value.split('=');
            const idx = parseInt(idxStr.trim(), 10);
            const color = normalizeColor((colorStr || '').trim());
            applyPaletteColor(config.colors, idx, color);
            break;
        }

        // Scrollback
        case 'scrollback-limit':
            config.scrollback = parseInt(value, 10) || undefined;
            break;

        // Shell
        case 'command':
            config.shell = expandHome(value);
            break;

        // Keybindings: keybind = super+c=copy_to_clipboard
        case 'keybind': {
            // Split on the LAST '=' to separate key combo from action
            const eqIdx = value.lastIndexOf('=');
            if (eqIdx === -1) break;
            const combo = value.slice(0, eqIdx).trim();
            const action = value.slice(eqIdx + 1).trim();
            if (!combo || !action) break;

            const parts = combo.split('+');
            const key = parts[parts.length - 1].toLowerCase();
            const mods = new Set(parts.slice(0, -1).map(m => m.toLowerCase()));
            config.keybinds.push({ mods, key, action });
            break;
        }
    }
}

const PALETTE_NAMES: (keyof GhosttyThemeColors)[] = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

function applyPaletteColor(colors: GhosttyThemeColors, idx: number, color: string) {
    if (idx >= 0 && idx < PALETTE_NAMES.length) {
        (colors as Record<string, string>)[PALETTE_NAMES[idx]] = color;
    }
}
