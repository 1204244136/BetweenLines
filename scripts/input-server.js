const implementation = require("../src/runtime/input-server");

if (require.main === module) implementation.startServer();

module.exports = implementation;
