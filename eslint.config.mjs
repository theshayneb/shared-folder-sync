import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["node_modules/**", "main.js", "*.mjs", "apps-script/**", "coverage/**"] },
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
		},
	},
	{
		files: ["tests/**/*.ts"],
		rules: { "obsidianmd/no-nodejs-modules": "off", "import/no-nodejs-modules": "off" },
	},
]);
