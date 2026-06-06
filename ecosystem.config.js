module.exports = {
  apps: [{
    name: 'stremio-addon',
    script: 'server.js',
    env: {
      PORT: 7000,
      TMDB_API_KEY: 'f84ba62d92a0fccacfb91978bbf13177'
    }
  }]
};
