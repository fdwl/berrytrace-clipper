const fs = require('fs');
const path = require('path');

const customConfigPath = path.resolve(__dirname, '../custom/config.json');
const customConfig = fs.existsSync(customConfigPath) ? require(customConfigPath) : null;

if (!customConfig || !customConfig.codeReplace) {
    console.log('No codeReplace config found, skipping source patching');
    process.exit(0);
}

function replaceInFile(filePath, replacements) {
    if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${filePath}, skipping`);
        return;
    }

    let content = fs.readFileSync(filePath, 'utf-8');
    let modified = false;

    for (const [from, to] of Object.entries(replacements)) {
        if (content.includes(from)) {
            content = content.split(from).join(to);
            modified = true;
            console.log(`  Patched: ${from} -> ${to} in ${path.basename(filePath)}`);
        }
    }

    if (modified) {
        fs.writeFileSync(filePath, content, 'utf-8');
    }
}

const filesToPatch = [
    'src/utils/obsidian-note-creator.ts',
    'src/utils/cli-utils.ts',
    'src/utils/interpreter.ts',
    'src/background.ts'
];

console.log('\n=== Patching source files for custom branding ===');
for (const file of filesToPatch) {
    const fullPath = path.resolve(__dirname, '..', file);
    replaceInFile(fullPath, customConfig.codeReplace);
}
console.log('=== Source patching complete ===\n');
