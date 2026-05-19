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
