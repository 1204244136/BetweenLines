const implementation = require("../src/workbenches/translation-compare/build-compare");

if (require.main === module) {
  implementation.main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = implementation;
