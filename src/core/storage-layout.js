const path = require("path");

const rootDir = path.join(__dirname, "..", "..");

function resolveDataDir(value = process.env.TRANSCOMPARATOR_DATA_DIR) {
  return path.resolve(value || path.join(rootDir, "out"));
}

function storageLayout(dataDir = resolveDataDir()) {
  const root = path.resolve(dataDir);
  const runtimeDir = path.join(root, "runtime");
  return {
    root,
    runtimeDir,
    runtimeSelectionFile: path.join(runtimeDir, "input-selection.json"),
    // 各导入入口各自的默认目录（系统选择窗口的起始位置），与选择本身解耦。
    pickerPathsFile: path.join(runtimeDir, "picker-paths.json"),
    importedInputsDir: path.join(runtimeDir, "imported-inputs"),
    workDir: path.join(runtimeDir, "work"),
    projectsDir: path.join(root, "projects"),
    stagingDir: path.join(root, ".staging"),
    activeProjectFile: path.join(root, "active-project.json"),
  };
}

function resolveBuildOutputDir() {
  return path.resolve(process.env.TRANSCOMPARATOR_OUTPUT_DIR || storageLayout().workDir);
}

function resolveSelectionFile() {
  return path.resolve(process.env.TRANSCOMPARATOR_SELECTION_FILE || storageLayout().runtimeSelectionFile);
}

module.exports = {
  resolveBuildOutputDir,
  resolveDataDir,
  resolveSelectionFile,
  rootDir,
  storageLayout,
};
