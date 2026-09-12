// Print a JS file without its comments, changing nothing else. Uses the
// TypeScript parser + printer so strings, template literals and regex
// literals containing "//" or "/*" are never mistaken for comments.
// Usage: node tools/strip_comments.js file.js   (needs `typescript` on NODE_PATH)
const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const sf = ts.createSourceFile('x.js', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
process.stdout.write(printer.printFile(sf));
