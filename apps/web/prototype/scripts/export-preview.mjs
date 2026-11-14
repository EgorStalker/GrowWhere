import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=`<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Запуск GrowWhere</title><style>body{font:20px/1.7 Segoe UI,Arial,sans-serif;background:#f6f7f1;color:#152b22;max-width:720px;margin:60px auto;padding:24px}a{display:inline-block;background:#27d39b;color:#102b20;padding:15px 24px;border-radius:8px;font-weight:700}code{background:#e1ebdd;padding:4px 9px}h1{font-size:42px;line-height:1.2}</style><h1>GrowWhere<br>Реальна карта та дані</h1><p>Ця версія отримує дані NASA й USDA через локальний сервер. Запустіть файл <strong>Start-GrowWhere.cmd</strong> у цій папці, а потім відкрийте сайт.</p><p><a href="http://127.0.0.1:4173">Відкрити GrowWhere →</a></p><p>Для розробки: <code>npm start</code>. Залишайте вікно сервера відкритим під час роботи. Ця сторінка запуску не містить синтетичних оцінок і не замінює сервер.</p></html>`;
await writeFile(path.join(root,'growwhere-preview.html'),html,'utf8');
console.log('Created local launch guide. Live analysis requires the server.');
