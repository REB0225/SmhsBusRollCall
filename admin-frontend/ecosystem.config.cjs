module.exports = {
  apps: [{
    name: "bus-rollcall-admin",
    script: "npx",
    args: "serve -s dist -l 5174",
    env: {
      NODE_ENV: "production",
    }
  }]
}
