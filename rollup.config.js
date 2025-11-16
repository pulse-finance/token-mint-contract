import typescript from "@rollup/plugin-typescript"

export default {
    input: ["src/index.ts"],
    output: {
        dir: "dist",
        format: "esm",
        sourcemap: false,
        preserveModules: true,
        preserveModulesRoot: "src"
    },
    plugins: [
        typescript({
            tsconfig: "./tsconfig.json",
            declaration: false,
            noEmitOnError: true,
            noCheck: true
        })
    ],
    external: [/^[^./]/] // treat bare imports as external
}
