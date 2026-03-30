module.exports = {
  apps: [{
    name: "bus-rollcall-backend",
    script: "server.ts",
    interpreter: "./node_modules/.bin/tsx",
    env: {
      NODE_ENV: "production",
      PHOTOS_PATH: "/mnt/samba-photos" // Update this to your actual mount point
    }
  }]
}
