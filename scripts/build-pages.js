// Renders the demo replay to docs/index.html (GitHub Pages) and adds the
// Digivated badge there only — never in replays users generate.
// Run: node scripts/build-pages.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const out = new URL('../docs/index.html', import.meta.url);
execFileSync(process.execPath, ['bin/agentreplay.js', 'examples/demo-session.jsonl', '-o', 'docs/index.html', '--no-open'], { stdio: 'inherit' });

const BADGE = `<div style="text-align:center;margin:8px 0 120px">
<a href="https://digivated.com/projects/listing/d5a6d3ac-0bba-4dc5-bf5b-610334ad358f" data-digivated-project="d5a6d3ac-0bba-4dc5-bf5b-610334ad358f" target="_blank" rel="noopener">
  <img src="https://digivated.com/badge/d5a6d3ac-0bba-4dc5-bf5b-610334ad358f?theme=dark" alt="Featured on Digivated" width="250" height="54">
</a>
</div>
`;
let html = fs.readFileSync(out, 'utf8');
const anchor = '<div class="player">';
if (!html.includes(anchor)) throw new Error('player anchor not found');
html = html.replace(anchor, () => BADGE + anchor);
fs.writeFileSync(out, html);
console.log('badge added to docs/index.html');
