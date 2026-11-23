/**
 * ESLint for the API (flat config, ESLint 9+).
 *
 *   npm run lint       # report problems
 *   npm run lint:fix   # fix what can be fixed automatically
 *
 * The backend is CommonJS (require / module.exports) running on Node 22.
 */
const js = require("@eslint/js")
const globals = require("globals")

module.exports = [
  {
    ignores: ["node_modules/", "coverage/", "dist/", "uploads/", "prisma/generated/"],
  },

  js.configs.recommended,

  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
    rules: {
      // Mistakes
      "no-unused-vars": ["warn", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // A module-level const used inside a function that runs later is fine; using it earlier in the same scope isn't.
      "no-use-before-define": ["error", { functions: false, classes: true, variables: false }],
      "no-shadow": ["warn", { builtinGlobals: false }],
      "no-return-await": "off",
      "require-atomic-updates": "off", // too many false alarms on Express handlers
      "no-self-compare": "error",
      "no-template-curly-in-string": "warn", // "${x}" in a normal string is usually a forgotten backtick
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "array-callback-return": ["error", { allowImplicit: true }],

      // Safety (SQL, eval, secrets in logs are reviewed by hand; these catch the rest)
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-proto": "error",
      "no-extend-native": "error",

      // Style that prevents bugs
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": ["warn", { destructuring: "all" }],
      "object-shorthand": ["warn", "properties"],
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",
      "no-console": "off", // the server logs to the console on purpose
    },
  },

  // Scripts run by hand (db:setup, user:create) may exit the process.
  {
    files: ["src/mysql/**/*.js"],
    rules: { "no-process-exit": "off" },
  },
]
