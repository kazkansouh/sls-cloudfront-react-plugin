module.exports = {
  env: {
    commonjs: true,
    es2021: true,
    node: true,
  },
  extends: ['plugin:prettier/recommended', 'eslint:recommended', 'prettier'],
  parserOptions: {
    ecmaVersion: 12,
  },
  rules: {},
  plugins: ['prettier'],
};
