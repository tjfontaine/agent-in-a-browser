import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactCompiler from 'eslint-plugin-react-compiler';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            // Auto-generated WASM transpiled code
            'src/wasm/mcp-server-jspi/**',
            'src/wasm/mcp-server-sync/**',
            'src/wasm/tsx-engine/**',
            'src/wasm/sqlite-module/**',
            'src/wasm/ratatui-demo/**',
        ],
    },
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            'react-compiler': reactCompiler,
        },
        rules: {
            // Allow unused vars prefixed with underscore
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            // React Compiler rules
            'react-compiler/react-compiler': 'error',
        },
    }
);
