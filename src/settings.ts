import { App, PluginSettingTab, Setting } from 'obsidian';
import type GhosttyTerminalPlugin from '../main';

export interface GhosttyTerminalSettings {
    /** Location to open the terminal by default */
    defaultLocation: 'right' | 'left' | 'tab' | 'split' | 'window';
    /** Candidate paths for Ghostty config file, tried in order. Empty = auto-detect. */
    ghosttyConfigPaths: string[];
    /** Candidate shell paths, tried in order. First existing path wins. */
    shellPaths: string[];
    /** Override font family (empty = read from Ghostty config). */
    fontFamilyOverride: string;
    /** Override font size (0 = read from Ghostty config). */
    fontSizeOverride: number;
    /** Enable font ligatures */
    ligatures: boolean;
    /** Number of scrollback lines */
    scrollbackLines: number;
}

export const DEFAULT_SETTINGS: GhosttyTerminalSettings = {
    defaultLocation: 'right',
    ghosttyConfigPaths: [],
    shellPaths: [],
    fontFamilyOverride: 'JetBrains Mono, Menlo, Consolas, monospace',
    fontSizeOverride: 0,
    ligatures: true,
    scrollbackLines: 10000,
};

export class GhosttySettingTab extends PluginSettingTab {
    plugin: GhosttyTerminalPlugin;

    constructor(app: App, plugin: GhosttyTerminalPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // --- Display ---
        new Setting(containerEl).setName('Display').setHeading();

        new Setting(containerEl)
            .setName('Default location')
            .setDesc('Where should the terminal launch by default?')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('right', 'Right sidebar')
                    .addOption('left', 'Left sidebar')
                    .addOption('tab', 'New tab')
                    .addOption('split', 'New split')
                    .addOption('window', 'Popout window')
                    .setValue(this.plugin.settings.defaultLocation)
                    .onChange(async (value: 'right' | 'left' | 'tab' | 'split' | 'window') => {
                        this.plugin.settings.defaultLocation = value;
                        await this.plugin.saveSettings();
                    })
            );

        // --- Ghostty Config ---
        new Setting(containerEl).setName('Ghostty config').setHeading();

        this.renderPathList(
            containerEl,
            'Config file paths',
            'Paths to ghostty config file, tried in order. Leave empty to auto-detect.',
            '/home/user/.config/ghostty/config',
            () => this.plugin.settings.ghosttyConfigPaths,
            async paths => {
                this.plugin.settings.ghosttyConfigPaths = paths;
                await this.plugin.saveSettings();
            }
        );

        // --- Shell ---
        new Setting(containerEl).setName('Shell').setHeading();

        this.renderPathList(
            containerEl,
            'Shell paths',
            'Paths to shell binary, tried in order. First existing path is used. Leave empty to use $SHELL.',
            '/bin/zsh',
            () => this.plugin.settings.shellPaths,
            async paths => {
                this.plugin.settings.shellPaths = paths;
                await this.plugin.saveSettings();
            }
        );

        // --- Font (overrides) ---
        new Setting(containerEl).setName('Font overrides').setHeading();
        containerEl.createEl('small', {
            text: 'These override values from your ghostty config (leave blank or 0 to use ghostty config values).',
            cls: 'setting-item-description',
        });

        new Setting(containerEl)
            .setName('Font family')
            .setDesc('Override font family.')
            .addText(text =>
                text
                    .setValue(this.plugin.settings.fontFamilyOverride)
                    .onChange(async value => {
                        this.plugin.settings.fontFamilyOverride = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Font size')
            .setDesc('Override font size (set to 0 to use default).')
            .addText(text =>
                text
                    .setPlaceholder('15')
                    .setValue(this.plugin.settings.fontSizeOverride > 0 ? String(this.plugin.settings.fontSizeOverride) : '')
                    .onChange(async value => {
                        this.plugin.settings.fontSizeOverride = parseFloat(value) || 0;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Font ligatures')
            .setDesc('Enable font ligatures (if supported by your font).')
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.ligatures)
                    .onChange(async value => {
                        this.plugin.settings.ligatures = value;
                        await this.plugin.saveSettings();
                    })
            );

        // --- Performance ---
        new Setting(containerEl).setName('Performance').setHeading();

        new Setting(containerEl)
            .setName('Scrollback lines')
            .setDesc('Number of lines to keep in scrollback buffer.')
            .addText(text =>
                text
                    .setPlaceholder('10000')
                    .setValue(String(this.plugin.settings.scrollbackLines))
                    .onChange(async value => {
                        this.plugin.settings.scrollbackLines = parseInt(value, 10) || 10000;
                        await this.plugin.saveSettings();
                    })
            );
    }

    private renderPathList(
        containerEl: HTMLElement,
        name: string,
        desc: string,
        placeholder: string,
        getPaths: () => string[],
        setPaths: (paths: string[]) => Promise<void>,
    ): void {
        new Setting(containerEl)
            .setName(name)
            .setDesc(desc);

        const listEl = containerEl.createDiv({ cls: 'ghostty-path-list' });

        const render = () => {
            listEl.empty();
            const paths = getPaths();
            paths.forEach((p, i) => {
                new Setting(listEl)
                    .setName(`Path ${i + 1}`)
                    .addText(text =>
                        text
                            .setPlaceholder(placeholder)
                            .setValue(p)
                            .onChange(async value => {
                                const updated = [...getPaths()];
                                updated[i] = value;
                                await setPaths(updated);
                            })
                    )
                    .addExtraButton(btn =>
                        btn
                            .setIcon('trash')
                            .setTooltip('Remove')
                            .onClick(async () => {
                                const updated = getPaths().filter((_, j) => j !== i);
                                await setPaths(updated);
                                render();
                            })
                    );
            });

            new Setting(listEl)
                .addButton(btn =>
                    btn
                        .setButtonText('+ Add path')
                        .onClick(async () => {
                            await setPaths([...getPaths(), '']);
                            render();
                        })
                );
        };

        render();
    }
}
