import eslintBase from "../../build-config/eslint.packages.mjs";

const packageTsFiles = ["{src,test}/**/*.ts"];

export default [
  { ignores: ["dist/**/*"] },
  ...eslintBase.map((config) => ({
    ...config,
    files: packageTsFiles,
  })),
];
