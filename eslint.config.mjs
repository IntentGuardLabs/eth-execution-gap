import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    ".cache/**",
    "reports/**",
    "**/*.tsbuildinfo",
  ]),
  {
    files: ["lib/**/*.ts", "cli/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
]);
