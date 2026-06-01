// Flat config (ESLint v9 + typescript-eslint v8). New code only — src.legacy/ is ignored
// here AND in tsconfig.build.json, so type-checked rules don't pull legacy into the program.
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    plugins: { import: importPlugin },
    languageOptions: {
      parserOptions: {
        // Root tsconfig includes src/ + test/ and excludes src.legacy/ — exactly the
        // surface eslint should type-check. Build tsconfig is too narrow (no test/).
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: 5 }],
      'import/no-default-export': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // FU.8 audit gate — MCP-side session reads MUST go through resolveMcpSessionId()
    // (src/runtime/hooks/session_id.ts). Raw `process.env.CLAUDE_SESSION_ID` resolves
    // to sessions/unknown (CC never sets it); the global `readCurrentSession()` races
    // cross-project. The resolver itself lives in src/runtime/hooks (out of this glob),
    // so its legitimate internal use is unaffected. Tests excluded (they seed env).
    files: ['src/mcp/**/*.ts', 'src/functions/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name='CLAUDE_SESSION_ID'][object.property.name='env'][object.object.name='process']",
          message:
            'MCP-side session reads must use resolveMcpSessionId() (FU.8), not process.env.CLAUDE_SESSION_ID (resolves to sessions/unknown).',
        },
        {
          selector: "CallExpression[callee.name='readCurrentSession']",
          message:
            'MCP-side session reads must use resolveMcpSessionId() (FU.8), not the global readCurrentSession() (cross-project race).',
        },
      ],
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src.legacy/**',
      '.tsbuildinfo',
      'npm/**',
      'test/fixtures/**',
    ],
  },
);
