module.exports = {
  apps: [
    { name: "YMTest_V1", script: "bash", args: "-c 'yarn bot:dev'", env: { FORCE_COLOR: "1" }, watch: false, },
    { name: "YM_V1", script: "bash", args: "-c 'yarn bot:start'", env: { FORCE_COLOR: "1" }, watch: false, },
    { name: "YMm_V1", script: "bash", args: "-c 'yarn bot:start:m'", env: { FORCE_COLOR: "1" }, watch: false, },
    { name: "YM_Sidecar", script: "sidecar/sidecar.mjs", args: "watch", env: { FORCE_COLOR: "1" }, watch: false, },
  ]
}
