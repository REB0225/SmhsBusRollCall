module.exports = {
  apps: [{
    name: "bus-rollcall-backend",
    script: "server.ts",
    interpreter: "./node_modules/.bin/tsx",
    env: {
      NODE_ENV: "production",
    }
  }]
}
