import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
  globalIgnores(["dist/**", "coverage/**", "node_modules/**"]),
  js.configs.recommended,
  ...tseslint.configs.strict,
  prettier,
]);
