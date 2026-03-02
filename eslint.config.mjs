import tsparser from "@typescript-eslint/parser";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default tseslint.config(
    { ignores: ["main.js", "version-bump.mjs", "esbuild.config.mjs"] },
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: "./tsconfig.json",
            },
            globals: {
                ...globals.browser,
                ...globals.node,
                NodeJS: "readonly"
            }
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
            "obsidianmd/ui/sentence-case": [
                "error",
                {
                    brands: ["JetBrains", "Mac", "macOS", "Wasm"],
                    acronyms: ["WASM", "UI", "OS", "PTY"],
                    enforceCamelCaseLower: true,
                }
            ]
        },
    },
);
