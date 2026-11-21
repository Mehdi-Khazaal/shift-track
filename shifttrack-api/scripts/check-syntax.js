const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// The API, plus the frontend assets — assets/js had no syntax gate at all,
// which is how encoding artifacts and a stale helper reference survived there.
const roots = [
  path.resolve(__dirname, '..'),
  path.resolve(__dirname, '..', '..', 'assets', 'js'),
];
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed for ${file}\n`);
    process.exit(result.status || 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
