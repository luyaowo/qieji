const fs = require('node:fs');
const path = require('node:path');
const Babel = require('../Frontend/vendor/babel.min.js');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'Frontend');
const outputRoot = path.join(projectRoot, 'Sources/PaperEdgeApp/Resources');
const checkOnly = process.argv.includes('--check');

const files = [
  { source: 'styles/styles.css', output: 'styles/styles.css', compile: false },
  { source: 'scripts/utils/dateGroups.js', output: 'scripts/utils/dateGroups.js', compile: false },
  { source: 'scripts/utils/reminderTime.js', output: 'scripts/utils/reminderTime.js', compile: false },
  { source: 'scripts/services/taskStorage.js', output: 'scripts/services/taskStorage.js', compile: false },
  { source: 'scripts/components/TaskEditor.jsx', output: 'scripts/components/TaskEditor.js', compile: true },
  { source: 'scripts/components/TaskItem.jsx', output: 'scripts/components/TaskItem.js', compile: true },
  { source: 'scripts/App.jsx', output: 'scripts/App.js', compile: true }
];

let changed = 0;

for (const file of files) {
  const sourcePath = path.join(sourceRoot, file.source);
  const outputPath = path.join(outputRoot, file.output);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = file.compile
    ? Babel.transform(source, {
        filename: file.source,
        presets: [
          ['env', { targets: { safari: '17' }, modules: false }],
          'react'
        ],
        sourceType: 'script',
        compact: false,
        comments: true
      }).code + '\n'
    : source;

  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
  if (current === output) continue;
  changed += 1;

  if (!checkOnly) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output);
  }
  console.log(`${checkOnly ? 'OUTDATED' : 'BUILT'} ${file.output}`);
}

if (checkOnly && changed > 0) {
  console.error(`前端生成文件有 ${changed} 项未同步，请运行 node Scripts/build-frontend.cjs`);
  process.exit(1);
}

if (changed === 0) console.log('前端生成文件已同步');
