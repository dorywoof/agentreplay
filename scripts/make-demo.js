// Generates examples/demo-session.jsonl — a small, fictional Claude Code session
// used for the README demo and the tests. Run: node scripts/make-demo.js
import fs from 'node:fs';

const sessionId = 'demo-7f3c2a10-0000-4000-8000-000000000000';
const start = Date.parse('2026-11-12T14:02:00Z');
let t = start;
let n = 0;
const lines = [];
const base = { sessionId, cwd: '/home/dev/todo-app', gitBranch: 'feat/dark-mode', version: '2.1.300', isSidechain: false };
const usage = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

const at = (sec) => new Date((t += sec * 1000)).toISOString();
function user(text, sec = 2) {
  lines.push({ ...base, type: 'user', uuid: `u${n++}`, timestamp: at(sec), message: { role: 'user', content: text } });
}
function assistant(blocks, u, sec = 3) {
  const id = `msg_${n++}`;
  for (const b of blocks) {
    lines.push({ ...base, type: 'assistant', uuid: `a${n++}`, timestamp: at(sec), message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [b], usage: u } });
    sec = 0.4;
  }
}
let tid = 0;
function tool(name, input, output, { sec = 2, run = 1.5, error = false, u = usage(4, 180, 24000, 1200) } = {}) {
  const id = `toolu_${tid++}`;
  assistant([{ type: 'tool_use', id, name, input }], u, sec);
  lines.push({ ...base, type: 'user', uuid: `r${n++}`, timestamp: at(run), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: error }] } });
}

lines.push({ type: 'ai-title', aiTitle: 'Add a dark mode toggle to the todo app', sessionId });

user('Add a dark mode toggle to the header. It should remember the choice and respect the OS setting by default.');
assistant([{ type: 'text', text: "I'll look at how the header and styles are set up first." }], usage(3, 40, 0, 18000), 4);
tool('Glob', { pattern: 'src/**/*.{tsx,css}' }, 'src/App.tsx\nsrc/components/Header.tsx\nsrc/components/TodoList.tsx\nsrc/index.css\nsrc/main.tsx');
tool('Read', { file_path: '/home/dev/todo-app/src/components/Header.tsx' }, `export function Header() {\n  return (\n    <header className="header">\n      <h1>Todos</h1>\n    </header>\n  );\n}`);
tool('Read', { file_path: '/home/dev/todo-app/src/index.css' }, `body {\n  background: #fff;\n  color: #111;\n}\n.header { display: flex; align-items: center; }`);
assistant([{ type: 'text', text: 'Colors are hard-coded in `index.css`. Plan:\n\n1. Move colors into CSS variables with a `[data-theme="dark"]` override\n2. Add a `useTheme` hook that reads `localStorage` and falls back to `prefers-color-scheme`\n3. Put a toggle button in `Header`' }], usage(4, 220, 26000, 900), 5);

tool('Edit', {
  file_path: '/home/dev/todo-app/src/index.css',
  old_string: 'body {\n  background: #fff;\n  color: #111;\n}',
  new_string: ':root {\n  --bg: #ffffff;\n  --fg: #111111;\n}\n:root[data-theme="dark"] {\n  --bg: #16161a;\n  --fg: #ececf1;\n}\nbody {\n  background: var(--bg);\n  color: var(--fg);\n  transition: background .2s, color .2s;\n}',
}, 'The file src/index.css has been updated.', { sec: 6 });

tool('Write', {
  file_path: '/home/dev/todo-app/src/hooks/useTheme.ts',
  content: `import { useEffect, useState } from 'react';\n\ntype Theme = 'light' | 'dark';\n\nfunction initial(): Theme {\n  const saved = localStorage.getItem('theme');\n  if (saved === 'light' || saved === 'dark') return saved;\n  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';\n}\n\nexport function useTheme() {\n  const [theme, setTheme] = useState<Theme>(initial);\n  useEffect(() => {\n    document.documentElement.dataset.theme = theme;\n    localStorage.setItem('theme', theme);\n  }, [theme]);\n  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));\n  return { theme, toggle };\n}`,
}, 'File created successfully at: src/hooks/useTheme.ts', { sec: 8 });

tool('Edit', {
  file_path: '/home/dev/todo-app/src/components/Header.tsx',
  old_string: 'export function Header() {\n  return (\n    <header className="header">\n      <h1>Todos</h1>\n    </header>',
  new_string: "import { useTheme } from '../hooks/useTheme';\n\nexport function Header() {\n  const { theme, toggle } = useTheme();\n  return (\n    <header className=\"header\">\n      <h1>Todos</h1>\n      <button onClick={toggle} aria-label=\"Toggle dark mode\">\n        {theme === 'dark' ? '☀️' : '🌙'}\n      </button>\n    </header>",
}, 'The file src/components/Header.tsx has been updated.', { sec: 5 });

assistant([{ type: 'text', text: 'Now let me run the tests.' }], usage(3, 20, 31000, 600), 2);
tool('Bash', { command: 'npm test -- --run', description: 'Run the test suite' },
  'FAIL src/components/Header.test.tsx\n  ✕ renders the title (12 ms)\n    ReferenceError: matchMedia is not defined\n      at initial (src/hooks/useTheme.ts:8:10)\n\nTests: 1 failed, 6 passed, 7 total',
  { sec: 2, run: 9, error: true });
assistant([{ type: 'thinking', thinking: 'jsdom does not implement matchMedia. Guard it in the hook so it also works during SSR, rather than only mocking it in tests.' }], usage(3, 90, 32000, 400), 3);
tool('Edit', {
  file_path: '/home/dev/todo-app/src/hooks/useTheme.ts',
  old_string: "  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';",
  new_string: "  const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;\n  return prefersDark ? 'dark' : 'light';",
}, 'The file src/hooks/useTheme.ts has been updated.', { sec: 4 });
tool('Write', {
  file_path: '/home/dev/todo-app/src/hooks/useTheme.test.ts',
  content: "import { renderHook, act } from '@testing-library/react';\nimport { useTheme } from './useTheme';\n\ntest('toggles and persists the theme', () => {\n  const { result } = renderHook(() => useTheme());\n  act(() => result.current.toggle());\n  expect(document.documentElement.dataset.theme).toBe('dark');\n  expect(localStorage.getItem('theme')).toBe('dark');\n});",
}, 'File created successfully at: src/hooks/useTheme.test.ts', { sec: 6 });
tool('Bash', { command: 'npm test -- --run', description: 'Run the test suite again' }, '✓ src/hooks/useTheme.test.ts (1)\n✓ src/components/Header.test.tsx (3)\n✓ src/components/TodoList.test.tsx (4)\n\nTests: 8 passed, 8 total', { sec: 2, run: 8 });
assistant([{ type: 'text', text: 'Done. The header now has a 🌙/☀️ toggle:\n\n- Colors live in CSS variables, with a `[data-theme="dark"]` override\n- `useTheme` remembers the choice in `localStorage` and defaults to the OS setting\n- Guarded `matchMedia` so it works in tests and SSR, and added a test for the hook\n\nAll 8 tests pass.' }], usage(3, 160, 34000, 300), 3);

fs.writeFileSync(new URL('../examples/demo-session.jsonl', import.meta.url), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`wrote ${lines.length} records`);
