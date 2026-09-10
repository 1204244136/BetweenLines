const implementation = require("../src/workbenches/speaker-attribution/build-workbench");

if (require.main === module) implementation.main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

module.exports = implementation;
