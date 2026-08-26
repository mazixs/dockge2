import globals from "globals";
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import jsdoc from "eslint-plugin-jsdoc";
import vue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";

const projectRules = {
    "yoda": "error",
    "linebreak-style": [ "error", "unix" ],
    "camelcase": [ "warn", {
        "properties": "never",
        "ignoreImports": true,
    } ],
    "no-unused-vars": "off",
    "indent": [
        "error",
        4,
        {
            ignoredNodes: [ "TemplateLiteral" ],
            SwitchCase: 1,
        },
    ],
    "quotes": [ "error", "double" ],
    "semi": "error",
    "vue/html-indent": [ "error", 4 ],
    "vue/max-attributes-per-line": "off",
    "vue/singleline-html-element-content-newline": "off",
    "vue/html-self-closing": "off",
    "vue/require-component-is": "off",
    "vue/attribute-hyphenation": "off",
    "vue/multi-word-component-names": "off",
    "no-multi-spaces": [ "error", {
        ignoreEOLComments: true,
    } ],
    "array-bracket-spacing": [ "warn", "always", {
        "singleValue": true,
        "objectsInArrays": false,
        "arraysInArrays": false,
    } ],
    "space-before-function-paren": [ "error", {
        "anonymous": "always",
        "named": "never",
        "asyncArrow": "always",
    } ],
    "curly": "error",
    "object-curly-spacing": [ "error", "always" ],
    "object-curly-newline": "off",
    "object-property-newline": "error",
    "comma-spacing": "error",
    "brace-style": "error",
    "no-var": "error",
    "key-spacing": "warn",
    "keyword-spacing": "warn",
    "space-infix-ops": "error",
    "arrow-spacing": "warn",
    "no-trailing-spaces": "error",
    "no-constant-condition": [ "error", {
        "checkLoops": false,
    } ],
    "space-before-blocks": "warn",
    "no-extra-boolean-cast": "off",
    "no-multiple-empty-lines": [ "warn", {
        "max": 1,
        "maxBOF": 0,
    } ],
    "lines-between-class-members": [ "warn", "always", {
        exceptAfterSingleLine: true,
    } ],
    "no-unneeded-ternary": "error",
    "array-bracket-newline": [ "error", "consistent" ],
    "eol-last": [ "error", "always" ],
    "comma-dangle": [ "warn", "only-multiline" ],
    "no-empty": [ "error", {
        "allowEmptyCatch": true,
    } ],
    "no-control-regex": "off",
    "one-var": [ "error", "never" ],
    "max-statements-per-line": [ "error", { "max": 1 } ],
    "@typescript-eslint/ban-ts-comment": "error",
    "@typescript-eslint/no-unused-vars": [ "warn", {
        "args": "none",
        "caughtErrors": "none",
    } ],
    "prefer-const": "off",
};

export default [
    {
        ignores: [
            "node_modules/**",
            "frontend-dist/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs["flat/recommended"],
    ...vue.configs["flat/recommended"],
    {
        files: [ "**/*.{ts,vue}" ],
        languageOptions: {
            parser: vueParser,
            parserOptions: {
                parser: tsParser,
                ecmaVersion: "latest",
                sourceType: "module",
            },
            globals: {
                ...globals.browser,
                ...globals.node,
                CODESPACE_NAME: "readonly",
                DEVCONTAINER: "readonly",
                FRONTEND_VERSION: "readonly",
                GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "readonly",
            },
        },
        plugins: {
            "@typescript-eslint": tseslint,
            jsdoc,
            vue,
        },
        rules: projectRules,
    },
    {
        files: [ "**/*.ts" ],
        languageOptions: {
            parser: tsParser,
        },
    },
    {
        files: [ "**/*.vue" ],
        languageOptions: {
            parser: vueParser,
            parserOptions: {
                parser: tsParser,
                ecmaVersion: "latest",
                sourceType: "module",
            },
        },
    },
    {
        files: [ "backend/log.ts" ],
        rules: {
            camelcase: "off",
        },
    },
];
